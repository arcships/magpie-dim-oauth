export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected an object`)
  }
  return value as Record<string, unknown>
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}: expected text`)
  return value.trim()
}

export function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}: expected a non-negative number`)
  }
  return value
}

export function trustedUrl(value: unknown, label: string): URL {
  let url: URL
  try { url = new URL(text(value, label)) } catch { throw new Error(`Invalid ${label}: expected a URL`) }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))) {
    throw new Error(`Invalid ${label}: HTTPS is required outside loopback`)
  }
  return url
}

export function endpoint(value: unknown, issuer: string, label: string): string {
  const url = trustedUrl(value, label)
  if (url.origin !== new URL(issuer).origin) throw new Error(`Invalid ${label}: must share the issuer origin`)
  return url.href
}

export function identityHeaders(access?: string): Headers {
  const headers = new Headers({ "User-Agent": "magpie-dim-oauth/0.1.0", "X-Title": "Magpie Dim OAuth" })
  if (access) headers.set("Authorization", `Bearer ${access}`)
  return headers
}

export async function request(input: string | URL, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(input, {
      ...init,
      redirect: "error",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    })
  } catch {
    // Fetch errors may contain a callback URL, authorization code or other secrets.
    throw new Error(init.signal?.aborted ? "Dim request cancelled" : "Dim request failed or timed out")
  }
}

export async function json(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw Object.assign(new Error(`${label} failed (HTTP ${response.status})`),
      response.status === 401 ? { signIn: "expired" } : {})
  }
  let payload: unknown
  try { payload = await response.json() } catch { throw new Error(`Invalid ${label}: expected JSON`) }
  const result = record(payload, label)
  if (result.success === false) throw new Error(`${label} was refused by Dim`)
  return result
}
