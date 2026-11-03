import { randomBytes, createHash } from "node:crypto"
import type { Auth, OAuthOptions } from "./contracts"
import { endpoint, identityHeaders, json, number, record, request, text, trustedUrl } from "./http"

export function readAuth(value: unknown): Auth {
  const raw = record(value, "saved Dim sign-in")
  if (raw.type !== "oauth") throw new Error("Sign in with Dim first")
  const issuer = trustedUrl(raw.issuer, "saved issuer").href.replace(/\/$/, "")
  return {
    type: "oauth",
    access: text(raw.access, "saved access token"),
    refresh: text(raw.refresh, "saved refresh token"),
    expires: number(raw.expires, "saved expiry"),
    issuer,
    tokenEndpoint: endpoint(raw.tokenEndpoint, issuer, "saved token endpoint"),
    clientId: text(raw.clientId, "saved client ID"),
    accountId: text(raw.accountId, "saved account ID"),
    uid: text(raw.uid, "saved subject"),
  }
}

async function exchange(tokenEndpoint: string, fields: Record<string, string>, previousRefresh?: string, signal?: AbortSignal) {
  const response = await request(tokenEndpoint, {
    method: "POST", headers: identityHeaders(), body: new URLSearchParams(fields), signal,
  })
  if (!response.ok) {
    let error: unknown
    try { error = record(await response.json(), "OAuth error").error } catch { /* Ignore untrusted error bodies. */ }
    const expired = error === "invalid_grant" || error === "invalid_token" || response.status === 401
    throw Object.assign(new Error(`Dim token exchange failed (HTTP ${response.status})`), expired ? { signIn: "expired" } : {})
  }
  const raw = await json(response, "Dim token response")
  if (typeof raw.token_type !== "string" || raw.token_type.toLowerCase() !== "bearer") {
    throw new Error("Dim must issue a Bearer token")
  }
  const lifetime = number(raw.expires_in, "token lifetime")
  if (lifetime === 0) throw new Error("Dim issued an expired token")
  return {
    access: text(raw.access_token, "access token"),
    refresh: raw.refresh_token === undefined && previousRefresh ? previousRefresh : text(raw.refresh_token, "refresh token"),
    expires: Date.now() + lifetime * 1000,
  }
}

export async function refresh(value: unknown) {
  const auth = readAuth(value)
  return exchange(auth.tokenEndpoint, {
    grant_type: "refresh_token", refresh_token: auth.refresh, client_id: auth.clientId,
  }, auth.refresh)
}

export async function authorize(options: OAuthOptions, signal?: AbortSignal) {
  const issuer = trustedUrl(options.issuer, "issuer").href.replace(/\/$/, "")
  const clientId = text(options.clientId, "client ID")
  const scope = text(options.scope, "scope")
  const redirect = trustedUrl(options.redirectUri, "redirect URI")
  if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || !redirect.port) {
    throw new Error("Dim redirect URI must be http://127.0.0.1:<port>/<callback-path>")
  }
  const metadata = await json(await request(`${issuer}/.well-known/openid-configuration`, { signal }), "Dim discovery")
  if (text(metadata.issuer, "discovery issuer").replace(/\/$/, "") !== issuer) {
    throw new Error("Dim discovery issuer does not match the configured issuer")
  }
  const authorizationEndpoint = endpoint(metadata.authorization_endpoint, issuer, "authorization endpoint")
  const tokenEndpoint = endpoint(metadata.token_endpoint, issuer, "token endpoint")
  const userinfoEndpoint = endpoint(metadata.userinfo_endpoint, issuer, "userinfo endpoint")
  const verifier = randomBytes(32).toString("base64url")
  const state = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  type Outcome = { code: string } | { error: string }
  let complete!: (outcome: Outcome) => void
  const completed = new Promise<Outcome>((resolve) => { complete = resolve })
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (outcome: Outcome) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener("abort", aborted)
    void server.stop()
    complete(outcome)
  }
  const aborted = () => finish({ error: "Dim sign-in cancelled" })
  const server = Bun.serve({
    hostname: "127.0.0.1", port: Number(redirect.port),
    fetch(req) {
      const url = new URL(req.url)
      const plain = (message: string, status: number) => new Response(message, {
        status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      })
      if (url.pathname !== redirect.pathname) return plain("Not found", 404)
      if (req.method !== "GET") return plain("Method not allowed", 405)
      if (settled || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state) {
        return plain("Invalid sign-in state", 400)
      }
      const codes = url.searchParams.getAll("code")
      if (url.searchParams.has("error")) {
        setTimeout(() => finish({ error: "Dim authorization was refused" }), 0)
        return plain("Authorization refused. Return to Magpie.", 400)
      }
      if (codes.length !== 1 || !codes[0]?.trim()) return plain("Missing authorization code", 400)
      setTimeout(() => finish({ code: codes[0]! }), 0)
      return plain("Authorization received. Return to Magpie.", 200)
    },
  })
  redirect.port = String(server.port)
  const redirectUri = redirect.href
  const url = new URL(authorizationEndpoint)
  url.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    scope, state, code_challenge: challenge, code_challenge_method: "S256",
  }).toString()
  timer = setTimeout(() => finish({ error: "Dim sign-in timed out" }), 5 * 60_000)
  signal?.addEventListener("abort", aborted, { once: true })
  if (signal?.aborted) aborted()
  let consumed = false
  return {
    url: url.href,
    instructions: "Complete authorization in your browser, then return to Magpie.",
    method: "auto" as const,
    async callback(_code?: string, context?: { signal?: AbortSignal }) {
      if (consumed) return { type: "failed" as const, error: "Dim sign-in was already completed" }
      consumed = true
      const callbackSignal = context?.signal
      callbackSignal?.addEventListener("abort", aborted, { once: true })
      if (callbackSignal?.aborted) aborted()
      try {
        const outcome = await completed
        if ("error" in outcome) return { type: "failed" as const, error: outcome.error }
        const signals = [signal, callbackSignal].filter((s): s is AbortSignal => s !== undefined)
        const networkSignal = signals.length ? AbortSignal.any(signals) : undefined
        const tokens = await exchange(tokenEndpoint, {
          grant_type: "authorization_code", code: outcome.code, client_id: clientId,
          redirect_uri: redirectUri, code_verifier: verifier,
        }, undefined, networkSignal)
        const user = await json(await request(userinfoEndpoint, {
          headers: identityHeaders(tokens.access), signal: networkSignal,
        }), "Dim userinfo")
        const subject = text(user.sub, "user subject")
        const userId = user.uid === undefined ? subject : text(user.uid, "user ID")
        // Subjects are unique within an issuer, not across both Dim sites.
        const uid = JSON.stringify([issuer, userId])
        const accountId = typeof user.email === "string" && user.email.trim() ? user.email.trim() : userId
        return { type: "success" as const, ...tokens, issuer, tokenEndpoint, clientId, accountId, uid }
      } catch (error) {
        // Only messages produced in this module or the HTTP boundary are exposed.
        return { type: "failed" as const, error: error instanceof Error ? error.message : "Dim sign-in failed" }
      } finally {
        callbackSignal?.removeEventListener("abort", aborted)
      }
    },
  }
}
