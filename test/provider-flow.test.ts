import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DimOAuthPlugin } from "../src/index"
import { AccountService } from "../src/service"
import type { Auth, Options } from "../src/contracts"

const stops: (() => unknown)[] = []
afterEach(async () => { for (const stop of stops.splice(0)) await stop() })

export function fixture() {
  const calls: { path: string; auth: string | null; body: string }[] = []
  let tokenFailure: string | undefined
  let modelFailure = 0
  let quotaFailure = false
  let detailsFailure = false
  let resetReplyFailure = false
  let zdr = true
  let resetsApplied = 0
  const period = new Date(Date.now() + 86400_000).toISOString()
  const bucket = { unlimited: false, total_units: 1000, used_units: 370, remaining_units: 630, expires_at: period, window_states: [
    { window_duration_hours: 5, window_token_cap: 100, window_token_used: 37, window_started_at: new Date().toISOString(), window_expires_at: period },
  ] }
  const summary = { window: { available_count: 3, nearest_expires_at: period }, monthly_full: { available_count: 2 } }
  const usage = () => ({ success: true, data: {
    subscription: { product: { name: "Dim Pro" }, subscription: { id: 88, status: "active" }, current_term: { end_at: period }, price: { amount: 20, currency: "USD", billing_interval: "month" } },
    credits: { subscription_bucket: bucket, addon_buckets: [], remaining_units: 630 }, resets: summary,
    feature_meters: [{ feature_key: "web_search", total_allowance: 100, total_used: 4, period_end: period, unit: "call" }],
  } })
  const applied = new Map<string, unknown>()
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    const body = req.method === "POST" ? await req.text() : ""
    calls.push({ path: url.pathname, auth: req.headers.get("authorization"), body })
    if (url.pathname === "/.well-known/openid-configuration") return Response.json({
      issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, userinfo_endpoint: `${issuer}/oauth/userinfo`,
    })
    if (url.pathname === "/oauth/token") {
      if (tokenFailure) return Response.json({ error: tokenFailure, error_description: "do-not-leak-secret" }, { status: tokenFailure === "temporarily_unavailable" ? 503 : 400 })
      const form = new URLSearchParams(body)
      return Response.json({ token_type: "Bearer", access_token: "access-new", expires_in: 3600, ...(form.get("grant_type") === "authorization_code" ? { refresh_token: "refresh-new" } : {}) })
    }
    if (url.pathname === "/oauth/userinfo") return Response.json({ sub: "user-1", email: "one@example.com" })
    if (url.pathname === "/v1/models") {
      if (modelFailure) return new Response("failed", { status: modelFailure })
      return Response.json({ data: [
        { id: "chat", dim: { id: "chat", displayName: "Dim Chat", endpoint_type: "openai", limit: { context: 128000, output: 8192 }, toolCalling: true, modalities: ["text", "image"], reasoning: { supported: true, effortOptions: ["low", "high"] } } },
        { id: "messages", dim: { endpoint_type: "anthropic", toolCalling: true, limit: { context: 200000, output: 32000 } } },
        { id: "response", supported_endpoint_types: ["openai-response"], tool_call: true },
        { id: "google", supported_endpoint_types: ["gemini"], tool_call: true },
        { id: "default-chat", ...(zdr ? { zdr: true } : {}), dim: { displayName: "Default Chat", modalities: ["text"], limit: { context: 262144, output: 32768 } } },
        { id: "plain-model", dim: null, zdr_supported: true },
        { id: "image-output", dim: { type: "image-generation", modalities: { input: ["text", "image"], output: ["image"] }, tool_call: false } },
        { id: "image", supported_endpoint_types: ["image-generation"] },
      ] })
    }
    if (url.pathname === "/api/me/usage") return quotaFailure ? new Response("down", { status: 503 }) : Response.json(usage())
    if (url.pathname === "/api/me/usage-resets") {
      if (detailsFailure) return new Response("down", { status: 503 })
      const batch = { grant_id: 1, remaining: 3, expires_at: period, scope_type: "account", source_type: "campaign" }
      return Response.json({ data: { window: { batches: [batch] }, monthly_full: { batches: [{ ...batch, scope_type: "subscription", subscription_id: 88 }] } } })
    }
    if (url.pathname === "/api/me/usage-resets/apply") {
      const input = JSON.parse(body)
      if (applied.has(input.idempotency_key)) return Response.json({ data: { ...applied.get(input.idempotency_key)!, replayed: true } })
      resetsApplied++
      const kind: "window" | "monthly_full" = input.reset_type
      summary[kind].available_count--
      const value = { bucket: { ...bucket, used_units: 0 }, window_states: bucket.window_states.map((w) => ({ ...w, window_token_used: 0 })), resets: structuredClone(summary), replayed: false, applied_at: new Date().toISOString() }
      applied.set(input.idempotency_key, value)
      if (resetReplyFailure) return new Response("response unavailable after apply", { status: 503 })
      return Response.json({ data: value })
    }
    if (url.pathname.endsWith("/failure")) return Response.json({ error: "limit" }, { status: 429 })
    if (url.pathname.endsWith("/unauthorized")) return new Response("expired", { status: 401 })
    return new Response('data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"lookup","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } })
  } })
  const issuer: string = `http://127.0.0.1:${server.port}`
  stops.push(() => server.stop(true))
  const auth: Auth = { type: "oauth", access: "access-one", refresh: "refresh-one", expires: Date.now() + 3600_000, issuer, tokenEndpoint: `${issuer}/oauth/token`, clientId: "test-client-only", accountId: "one@example.com", uid: "user-1" }
  return { issuer, auth, calls, usage, summary, options: { issuer, clientId: "test-client-only", redirectUri: "http://127.0.0.1:0/callback", scope: "openid profile email" } satisfies Options,
    setTokenFailure: (value?: string) => { tokenFailure = value }, setModelFailure: (value: number) => { modelFailure = value },
    setQuotaFailure: (value: boolean) => { quotaFailure = value }, setDetailsFailure: (value: boolean) => { detailsFailure = value },
    setUnlimited: () => { bucket.unlimited = true; bucket.total_units = 0; bucket.used_units = 0; bucket.remaining_units = 0 },
    setResetReplyFailure: (value: boolean) => { resetReplyFailure = value }, setZdr: (value: boolean) => { zdr = value }, resetsApplied: () => resetsApplied }
}

