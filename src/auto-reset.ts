import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { applyReset, fetchAccount, resetBatches, type AccountView } from "./account"
import type { Auth, GetAuth } from "./contracts"
import { readAuth } from "./oauth"

export const AUTO_RESET_INTERVAL = 60_000

interface State {
  enabled: number
  window: string | null
  request_key: string | null
  retry_at: number
  finished: number
  last_applied: string | null
}

function accountKey(auth: Auth) {
  return createHash("sha256").update(JSON.stringify([auth.issuer, auth.clientId, auth.uid])).digest("hex")
}

function exhaustedWindows(view: AccountView, now: number) {
  if (!view.subscriptionId || view.plan?.status !== "active" || !view.resets.window.available ||
      (view.plan.end && Date.parse(view.plan.end) <= now) ||
      view.windows.some((window) => window.source === "subscription" && window.name === "Subscription" && (window.used ?? 0) >= 100)) return []

  return view.windows.flatMap((window) => {
    const expiry = Date.parse(window.resetsAt ?? "")
    if (window.source !== "subscription" || !window.span || !(expiry > now) || (window.used ?? 0) < 100) return []
    return [`${view.subscriptionId}:${window.span}:${expiry}`]
  }).sort()
}

export class AutoReset {
  private db?: Database

  constructor(private readonly file = ":memory:", private readonly now = Date.now) {}

  close() {
    this.db?.close()
    this.db = undefined
  }

  private database(create = false) {
    if (this.db) return this.db
    if (!create && !existsSync(this.file)) return
    const db = new Database(this.file, { create })
    try {
      db.run("PRAGMA busy_timeout = 1000")
      db.run(`CREATE TABLE IF NOT EXISTS auto_reset (
        account TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
        window TEXT, request_key TEXT, retry_at INTEGER NOT NULL DEFAULT 0,
        finished INTEGER NOT NULL DEFAULT 0, last_applied TEXT
      )`)
      this.db = db
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  private state(db: Database, account: string) {
    return db.query<State, [string]>("SELECT * FROM auto_reset WHERE account = ?").get(account)
  }

  status(auth: Auth) {
    const db = this.database()
    const row = db && this.state(db, accountKey(auth))
    return { enabled: row?.enabled === 1, lastApplied: row?.last_applied ?? null }
  }

  setEnabled(auth: Auth, enabled: boolean) {
    const db = this.database(true)!
    db.run(`INSERT INTO auto_reset (account, enabled) VALUES (?, ?)
      ON CONFLICT(account) DO UPDATE SET enabled = excluded.enabled`, [accountKey(auth), Number(enabled)])
    return this.status(auth)
  }

  anyEnabled() {
    return !!this.database()?.query("SELECT 1 FROM auto_reset WHERE enabled = 1 LIMIT 1").get()
  }

  async check(auth: Auth, view: AccountView, getAuth: GetAuth, signal?: AbortSignal) {
    const db = this.database()
    if (!db || signal?.aborted) return view
    const account = accountKey(auth)
    const now = this.now()
    const windows = exhaustedWindows(view, now)
    if (!windows.length || !this.state(db, account)?.enabled) return view

    // The CLI and gateway can read usage concurrently. Commit the intent before
    // any network work and reuse its key if the same window needs a retry.
    const intent = db.transaction(() => {
      const row = this.state(db, account)
      if (!row?.enabled || row.retry_at > now) return
      const same = row.window !== null && row.request_key !== null && windows.includes(row.window)
      if (same && row.finished) return
      const window = same ? row.window! : windows[0]!
      const key = same ? row.request_key! : randomUUID()
      db.run("UPDATE auto_reset SET window = ?, request_key = ?, retry_at = ?, finished = 0 WHERE account = ?",
        [window, key, now + AUTO_RESET_INTERVAL, account])
      return { window, key }
    }).immediate()
    if (!intent) return view

    const current = readAuth(await getAuth())
    if (accountKey(current) !== account || current.expires <= this.now()) return view
    const fresh = await fetchAccount(current, signal)
    if (!fresh.subscriptionId || !exhaustedWindows(fresh, this.now()).includes(intent.window)) return fresh
    const batches = await resetBatches(current, fresh.subscriptionId, "window", signal)
    const latest = readAuth(await getAuth())
    const applyAt = this.now()
    if (accountKey(latest) !== account || latest.expires <= applyAt || signal?.aborted || !this.state(db, account)?.enabled ||
        !exhaustedWindows(fresh, applyAt).includes(intent.window) || !batches.some((batch) => Date.parse(batch.expiresAt) > applyAt)) return fresh

    const result = await applyReset(latest, {
      kind: "window", account: latest.uid, subscriptionId: fresh.subscriptionId, view: fresh, idempotencyKey: intent.key,
    }, signal)
    db.run("UPDATE auto_reset SET finished = 1, last_applied = ? WHERE account = ? AND request_key = ?",
      [result.appliedAt, account, intent.key])
    return result.replayed ? fresh : result.view
  }
}
