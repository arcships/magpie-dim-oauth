import type { GetAuth, OAuthOptions, Options, ProviderConfig } from "./contracts"
import { PROVIDER } from "./contracts"
import { models } from "./catalog"
import { fetchAccount } from "./account"
import { AccountService } from "./service"
import { identityHeaders, json, request } from "./http"
import { authorize, readAuth, refresh } from "./oauth"

// Entry modules must not export helper functions: Magpie invokes every function.
let accountService: AccountService | undefined
export const DimOAuthPlugin = async (_input: unknown, options: Options = {}) => {
  if (!accountService) {
    const service = new AccountService()
    try {
      service.start(options.port ?? 3488)
      accountService = service
    } catch {
      console.warn("Dim account page port is unavailable; model provider remains available. Set a free plugin port and restart the host.")
    }
  }
  const register = (getAuth: GetAuth) => accountService?.register(getAuth)
  const config: OAuthOptions = {
    issuer: options.issuer ?? process.env.MAGPIE_DIM_ISSUER ?? "https://dimagent.cn",
    clientId: options.clientId ?? process.env.MAGPIE_DIM_CLIENT_ID,
    redirectUri: options.redirectUri ?? process.env.MAGPIE_DIM_REDIRECT_URI,
    scope: options.scope ?? process.env.MAGPIE_DIM_SCOPE,
  }
  const global: OAuthOptions = {
    issuer: options.global?.issuer ?? process.env.MAGPIE_DIM_GLOBAL_ISSUER ?? "https://dimagent.com",
    clientId: options.global?.clientId ?? process.env.MAGPIE_DIM_GLOBAL_CLIENT_ID,
    redirectUri: options.global?.redirectUri ?? process.env.MAGPIE_DIM_GLOBAL_REDIRECT_URI,
    scope: options.global?.scope ?? process.env.MAGPIE_DIM_GLOBAL_SCOPE,
  }
  return {
    config: async (cfg: { provider?: Record<string, ProviderConfig> }) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= { name: "Dim OAuth", npm: "@ai-sdk/openai-compatible", models: {} }
    },
    auth: {
      provider: PROVIDER,
      methods: [{
        type: "oauth" as const, label: "国内站登录",
        authorize: (_inputs?: unknown, context?: { signal?: AbortSignal }) => authorize(config, context?.signal),
      }, {
        type: "oauth" as const, label: global.clientId ? "海外站登录" : "海外站（敬请期待）",
        authorize: (_inputs?: unknown, context?: { signal?: AbortSignal }) => {
          if (!global.clientId) throw new Error("敬请期待")
          return authorize(global, context?.signal)
        },
      }],
      refresh,
      async loader(getAuth: GetAuth) {
        await register(getAuth)
        return {
          async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
            const auth = readAuth(await getAuth())
            const url = new URL(input instanceof Request ? input.url : input)
            if (url.origin !== new URL(auth.issuer).origin || url.username || url.password ||
                !/^\/(v1|v1beta)\//.test(url.pathname)) {
              throw new Error("Refusing to send a Dim token outside the account's relay")
            }
            // The account token is authoritative, regardless of gateway credentials.
            url.searchParams.delete("key")
            const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
            headers.delete("x-api-key")
            headers.delete("x-goog-api-key")
            for (const [key, value] of identityHeaders(auth.access)) headers.set(key, value)
            try {
              const source = input instanceof Request ? new Request(url, input) : url
              // No fixed timeout on a model stream; the gateway owns cancellation.
              return await fetch(source, { ...init, headers, redirect: "error" })
            } catch {
              throw new Error("Dim model request failed or was cancelled")
            }
          },
        }
      },
      async usage(getAuth: GetAuth) {
        await register(getAuth)
        const auth = readAuth(await getAuth())
        const view = await fetchAccount(auth)
        return { user: view.user, plan: view.plan?.name, until: view.plan?.end, windows: view.windows }
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider: ProviderConfig, context: { auth?: unknown } = {}) {
        if (!context.auth) return provider.models
        const auth = readAuth(context.auth)
        return models(await json(await request(`${auth.issuer}/v1/models?type=dim`, {
          headers: identityHeaders(auth.access),
        }), "Dim model list"), auth.issuer)
      },
    },
  }
}