async function plugin(options: Options = {}) { return DimOAuthPlugin({}, { port: 0, ...options }) }
const configured = { name: "Dim OAuth", npm: "@ai-sdk/openai-compatible", models: {} }

describe("Magpie provider flows", () => {
  test("an explicitly disabled domestic client does not borrow another registration", async () => {
    const hooks = await plugin({ clientId: "" })
    const cfg = { provider: { "dim-oauth": { ...configured, name: "User label" } } }
    await hooks.config(cfg)
    expect(cfg.provider["dim-oauth"].name).toBe("User label")
    expect(hooks.auth.methods[0]!.label).toBe("国内站登录")
    await expect(hooks.auth.methods[0]!.authorize()).rejects.toThrow("client ID")
  })

  test("bundled site registrations use their own client IDs with PKCE S256", async () => {
    const cn = fixture(), global = fixture()
    const hooks = await plugin({ issuer: cn.issuer, redirectUri: cn.options.redirectUri, global: { issuer: global.issuer, redirectUri: global.options.redirectUri } })
    expect(hooks.auth.methods.map((method) => method.label)).toEqual(["国内站登录", "海外站登录"])
    for (const [index, issuer, clientId] of [[0, cn.issuer, "271706aab9b74b15a7140b228a419e4a"], [1, global.issuer, "91975f99125f42bc88859100a1769ea4"]] as const) {
      const abort = new AbortController()
      const login = await hooks.auth.methods[index]!.authorize(undefined, { signal: abort.signal })
      try {
        const url = new URL(login.url)
        expect(url.origin).toBe(issuer)
        expect(url.searchParams.get("client_id")).toBe(clientId)
        expect(url.searchParams.get("scope")).toBe("openid profile email")
        expect(url.searchParams.get("code_challenge_method")).toBe("S256")
        expect(url.searchParams.get("code_challenge")).toHaveLength(43)
      } finally { abort.abort(); await login.callback() }
    }
  })

  test("PKCE login binds state and client, persists issuer and verifies userinfo", async () => {
    const f = fixture()
    const hooks = await plugin(f.options)
    const login = await hooks.auth.methods[0]!.authorize()
    const url = new URL(login.url)
    const redirect = new URL(url.searchParams.get("redirect_uri")!)
    const invalid = new URL(redirect); invalid.search = new URLSearchParams({ state: "wrong", code: "wrong" }).toString()
    expect((await fetch(invalid)).status).toBe(400)
    redirect.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "code-one" }).toString()
    expect((await fetch(redirect)).status).toBe(200)
    const result = await login.callback()
    expect(result.type).toBe("success")
    if (result.type !== "success") throw new Error(result.error)
    expect(result.clientId).toBe("test-client-only")
    expect(result.issuer).toBe(f.issuer)
    expect(result.uid).toBe(JSON.stringify([f.issuer, "user-1"]))
    const form = new URLSearchParams(f.calls.find((call) => call.path === "/oauth/token")!.body)
    expect(form.has("client_secret")).toBe(false)
    expect(form.get("client_id")).toBe("test-client-only")
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge")!)
    expect((await login.callback()).type).toBe("failed")
    await expect(fetch(new URL(url.searchParams.get("redirect_uri")!))).rejects.toThrow()
  })

  test("cancel closes the callback server and does not exchange a code", async () => {
    const f = fixture(); const hooks = await plugin(f.options); const abort = new AbortController()
    const login = await hooks.auth.methods[0]!.authorize(undefined, { signal: abort.signal })
    abort.abort()
    expect(await login.callback()).toEqual({ type: "failed", error: "Dim sign-in cancelled" })
    await expect(fetch(new URL(login.url).searchParams.get("redirect_uri")!)).rejects.toThrow()
    expect(f.calls.some((call) => call.path === "/oauth/token")).toBe(false)
  })

  test("unconfigured global sign-in shows the coming-soon entry without borrowing domestic credentials", async () => {
    const f = fixture()
    const hooks = await plugin({ ...f.options, global: { clientId: "" } })
    expect(hooks.auth.methods.map((method) => method.label)).toEqual(["国内站登录", "海外站（敬请期待）"])
    expect(() => hooks.auth.methods[1]!.authorize()).toThrow("敬请期待")
    expect(f.calls).toHaveLength(0)
  })

  test("both site logins keep separate identities, refresh clients and account operations", async () => {
    const cn = fixture(), global = fixture()
    const hooks = await plugin({ ...cn.options, global: { ...global.options, clientId: "global-test-client-only" } })
    expect(hooks.auth.methods[1]!.label).toBe("海外站登录")
    const accounts: Auth[] = []
    for (const [index, site, clientId] of [[0, cn, "test-client-only"], [1, global, "global-test-client-only"]] as const) {
      const login = await hooks.auth.methods[index]!.authorize()
      const url = new URL(login.url)
      expect(url.origin).toBe(site.issuer)
      expect(url.searchParams.get("client_id")).toBe(clientId)
      const callback = new URL(url.searchParams.get("redirect_uri")!)
      callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "site-code" }).toString()
      expect((await fetch(callback)).status).toBe(200)
      const result = await login.callback()
      if (result.type !== "success") throw new Error(result.error)
      const { type: _type, ...fields } = result
      const auth: Auth = { ...fields, type: "oauth" }
      accounts.push(auth)
      await hooks.auth.refresh(auth)
      expect(new URLSearchParams(site.calls.findLast((call) => call.path === "/oauth/token")!.body).get("client_id")).toBe(clientId)
      const loader = await hooks.auth.loader(async () => auth)
      await loader.fetch(`${site.issuer}/v1/messages`)
      await expect(loader.fetch(`${index === 0 ? global.issuer : cn.issuer}/v1/messages`)).rejects.toThrow("outside")
      await hooks.provider.models(configured, { auth })
      await hooks.auth.usage(async () => auth)
    }
    expect(accounts[0]!.accountId).toBe(accounts[1]!.accountId)
    expect(accounts[0]!.uid).not.toBe(accounts[1]!.uid)
    expect(accounts[0]!.tokenEndpoint).not.toBe(accounts[1]!.tokenEndpoint)

    const service = new AccountService("")
    const server = service.start(0); stops.push(() => service.stop())
    for (const auth of accounts) await service.register(async () => auth)
    const base = `http://127.0.0.1:${server.port}/`
    const secret = (await (await fetch(base)).text()).match(/name="dim-session" content="([^"]+)"/)![1]!
    const post = async (path: string, data: Record<string, unknown> = {}) => {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Dim-Session": secret }, body: JSON.stringify(data) })
      expect(response.status).toBe(200)
      return response.json()
    }
    const list = await post("accounts")
    expect(list.accounts).toHaveLength(2)
    for (const [index, site] of [cn, global].entries()) {
      expect(list.accounts[index].label).toContain(new URL(site.issuer).host)
      const account = list.accounts[index].id
      const view = await post("view", { account })
      expect(view.subscriptionUrl).toBe(`${site.issuer}/console/subscription`)
      expect(view.pricingUrl).toBe(`${site.issuer}/console/pricing`)
      const confirmation = await post("reset/prepare", { account, kind: "window" })
      await post("reset/apply", { account, confirmation: confirmation.confirmation })
      expect(site.resetsApplied()).toBe(1)
    }
  })

  test("refresh uses the saved client and retains an unrotated refresh token", async () => {
    const f = fixture(); const hooks = await plugin({ ...f.options, clientId: "different-new-registration" })
    const renewed = await hooks.auth.refresh(f.auth)
    expect(renewed.refresh).toBe("refresh-one")
    expect(new URLSearchParams(f.calls.at(-1)!.body).get("client_id")).toBe("test-client-only")
    f.setTokenFailure("invalid_grant")
    await expect(hooks.auth.refresh(f.auth)).rejects.toMatchObject({ signIn: "expired" })
    f.setTokenFailure("temporarily_unavailable")
    try { await hooks.auth.refresh(f.auth); throw new Error("expected failure") } catch (error) {
      expect(error).not.toHaveProperty("signIn")
      expect(String(error)).not.toContain("do-not-leak-secret")
    }
  })

  test("catalog follows server protocols, capabilities and per-account authentication", async () => {
    const f = fixture(); const hooks = await plugin()
    const models = await hooks.provider.models(configured, { auth: f.auth })
    expect(Object.keys(models)).toEqual(["chat", "messages", "response", "google", "default-chat", "plain-model", "image-output"])
    expect(models.chat!.limit.context).toBe(128000)
    expect(models.chat!.capabilities.input.image).toBe(true)
    expect(models.messages!.api).toMatchObject({ npm: "@ai-sdk/anthropic", url: `${f.issuer}/v1` })
    expect(models.response!.api.npm).toBe("@ai-sdk/openai")
    expect(models.google!.api.url).toBe(`${f.issuer}/v1beta`)
    expect(models["default-chat"]!.api).toMatchObject({ npm: "@ai-sdk/openai-compatible", url: `${f.issuer}/v1` })
    expect(models["default-chat"]!.limit.context).toBe(262144)
    expect(models["default-chat"]!.name).toBe("Default Chat · ZDR")
    expect(models["default-chat"]!.api.id).toBe("default-chat")
    expect(models["plain-model"]!.id).toBe("plain-model")
    expect(models["plain-model"]!.name).toBe("plain-model")
    expect(models["image-output"]!.capabilities.output).toEqual({ image: true })
    expect(Object.keys(models.chat!.variants)).toEqual(["low", "high"])
    f.setZdr(false)
    const refreshed = await hooks.provider.models(configured, { auth: f.auth })
    expect(refreshed["default-chat"]!.name).toBe("Default Chat")
    f.setModelFailure(503)
    await expect(hooks.provider.models(configured, { auth: f.auth })).rejects.toThrow("503")
    f.setModelFailure(401)
    await expect(hooks.provider.models(configured, { auth: f.auth })).rejects.toMatchObject({ signIn: "expired" })
  })

  test("model fetch streams tool calls, preserves failures, isolates credentials and cancellation", async () => {
    const f = fixture(); const hooks = await plugin()
    let current: Auth = f.auth
    const loader = await hooks.auth.loader(async () => current)
    current = { ...f.auth, access: "rotated-in-host" }
    const response = await loader.fetch(`${f.issuer}/v1/messages`, { method: "POST", headers: { "x-api-key": "gateway-secret", authorization: "Bearer stale" }, body: "{}" })
    expect(response.headers.get("Content-Type")).toBe("text/event-stream")
    expect(await response.text()).toContain('"tool_calls"')
    expect(f.calls.at(-1)!.auth).toBe("Bearer rotated-in-host")
    expect((await loader.fetch(`${f.issuer}/v1/failure`)).status).toBe(429)
    expect((await loader.fetch(`${f.issuer}/v1/unauthorized`)).status).toBe(401)
    await expect(loader.fetch("https://example.com/v1/messages")).rejects.toThrow("outside")
    const abort = new AbortController(); abort.abort()
    await expect(loader.fetch(`${f.issuer}/v1/messages`, { signal: abort.signal })).rejects.toThrow("cancelled")
    const other = await hooks.auth.loader(async () => ({ ...f.auth, uid: "user-2", accountId: "two@example.com", access: "two" }))
    await other.fetch(`${f.issuer}/v1/messages`)
    expect(f.calls.at(-1)!.auth).toBe("Bearer two")
  })

  test("usage exposes measured counts and reset dates without turning add-ons into account exhaustion", async () => {
    const f = fixture(); const hooks = await plugin()
    const result = await hooks.auth.usage(async () => f.auth)
    expect(result.plan).toBe("Dim Pro")
    expect(result.windows.find((window) => window.name === "5h window")).toMatchObject({ used: 37, amount: 37, limit: 100, resetsAt: expect.any(String), aside: true })
    f.setQuotaFailure(true)
    await expect(hooks.auth.usage(async () => f.auth)).rejects.toThrow("503")
    f.setQuotaFailure(false); f.setUnlimited()
    const unlimited = await hooks.auth.usage(async () => f.auth)
    expect(unlimited.windows.find((window) => window.name === "Subscription")).toMatchObject({ display: "Unlimited" })
    expect(unlimited.windows.some((window) => window.name === "Credits")).toBe(false)
  })
})

