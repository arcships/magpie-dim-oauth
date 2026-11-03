import { randomUUID } from "node:crypto"
import type { Auth, Window } from "./contracts"
import { usage } from "./catalog"
import { identityHeaders, json, number, record, request, text } from "./http"

export type ResetKind = "window" | "monthly_full"
interface ResetCount { available: number; expiresAt?: string }
export interface AccountView {
  user: string
  issuer: string
  subscriptionUrl: string
  pricingUrl: string
  plan?: { name?: string; status?: string; end?: string; amount?: number; currency?: string; interval?: string; cancelAtPeriodEnd?: boolean }
  subscriptionId?: number
  windows: Window[]
  resets: Record<ResetKind, ResetCount>
}

function date(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid Dim account date")
  return value
}

function count(value: unknown): number {
  const n = number(value, "reset count")
  if (!Number.isSafeInteger(n)) throw new Error("Invalid Dim reset count")
  return n
}

function resets(value: unknown): Record<ResetKind, ResetCount> {
  const raw = record(value, "reset summary")
  const parse = (kind: ResetKind): ResetCount => {
    const item = record(raw[kind], "reset summary kind")
    return { available: count(item.available_count), expiresAt: date(item.nearest_expires_at) }
  }
  return { window: parse("window"), monthly_full: parse("monthly_full") }
}

export function accountView(payload: Record<string, unknown>, auth: Auth): AccountView {
  const data = record(payload.data, "account usage")
  const root = data.subscription == null ? undefined : record(data.subscription, "subscription")
  const product = root?.product == null ? undefined : record(root.product, "subscription product")
  const subscription = root?.subscription == null ? undefined : record(root.subscription, "subscription details")
  const term = root?.current_term == null ? undefined : record(root.current_term, "subscription term")
  const price = root?.price == null ? undefined : record(root.price, "subscription price")
  const plan = root ? {
    name: product?.name === undefined ? undefined : text(product.name, "product name"),
    status: subscription?.status === undefined ? undefined : text(subscription.status, "subscription status"),
    end: date(term?.end_at),
    amount: price?.amount === undefined ? undefined : number(price.amount, "plan price"),
    currency: price?.currency === undefined ? undefined : text(price.currency, "price currency"),
    interval: price?.billing_interval === undefined ? undefined : text(price.billing_interval, "billing interval"),
    ...(typeof subscription?.cancel_at_period_end === "boolean" ? { cancelAtPeriodEnd: subscription.cancel_at_period_end } : {}),
  } : undefined
  const subscriptionId = subscription?.id === undefined ? undefined : count(subscription.id)
  return {
    ...usage(payload, auth.accountId), issuer: auth.issuer,
    subscriptionUrl: `${auth.issuer}/console/subscription`, pricingUrl: `${auth.issuer}/console/pricing`,
    plan, ...(subscriptionId && subscriptionId > 0 ? { subscriptionId } : {}), resets: resets(data.resets),
  }
}

export async function fetchAccount(auth: Auth): Promise<AccountView> {
  return accountView(await json(await request(`${auth.issuer}/api/me/usage`, {
    headers: identityHeaders(auth.access),
  }), "Dim usage"), auth)
}

export interface ResetBatch { count: number; expiresAt: string; source: string }
export async function resetBatches(auth: Auth, subscriptionId: number, kind: ResetKind): Promise<ResetBatch[]> {
  const envelope = await json(await request(`${auth.issuer}/api/me/usage-resets`, {
    headers: identityHeaders(auth.access),
  }), "Dim reset details")
  const raw = record(record(envelope.data, "reset batches")[kind], "reset kind batches")
  if (!Array.isArray(raw.batches)) throw new Error("Invalid Dim reset batches")
  return raw.batches.flatMap((item) => {
    const row = record(item, "reset batch")
    const scope = row.scope_type
    if (scope !== "account" && scope !== "subscription") throw new Error("Invalid Dim reset scope")
    const subscription = scope === "subscription" ? count(row.subscription_id) : undefined
    const expiresAt = date(row.expires_at)
    if (!expiresAt) throw new Error("Invalid Dim reset batch expiry")
    const remaining = count(row.remaining)
    if ((scope === "account" && kind !== "window") || (scope === "subscription" && subscription !== subscriptionId) ||
        !remaining || Date.parse(expiresAt) <= Date.now()) return []
    return [{ count: remaining, expiresAt, source: text(row.source_type, "reset source") }]
  })
}

export interface ResetConfirmation {
  id: string
  kind: ResetKind
  account: string
  subscriptionId: number
  view: AccountView
  available: number
  batches?: ResetBatch[]
  detailsUnavailable: boolean
  expires: number
  idempotencyKey: string
}

export async function prepareReset(auth: Auth, kind: ResetKind): Promise<ResetConfirmation> {
  const view = await fetchAccount(auth)
  if (!view.subscriptionId) throw new Error("No subscription is available to reset")
  if (!view.resets[kind].available) throw new Error("No reset credits are available")
  let batches: ResetBatch[] | undefined
  try { batches = await resetBatches(auth, view.subscriptionId, kind) } catch { /* Details are optional; the apply API remains authoritative. */ }
  if (batches && !batches.length) throw new Error("No reset credits apply to this subscription")
  return {
    id: randomUUID(), kind, account: auth.uid, subscriptionId: view.subscriptionId, view,
    available: view.resets[kind].available, batches, detailsUnavailable: batches === undefined,
    expires: Date.now() + 5 * 60_000, idempotencyKey: randomUUID(),
  }
}

export async function applyReset(auth: Auth, confirmation: ResetConfirmation) {
  if (auth.uid !== confirmation.account || auth.issuer !== confirmation.view.issuer) throw new Error("Dim account changed; confirm again")
  const headers = identityHeaders(auth.access)
  headers.set("Content-Type", "application/json")
  const envelope = await json(await request(`${auth.issuer}/api/me/usage-resets/apply`, {
    method: "POST", headers,
    body: JSON.stringify({ subscription_id: confirmation.subscriptionId, reset_type: confirmation.kind, idempotency_key: confirmation.idempotencyKey }),
  }), "Dim quota reset")
  const raw = record(envelope.data, "reset result")
  if (typeof raw.replayed !== "boolean" || !date(raw.applied_at)) throw new Error("Invalid Dim reset result")
  const updated = usage({ data: { credits: { subscription_bucket: { ...record(raw.bucket, "reset bucket"), window_states: raw.window_states } } } }, auth.accountId)
  // Apply returns a fresh subscription, not an account-wide credit aggregate.
  // Preserve independent feature allowances; do not invent an updated aggregate.
  const windows = [...updated.windows, ...confirmation.view.windows.filter((window) => window.source === "feature")]
  return { replayed: raw.replayed, view: { ...confirmation.view, windows, resets: resets(raw.resets) } }
}
