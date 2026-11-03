import { PROVIDER, type Model, type Window } from "./contracts"
import { number, record, text } from "./http"

const apis: Record<string, { npm: string; path: string }> = {
  openai: { npm: "@ai-sdk/openai-compatible", path: "/v1" },
  "openai-response": { npm: "@ai-sdk/openai", path: "/v1" },
  anthropic: { npm: "@ai-sdk/anthropic", path: "/v1" },
  gemini: { npm: "@ai-sdk/google", path: "/v1beta" },
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}: expected an array`)
  return value.map((item) => text(item, label))
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) return false
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}: expected a boolean`)
  return value
}

export function models(payload: Record<string, unknown>, issuer: string): Record<string, Model> {
  if (!Array.isArray(payload.data)) throw new Error("Invalid Dim model list: missing data array")
  const out: Record<string, Model> = Object.create(null)
  for (const item of payload.data) {
    const raw = record(item, "Dim model")
    const id = text(raw.id, "model ID")
    const config = raw.dim == null ? raw : record(raw.dim, "Dim model config")
    if (config.id !== undefined && text(config.id, "config model ID") !== id) throw new Error("Dim model config ID mismatch")
    if (config.status === "unavailable") continue
    const explicit = config.endpoint_type ?? raw.endpointType ?? raw.endpoint_type
    const declared = config.selectableEndpointTypes ?? config.selectable_endpoint_types ??
      config.supportedEndpointTypes ?? config.supported_endpoint_types
    const candidates = explicit !== undefined ? [text(explicit, "endpoint type")] :
      declared !== undefined ? strings(declared, "endpoint types") : []
    const kind = candidates.find((candidate) => Object.hasOwn(apis, candidate))
    // Image-only and unclassified models cannot serve Magpie agent conversations.
    if (!kind) continue
    const api = apis[kind]!
    if (Object.hasOwn(out, id)) throw new Error("Invalid Dim model list: duplicate model ID")
    const limit = config.limit === undefined ? {} : record(config.limit, "model limits")
    const modalities = config.modalities === undefined || Array.isArray(config.modalities) ? {} : record(config.modalities, "model modalities")
    const input = Array.isArray(config.modalities) ? strings(config.modalities, "input modalities") :
      modalities.input === undefined ? ["text", ...(config.vision === true ? ["image"] : [])] : strings(modalities.input, "input modalities")
    const output = modalities.output === undefined ? ["text"] : strings(modalities.output, "output modalities")
    const extra = config.extra_capabilities === undefined ? {} : record(config.extra_capabilities, "extra capabilities")
    const reasoning = extra.reasoning ?? config.reasoning
    const reasoningInfo = typeof reasoning === "object" && reasoning !== null ? record(reasoning, "reasoning") : undefined
    const levels = reasoningInfo?.effortOptions ?? reasoningInfo?.effort_options
    const variants = levels === undefined ? {} : Object.fromEntries(strings(levels, "reasoning levels").map((level) => [level, {}]))
    const tier = config.serviceTier ?? raw.serviceTier ?? raw.service_tier ?? extra.serviceTier ?? extra.service_tier
    const tiers = typeof tier === "object" && tier !== null ? record(tier, "service tiers").options : undefined
    const serviceTiers = tiers === undefined ? undefined : strings(tiers, "service tier options").filter((t) => t !== "default")
    out[id] = {
      id, providerID: PROVIDER, name: text(config.displayName ?? config.display_name ?? config.name ?? raw.display_name ?? raw.name ?? id, "model name"),
      api: { id, url: `${issuer}${api.path}`, npm: api.npm },
      limit: {
        context: number(config.context_window ?? config.contextWindow ?? limit.context ?? 0, "context limit"),
        output: number(config.max_output_tokens ?? config.maxOutputTokens ?? limit.output ?? 0, "output limit"),
      },
      capabilities: {
        reasoning: optionalBoolean(reasoningInfo?.supported ?? (reasoningInfo ? levels !== undefined : reasoning), "reasoning support"),
        toolcall: optionalBoolean(config.tool_call ?? config.toolCalling, "tool support"),
        attachment: input.some((value) => value !== "text"),
        input: Object.fromEntries(input.map((value) => [value, true])),
        output: Object.fromEntries(output.map((value) => [value, true])),
      },
      // Magpie uses zero for unknown limits/prices; these are not advertised prices.
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      options: {}, headers: {}, variants,
      status: config.status === "deprecated" ? "deprecated" : "active",
      ...(serviceTiers ? { serviceTiers } : {}),
    }
  }
  if (payload.data.length > 0 && Object.keys(out).length === 0) {
    throw new Error("Dim returned no models with a supported conversational endpoint")
  }
  return out
}