test.skipIf(!process.env.MAGPIE_TEST_BINARY)("official Magpie installs the plugin, loads its catalog and rotates saved credentials", async () => {
  const binary = process.env.MAGPIE_TEST_BINARY!
  const f = fixture()
  const sandbox = await mkdtemp(join(tmpdir(), "magpie-dim-test-"))
  stops.push(() => rm(sandbox, { recursive: true, force: true }))
  const dir = join(sandbox, "config", "magpie")
  await mkdir(dir, { recursive: true })
  const freePort = async () => { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = server.port; await server.stop(true); return port }
  const gatewayPort = await freePort()
  const pagePort = await freePort()
  const webPort = await freePort()
  const env = { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: join(sandbox, "config"), XDG_CACHE_HOME: join(sandbox, "cache"), MAGPIE_BUN: process.execPath, MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`, MAGPIE_DIM_GLOBAL_CLIENT_ID: "" }
  const run = async (...args: string[]) => {
    const child = Bun.spawn([binary, ...args], { env, cwd: sandbox, stdout: "pipe", stderr: "pipe" })
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code) throw new Error(`Magpie ${args[0]} failed: ${error} ${output}`)
    return output
  }
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
  await run("plugin", "add", root)
  const pluginFile = Bun.file(join(dir, "plugins.json"))
  const config = await pluginFile.json()
  config.plugins[0].options = { port: pagePort }
  await Bun.write(pluginFile, JSON.stringify(config))
  const installed = await run("plugin", "--json")
  expect(installed).toContain("dim-oauth")
  expect(installed).toContain("国内站登录")
  expect(installed).toContain("海外站（敬请期待）")
  await Bun.write(join(dir, "plugin-auth.json"), JSON.stringify({ "dim-oauth": { ...f.auth, expires: Date.now() - 1000 } }))
  const listed = await run("plugin", "--json")
  expect(listed).toContain("Dim Chat")
  const quotas = await run("quota", "--json")
  expect(quotas).toContain("Dim Pro")
  const saved = await Bun.file(join(dir, "plugin-auth.json")).json()
  expect(saved["dim-oauth"].access).toBe("access-new")
  expect(saved["dim-oauth"].refresh).toBe("refresh-one")
  expect(f.calls.filter((call) => call.path === "/oauth/token")).toHaveLength(1)
  const web = Bun.spawn([binary, "web", "--no-open", "--gateway", "--addr", `127.0.0.1:${webPort}`], { env, cwd: sandbox, stdout: "ignore", stderr: "ignore" })
  stops.unshift(async () => { web.kill(); await web.exited })
  let html: string | undefined
  for (let attempt = 0; attempt < 100 && !html; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, { signal: AbortSignal.timeout(1000) })
      await response.body?.cancel()
      html = await (await fetch(`http://127.0.0.1:${pagePort}/`, { signal: AbortSignal.timeout(1000) })).text()
    } catch { await Bun.sleep(100) }
  }
  expect(html).toContain('name="dim-session"')
  const secret = html!.match(/name="dim-session" content="([^"]+)"/)![1]!
  const accounts = await fetch(`http://127.0.0.1:${pagePort}/accounts`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Dim-Session": secret }, body: "{}",
  })
  expect(accounts.status).toBe(200)
  const accountList = await accounts.json()
  expect(accountList.accounts).toHaveLength(1)
  const accountPage = await fetch(`http://127.0.0.1:${pagePort}/view`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Dim-Session": secret }, body: JSON.stringify({ account: accountList.accounts[0].id }),
  })
  expect(accountPage.status).toBe(200)
  expect((await accountPage.json()).plan.name).toBe("Dim Pro")
}, 60_000)

