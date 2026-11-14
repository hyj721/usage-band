export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Measure = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: Limit[]
}
export type TurnTokens = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type Style = 'nerd' | 'unicode' | 'ascii'
export type Ttl = '5m' | '1h'
// lastAt: when the last cached request was sent; cold: why the cache is known to be gone
export type CacheEntry = { lastAt: number; cold: string | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      measure: Measure | null
      turn: TurnTokens | null
      cache: CacheEntry
      ttl: Ttl
      now: number
      phase: number
      style: Style
    }
  }
}
