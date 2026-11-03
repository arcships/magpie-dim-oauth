// Structural contracts for the documented Magpie provider hooks.
export interface Options {
  issuer?: string
  clientId?: string
  redirectUri?: string
  scope?: string
  port?: number
}

export interface Auth {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  issuer: string
  tokenEndpoint: string
  clientId: string
  accountId: string
  uid: string
}

export interface Model {
  id: string
  providerID: string
  name: string
  api: { id: string; url: string; npm: string }
  limit: { context: number; output: number }
  capabilities: {
    reasoning: boolean
    toolcall: boolean
    attachment: boolean
    input: Record<string, boolean>
    output: Record<string, boolean>
  }
  cost: { input: number; output: number; cache: { read: number; write: number } }
  options: Record<string, unknown>
  headers: Record<string, string>
  variants: Record<string, Record<string, unknown>>
  status: string
  serviceTiers?: string[]
}

export interface Window {
  name: string
  source: "subscription" | "account" | "feature"
  used?: number
  display?: string
  amount?: number
  limit?: number
  unit?: string
  span?: number
  resetsAt?: string
  aside?: boolean
}

export interface ProviderConfig {
  name: string
  npm: string
  models: Record<string, Model>
}

export type GetAuth = () => Promise<unknown>
export const PROVIDER = "dim-oauth"
