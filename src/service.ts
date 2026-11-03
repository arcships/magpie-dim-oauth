import { AsyncResource } from "node:async_hooks"
import { randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import type { Auth, GetAuth } from "./contracts"
import { applyReset, fetchAccount, prepareReset, type ResetConfirmation, type ResetKind } from "./account"
import { readAuth } from "./oauth"
import { record, request, text } from "./http"

interface AccountAccess {
  label: string
  active: () => Promise<boolean>
  run: <T>(action: (auth: Auth) => Promise<T>) => Promise<T>
}

export class AccountService {
  private accounts = new Map<string, AccountAccess>()
  private identities = new Map<string, string>()
  private confirmations = new Map<string, { account: string; value: ResetConfirmation; result?: Promise<unknown> }>()
  private secret = randomBytes(32).toString("base64url")
  private server?: ReturnType<typeof Bun.serve>
  private refreshing?: Promise<void>

  constructor(private gatewayAddress = process.env.MAGPIE_ADDR) {}

  private refreshHost() {
    if (this.refreshing) return this.refreshing
    const task = (async () => {
      if (!this.gatewayAddress) throw new Error("Refresh Dim usage in Magpie to renew or load this sign-in")
      const gateway = new URL(`http://${this.gatewayAddress}`)
      if (!["127.0.0.1", "localhost", "[::1]"].includes(gateway.hostname) || gateway.username || gateway.password || gateway.pathname !== "/" || gateway.search || gateway.hash) {
        throw new Error("Dim account page requires a loopback Magpie gateway address")
      }
      // This native refresh calls auth.usage in the correct account scope and
      // renews tokens under Magpie's cross-process lock before invoking it.
      const url = new URL("/v1/magpie/quotas/refresh?provider=dim-oauth", gateway)
      const response = await request(url, { method: "POST" })
      await response.body?.cancel()
      if (!response.ok) throw new Error("Magpie could not refresh the Dim sign-in")
    })()
    this.refreshing = task
    void task.finally(() => { if (this.refreshing === task) this.refreshing = undefined }).catch(() => {})
    return task
  }

  async register(getAuth: GetAuth) {
    const initial = readAuth(await getAuth())
    const identity = JSON.stringify([initial.issuer, initial.clientId, initial.uid])
    const id = this.identities.get(identity) ?? randomUUID()
    this.identities.set(identity, id)
    // The host's account/proxy scope must survive callbacks from the page server.
    const run = AsyncResource.bind(async <T>(action: (auth: Auth) => Promise<T>): Promise<T> => {
      let auth = readAuth(await getAuth())
      if (auth.uid !== initial.uid || auth.issuer !== initial.issuer || auth.clientId !== initial.clientId) throw new Error("Dim account changed")
      if (auth.expires <= Date.now() + 30_000) {
        await this.refreshHost()
        auth = readAuth(await getAuth())
        if (auth.uid !== initial.uid || auth.issuer !== initial.issuer || auth.clientId !== initial.clientId) throw new Error("Dim account changed")
        if (auth.expires <= Date.now()) throw new Error("Dim sign-in could not be renewed; sign in again in Magpie")
      }
      return action(auth)
    })
    this.accounts.set(id, { label: initial.accountId, run, active: async () => {
      const auth = readAuth(await getAuth())
      return auth.uid === initial.uid && auth.issuer === initial.issuer && auth.clientId === initial.clientId
    } })
  }

  start(port = 3488) {
    if (this.server) return this.server
    this.server = Bun.serve({
      hostname: "127.0.0.1", port,
      fetch: (req) => this.handle(req),
      maxRequestBodySize: 16 * 1024,
    })
    this.server.unref()
    return this.server
  }

  stop() { return this.server?.stop(true) }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.host !== `127.0.0.1:${this.server?.port}`) return new Response("Invalid host", { status: 403 })
    const origin = req.headers.get("Origin")
    if (origin && origin !== "null" && origin !== url.origin) return new Response("Invalid origin", { status: 403 })
    if (url.pathname === "/" && req.method === "GET") {
      const template = await Bun.file(new URL("../page/account.html", import.meta.url)).text()
      return new Response(template.replace("__SESSION__", this.secret), {
        headers: {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": `default-src 'none'; script-src 'self' ${url.origin}; style-src 'self' ${url.origin}; img-src 'self' ${url.origin}; connect-src 'self' ${url.origin}; base-uri 'none'; form-action 'none'; frame-ancestors 'self' http://127.0.0.1:* http://localhost:*`,
        },
      })
    }
    if (req.method === "GET" && ["/account.js", "/account.css", "/icon.png"].includes(url.pathname)) {
      return new Response(Bun.file(new URL(`../page${url.pathname}`, import.meta.url)), {
        headers: { "Content-Type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : url.pathname.endsWith(".png") ? "image/png" : "text/css; charset=utf-8", "Cache-Control": "no-store" },
      })
    }
    const headers = {
      "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": origin === "null" ? "null" : url.origin,
      "Access-Control-Allow-Headers": "content-type,x-dim-session", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin",
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers })
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
    if (req.method !== "POST" || req.headers.get("x-dim-session") !== this.secret ||
        !req.headers.get("content-type")?.startsWith("application/json")) return reply({ error: "Unauthorized account request" }, 403)
    try {
      const body = record(await req.json(), "account request")
      if (url.pathname === "/accounts") {
        if (this.gatewayAddress) await this.refreshHost()
        const accounts: { id: string; label: string }[] = []
        for (const [id, account] of this.accounts) {
          try { if (await account.active()) accounts.push({ id, label: account.label }); else this.accounts.delete(id) } catch { this.accounts.delete(id) }
        }
        return reply({ accounts })
      }
      const id = text(body.account, "account")
      const account = this.accounts.get(id)
      if (!account) return reply({ error: "Refresh Dim usage in Magpie to load this account" }, 404)
      if (url.pathname === "/view") return reply(await account.run(fetchAccount))
      if (url.pathname === "/open" && (body.page === "subscription" || body.page === "pricing")) {
        const path = body.page
        return reply(await account.run(async (auth) => {
          const url = `${auth.issuer}/console/${path}`
          const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : ["xdg-open", url]
          await new Promise<void>((resolve, reject) => {
            const child = spawn(command[0]!, command.slice(1), { stdio: "ignore", shell: false })
            child.once("error", () => reject(new Error("Could not open the browser; use the displayed purchase URL")))
            child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Could not open the browser; use the displayed purchase URL")))
          })
          return { url }
        }))
      }
      if (url.pathname === "/reset/prepare") {
        if (body.kind !== "window" && body.kind !== "monthly_full") throw new Error("Unknown reset kind")
        // Expired confirmations can no longer initiate an operation.
        for (const [key, entry] of this.confirmations) if (entry.value.expires < Date.now()) this.confirmations.delete(key)
        const kind: ResetKind = body.kind
        const value = await account.run((auth) => prepareReset(auth, kind))
        this.confirmations.set(value.id, { account: id, value })
        const { id: confirmation, available, batches, detailsUnavailable, view } = value
        return reply({ confirmation, kind, available, batches, detailsUnavailable, user: view.user, plan: view.plan?.name, subscriptionId: view.subscriptionId })
      }
      if (url.pathname === "/reset/apply") {
        const entry = this.confirmations.get(text(body.confirmation, "confirmation"))
        if (!entry || entry.account !== id || entry.value.expires < Date.now()) throw new Error("Reset confirmation expired; review the reset again")
        // Duplicate clicks and retries share both the in-flight operation and key.
        if (!entry.result) {
          const operation = account.run((auth) => applyReset(auth, entry.value))
          entry.result = operation
          operation.catch(() => { if (entry.result === operation) entry.result = undefined })
        }
        return reply(await entry.result)
      }
      return reply({ error: "Unknown account operation" }, 404)
    } catch (error) {
      return reply({ error: error instanceof Error ? error.message : "Dim account operation failed" }, 400)
    }
  }
}