describe("Account page user flows", () => {
  async function page(f = fixture(), gateway?: string) {
    const service = new AccountService(gateway)
    const server = service.start(0)
    stops.push(() => service.stop())
    let current: unknown = f.auth
    const scope = new AsyncLocalStorage<string>()
    await scope.run("account-one", () => service.register(async () => current))
    const base = `http://127.0.0.1:${server.port}/`
    const htmlResponse = await fetch(base)
    const html = await htmlResponse.text()
    const secret = html.match(/name="dim-session" content="([^"]+)"/)![1]!
    const post = async (path: string, body: Record<string, unknown> = {}) => {
      const response = await fetch(new URL(path, base), { method: "POST", headers: { "Content-Type": "application/json", "X-Dim-Session": secret, Origin: "null" }, body: JSON.stringify(body) })
      return { response, data: await response.json() }
    }
    const list = await post("accounts")
    return { f, service, base, secret, htmlResponse, post, id: list.data.accounts[0]?.id, setAuth: (auth: unknown) => { current = auth } }
  }

  test("shows subscription purchase/renewal URLs, usage, reset counts and expiry", async () => {
    const p = await page()
    const { data } = await p.post("view", { account: p.id })
    expect(data.subscriptionUrl).toBe(`${p.f.issuer}/console/subscription`)
    expect(data.pricingUrl).toBe(`${p.f.issuer}/console/pricing`)
    expect(data.plan).toMatchObject({ name: "Dim Pro", amount: 20 })
    expect(data.resets.window.available).toBe(3)
    expect(JSON.stringify(data)).not.toContain("access-one")
    expect(p.htmlResponse.headers.has("access-control-allow-origin")).toBe(false)
    expect(p.htmlResponse.headers.get("content-security-policy")).toContain("frame-ancestors 'self' wails://localhost")
    const stale = p.id; p.setAuth(undefined)
    expect((await p.post("accounts")).data.accounts).toEqual([])
    expect((await p.post("view", { account: stale })).response.status).toBe(404)
  })

  for (const kind of ["window", "monthly_full"] as const) test(`${kind}: review details, explicitly apply once, and update from the response`, async () => {
    const p = await page()
    const prepare = await p.post("reset/prepare", { account: p.id, kind })
    expect(prepare.data.batches).toHaveLength(1)
    expect(prepare.data.subscriptionId).toBe(88)
    expect(p.f.resetsApplied()).toBe(0)
    const before = p.f.calls.filter((call) => call.path === "/api/me/usage").length
    const body = { account: p.id, confirmation: prepare.data.confirmation }
    const [first, duplicate] = await Promise.all([p.post("reset/apply", body), p.post("reset/apply", body)])
    expect(first.response.status).toBe(200)
    expect(duplicate.response.status).toBe(200)
    expect(p.f.resetsApplied()).toBe(1)
    expect(first.data.view.resets[kind].available).toBe(p.f.summary[kind].available_count)
    expect(first.data.view.windows[0].used).toBe(0)
    expect(first.data.view.windows.find((window: { name: string }) => window.name === "web_search")).toBeDefined()
    expect(p.f.calls.filter((call) => call.path === "/api/me/usage")).toHaveLength(before)
    expect(JSON.parse(p.f.calls.find((call) => call.path.endsWith("/apply"))!.body)).toMatchObject({ subscription_id: 88, reset_type: kind, idempotency_key: expect.any(String) })
  })

  test("reset details failure does not hide the summary or prevent a reviewed reset", async () => {
    const p = await page(); p.f.setDetailsFailure(true)
    const result = await p.post("reset/prepare", { account: p.id, kind: "window" })
    expect(result.response.status).toBe(200)
    expect(result.data.detailsUnavailable).toBe(true)
  })

  test("uncertain reset result retries the same operation without consuming a second credit", async () => {
    const p = await page(); p.f.setResetReplyFailure(true)
    const prepare = await p.post("reset/prepare", { account: p.id, kind: "window" })
    const body = { account: p.id, confirmation: prepare.data.confirmation }
    expect((await p.post("reset/apply", body)).response.status).toBe(400)
    expect(p.f.resetsApplied()).toBe(1)
    p.f.setResetReplyFailure(false)
    const retry = await p.post("reset/apply", body)
    expect(retry.response.status).toBe(200)
    expect(retry.data.replayed).toBe(true)
    expect(p.f.resetsApplied()).toBe(1)
    const keys = p.f.calls.filter((call) => call.path.endsWith("/apply")).map((call) => JSON.parse(call.body).idempotency_key)
    expect(new Set(keys).size).toBe(1)
  })

  test("reset needs a matching confirmation and rejects cross-origin or unauthenticated requests", async () => {
    const p = await page()
    const noConfirmation = await p.post("reset/apply", { account: p.id, confirmation: "forged" })
    expect(noConfirmation.response.status).toBe(400)
    const headers = { "Content-Type": "application/json", "X-Dim-Session": p.secret, Origin: "https://evil.example" }
    expect((await fetch(`${p.base}reset/prepare`, { method: "POST", headers, body: JSON.stringify({ account: p.id, kind: "window" }) })).status).toBe(403)
    expect((await fetch(`${p.base}accounts`, { method: "POST", body: "{}" })).status).toBe(403)
    expect(p.f.resetsApplied()).toBe(0)
  })

  test("account page asks the native gateway to renew instead of exchanging refresh tokens itself", async () => {
    const f = fixture()
    let current: Auth = { ...f.auth, expires: Date.now() - 1000 }
    let refreshes = 0
    const gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
      expect(new URL(req.url).pathname).toBe("/v1/magpie/quotas/refresh")
      refreshes++; current = { ...current, access: "renewed-by-native-host", expires: Date.now() + 3600_000 }
      return Response.json({})
    } })
    stops.push(() => gateway.stop(true))
    const service = new AccountService(`127.0.0.1:${gateway.port}`)
    const server = service.start(0); stops.push(() => service.stop())
    await service.register(async () => current)
    const base = `http://127.0.0.1:${server.port}/`
    const secret = (await (await fetch(base)).text()).match(/name="dim-session" content="([^"]+)"/)![1]!
    const response = await fetch(`${base}accounts`, { method: "POST", headers: { "Content-Type": "application/json", "X-Dim-Session": secret }, body: "{}" })
    expect(response.status).toBe(200)
    expect(refreshes).toBe(1)
    expect(f.calls.filter((call) => call.path === "/oauth/token")).toHaveLength(0)
  })
})