export function usage(payload: Record<string, unknown>, user: string) {
  const data = record(payload.data, "Dim usage data")
  const credits = record(data.credits, "Dim credits")
  const windows: Window[] = []
  const bucket = credits.subscription_bucket === null ? undefined : record(credits.subscription_bucket, "subscription bucket")
  if (bucket) {
    if (bucket.unlimited === true) {
      windows.push({ name: "Subscription", source: "subscription", display: "Unlimited", aside: true })
    } else if (bucket.total_units !== undefined && bucket.used_units !== undefined) {
      const total = number(bucket.total_units, "subscription total")
      const used = number(bucket.used_units, "subscription used")
      if (total > 0) windows.push({ name: "Subscription", source: "subscription", used: used / total * 100, amount: used, limit: total, unit: "units", ...(typeof bucket.expires_at === "string" ? { resetsAt: bucket.expires_at } : {}) })
      else windows.push({ name: "Subscription", source: "subscription", display: "No subscription allowance reported", aside: true })
    }
    // Add-ons may fund requests when the subscription is exhausted, so the total
    // subscription bucket is informational; only account-wide windows route traffic.
    for (const window of windows) window.aside = true
    let states: unknown = bucket.window_states
    if (states === undefined) {
      // The production API also serves the documented legacy single-window tuple.
      const fields = [bucket.window_duration_hours, bucket.window_token_cap, bucket.window_token_used, bucket.window_started_at, bucket.window_expires_at]
      if (fields.every((value) => value === undefined || value === null || value === 0)) states = []
      else if (fields.some((value) => value === undefined)) throw new Error("Invalid Dim usage: incomplete legacy window")
      else states = [bucket]
    }
    if (!Array.isArray(states)) throw new Error("Invalid Dim usage: missing window_states")
    for (const item of states) {
      const state = record(item, "usage window")
      const limit = number(state.window_token_cap, "window limit")
      const used = number(state.window_token_used, "window used")
      const hours = number(state.window_duration_hours, "window duration")
      const expiry = state.window_expires_at
      if (expiry !== null && (typeof expiry !== "string" || !Number.isFinite(Date.parse(expiry)))) {
        throw new Error("Invalid Dim usage: window expiry")
      }
      if (limit > 0) windows.push({
        name: `${hours}h window`, source: "subscription", used: used / limit * 100, amount: used, limit, unit: "tokens", span: hours * 3600,
        ...(typeof expiry === "string" ? { resetsAt: expiry } : {}),
        // A subscription window does not describe add-on eligibility.
        aside: true,
      })
    }
  }
  if (credits.remaining_units !== undefined && bucket?.unlimited !== true) {
    const remaining = number(credits.remaining_units, "remaining units")
    windows.push({ name: "Credits", source: "account", display: `${remaining} units remaining`, aside: true })
  }
  if (data.feature_meters !== undefined) {
    if (!Array.isArray(data.feature_meters)) throw new Error("Invalid feature meters")
    for (const item of data.feature_meters) {
      const meter = record(item, "feature meter")
      const name = text(meter.feature_key, "feature name")
      if (meter.unlimited === true) windows.push({ name, source: "feature", display: "Unlimited", aside: true })
      else if (meter.total_allowance !== undefined && meter.total_used !== undefined) {
        const limit = number(meter.total_allowance, "feature allowance")
        const amount = number(meter.total_used, "feature used")
        windows.push({ name, source: "feature", amount, limit, ...(limit > 0 ? { used: amount / limit * 100 } : {}), aside: true,
          ...(typeof meter.unit === "string" ? { unit: meter.unit } : {}),
          ...(typeof meter.period_end === "string" ? { resetsAt: meter.period_end } : {}) })
      }
    }
  }
  if (!windows.length) windows.push({ name: "Usage", source: "account", display: "No allowance reported", aside: true })
  return { user, windows }
}
