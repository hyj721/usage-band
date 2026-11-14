// Pure drawing code for the band: no engine calls, so it can be tested and previewed on its own
import type { CacheEntry, Limit, Measure, Style, Ttl, TurnTokens } from '../types'

export const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

// One hue per metric; RED and AMBER take over only when a metric needs attention
const HUE = { five: '#5cc4d6', seven: '#e8a25f', ctx: '#9aa5f5', cache: '#72cf9f' }
const RED = '#e5685f'
const AMBER = '#e8a25f'
const GRAY = '#8b8f97'
const TRACK = '#4a4f5c'

// ---- Formatting

export const fmtTokens = (n: number): string => {
  if (n >= 10_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000) return `${Math.round(n / 1_000)}K`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`
  return String(n)
}

// Time until a rate limit resets, e.g. 5d3h, 1h49m, 12m
export const fmtLeft = (ms: number): string => {
  const mins = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

// Time until the prompt cache expires: minutes, then seconds in the last minute
export const fmtCountdown = (ms: number): string => {
  if (ms > 60_000) return `${Math.ceil(ms / 60_000)}m`
  return `${Math.max(0, Math.ceil(ms / 1000))}s`
}

export const hitRate = (t: TurnTokens): number | null => {
  const total = t.input + t.cacheRead + t.cacheWrite
  if (total === 0) return null
  return Math.round((t.cacheRead / total) * 100)
}

// Blend a #rrggbb color toward white (t > 0) or black (t < 0) by |t|
export const lighten = (hex: string, t: number): string => {
  const n = parseInt(hex.slice(1), 16)
  const target = t >= 0 ? 255 : 0
  const blend = (v: number) => {
    const mixed = Math.round(v + (target - v) * Math.abs(t))
    return mixed.toString(16).padStart(2, '0')
  }
  return `#${blend((n >> 16) & 255)}${blend((n >> 8) & 255)}${blend(n & 255)}`
}

// Nearest xterm-256 color, to preview how a 256-color terminal shows the band
export const to256 = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16)
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const levels = [0, 95, 135, 175, 215, 255]
  const cube: number[] = []
  for (const v of rgb) {
    let best = levels[0]!
    for (const level of levels) {
      if (Math.abs(level - v) < Math.abs(best - v)) best = level
    }
    cube.push(best)
  }
  const avg = (rgb[0]! + rgb[1]! + rgb[2]!) / 3
  const g = Math.min(238, Math.max(8, 8 + Math.round((avg - 8) / 10) * 10))
  const gray = [g, g, g]
  const distance = (c: number[]) => (c[0]! - rgb[0]!) ** 2 + (c[1]! - rgb[1]!) ** 2 + (c[2]! - rgb[2]!) ** 2
  let pick = gray
  if (distance(cube) <= distance(gray)) pick = cube
  return `#${pick.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

// ---- What the band shows: one item per metric, shared by every surface

export type Item = {
  id: '5h' | '7d' | 'ctx' | 'cache'
  label: string
  // value: the main figure; suffix: muted text glued to it; detail: a trailing countdown
  value: string
  suffix: string
  detail: string
  // percent: how full the meter is; drainMs > 0: the meter empties over this long
  percent: number
  drainMs: number
  color: string
  alt: string
}

const limitItem = (id: '5h' | '7d', name: string, l: Limit, hue: string, at: number): Item => {
  const pct = Math.round(l.percentUsed)
  let color = hue
  if (pct >= 80) color = RED
  let detail = ''
  if (l.resetsAt) detail = fmtLeft(Date.parse(l.resetsAt) - at)
  return {
    id,
    label: id,
    value: `${pct}%`,
    suffix: '',
    detail,
    percent: pct,
    drainMs: 0,
    color,
    alt: `${name} limit ${pct}% used`,
  }
}

const contextItem = (m: Measure): Item => {
  const pct = m.context.percent ?? 0
  const tokens = fmtTokens(m.context.tokens ?? 0)
  const window = fmtTokens(m.context.window)
  let color = HUE.ctx
  if (pct >= 80) color = RED
  return {
    id: 'ctx',
    label: 'ctx',
    value: tokens,
    suffix: `/${window}`,
    detail: '',
    percent: pct,
    drainMs: 0,
    color,
    alt: `context ${tokens} of ${window}`,
  }
}

// The cache item joins the last turn's hit rate with the countdown until the cache expires
const cacheItem = (t: TurnTokens | null, cache: CacheEntry, ttl: Ttl, at: number): Item | null => {
  let hit: number | null = null
  if (t) hit = hitRate(t)
  const isTracked = cache.lastAt > 0 || cache.cold !== null
  if (hit === null && !isTracked) return null

  let left = 0
  if (cache.lastAt > 0 && cache.cold === null) left = cache.lastAt + TTL_MS[ttl] - at
  const isCold = isTracked && left <= 0

  let color = HUE.cache
  if (hit !== null && hit < 50) color = RED
  if (isTracked && left <= 5 * 60_000) color = AMBER
  if (isTracked && left <= 60_000) color = RED
  if (isCold) color = GRAY

  let value = ''
  if (hit !== null) value = `${hit}%`
  let detail = ''
  if (isCold) detail = 'cold'
  if (isTracked && !isCold) detail = fmtCountdown(left)

  const alts: string[] = []
  if (hit !== null) alts.push(`cache hit ${hit}%`)
  if (isCold) alts.push('cache cold')
  if (isTracked && !isCold) alts.push(`cache expires in ${fmtCountdown(left)}`)

  return {
    id: 'cache',
    label: 'cache',
    value,
    suffix: '',
    detail,
    percent: Math.max(0, Math.min(100, (left / TTL_MS[ttl]) * 100)),
    drainMs: Math.max(0, left),
    color,
    alt: alts.join(', '),
  }
}

export const buildItems = (m: Measure | null, t: TurnTokens | null, cache: CacheEntry, ttl: Ttl, at: number): Item[] => {
  const items: Item[] = []
  const five = m?.rateLimits.find(l => l.kind === 'five_hour')
  const seven = m?.rateLimits.find(l => l.kind === 'seven_day')
  if (five) items.push(limitItem('5h', '5-hour', five, HUE.five, at))
  if (seven) items.push(limitItem('7d', '7-day', seven, HUE.seven, at))
  if (m) items.push(contextItem(m))
  const cached = cacheItem(t, cache, ttl, at)
  if (cached) items.push(cached)
  return items
}

export const describe = (items: Item[]): string => items.map(item => item.alt).join(', ')

// Two sets of items with the same key draw the same band, so a redraw can be skipped
export const itemsKey = (items: Item[]): string => {
  const rows: string[] = []
  for (const item of items) {
    // The cache meter drains by itself between redraws, so its fill is left out of the key
    let fill = Math.round(item.percent)
    if (item.id === 'cache') fill = 0
    rows.push([item.id, item.value, item.suffix, item.detail, item.color, fill].join('|'))
  }
  return rows.join(';')
}

// ---- Terminal: one line of colored text

export type Span = { text: string; color?: string; dim?: boolean }
export type Look = { style: Style; colors: 'true' | '256' }

export const GLYPHS: Record<Style, { ctx: string; cache: string; fill: string; track: string }> = {
  nerd: { ctx: '\u{F0328} ', cache: '\u{F04FE} ', fill: '■', track: '■' },
  unicode: { ctx: '≡ ', cache: '● ', fill: '■', track: '■' },
  ascii: { ctx: 'ctx ', cache: 'cache ', fill: '#', track: '-' },
}

// Terminals known to ship Nerd Font symbols without the user installing a font
const NERD_BUILTIN = new Set(['ghostty'])

export const detectStyle = (setting: string, termProgram: string | undefined): Style => {
  if (setting === 'nerd' || setting === 'unicode' || setting === 'ascii') return setting
  if (NERD_BUILTIN.has((termProgram ?? '').toLowerCase())) return 'nerd'
  return 'unicode'
}

export const width = (spans: Span[]): number => {
  let total = 0
  for (const span of spans) total += [...span.text].length
  return total
}

// A bar that runs from a deep shade to a bright one, with a highlight sweeping left to right
export const bar = (pct: number, cells: number, color: string, frame: number, style: Style = 'unicode'): Span[] => {
  const glyphs = GLYPHS[style]
  let filled = Math.min(cells, Math.round((pct / 100) * cells))
  if (pct > 0 && filled === 0) filled = 1
  // Same period for every bar, so all highlights travel in step
  const highlightAt = frame % (cells + 5)
  const spans: Span[] = []
  for (let i = 0; i < filled; i++) {
    let shade = 0
    if (filled > 1) shade = -0.15 + (0.35 * i) / (filled - 1)
    let glow = 0
    if (i === highlightAt - 1 || i === highlightAt + 1) glow = 0.25
    if (i === highlightAt) glow = 0.55
    spans.push({ text: glyphs.fill, color: lighten(lighten(color, shade), glow) })
  }
  if (cells > filled) spans.push({ text: glyphs.track.repeat(cells - filled), color: TRACK })
  return spans
}

// detail 2: bars and countdowns; 1: no bars; 0: bare figures (the cache countdown always stays)
export const terminalSpans = (items: Item[], detail: 0 | 1 | 2, frame: number, look: Look): Span[] => {
  const glyphs = GLYPHS[look.style]
  const spans: Span[] = []
  for (const item of items) {
    if (spans.length > 0) spans.push({ text: '  ' })
    const isLimit = item.id === '5h' || item.id === '7d'

    let label = `${item.label} `
    if (item.id === 'ctx') label = glyphs.ctx
    if (item.id === 'cache') label = glyphs.cache
    spans.push({ text: label, color: item.color })

    if (isLimit && detail === 2) {
      spans.push(...bar(item.percent, 8, item.color, frame, look.style))
      spans.push({ text: ' ' })
    }
    if (item.value) spans.push({ text: item.value, color: item.color })
    if (item.suffix) spans.push({ text: item.suffix, dim: true })

    if (item.detail && item.id === 'cache') {
      if (item.value) spans.push({ text: ' · ', dim: true })
      spans.push({ text: item.detail, color: item.color })
    }
    if (item.detail && isLimit && detail >= 1) spans.push({ text: ` · ${item.detail}`, dim: true })
  }
  if (look.colors === 'true') return spans
  return spans.map(span => (span.color ? { ...span, color: to256(span.color) } : span))
}

// The most detailed line that fits the columns
export const fitTerminal = (items: Item[], cols: number, frame: number, look: Look): Span[] => {
  for (const detail of [2, 1] as const) {
    const spans = terminalSpans(items, detail, frame, look)
    if (width(spans) <= cols) return spans
  }
  return terminalSpans(items, 0, frame, look)
}

// ---- Desktop: the band is one SVG image, a row of pills where each pill is its own meter

// Band height, pill box, paddings and the text baseline that centres the caps in the pill
type PillSize = { bandH: number; y: number; h: number; padX: number; gap: number; inner: number; font: number; baseline: number }
const REGULAR: PillSize = { bandH: 30, y: 4, h: 22, padX: 11, gap: 8, inner: 6, font: 13, baseline: 19.5 }
// A smaller pill for VS Code, so four of them fit one row of a laptop-width side bar
const COMPACT: PillSize = { bandH: 24, y: 3, h: 18, padX: 7, gap: 5, inner: 4, font: 11, baseline: 16 }

// Advance widths in em for Inter with tabular figures; other letters fall back to 0.6
const ADVANCE: Record<string, number> = {
  a: 0.56, c: 0.56, d: 0.6, e: 0.58, h: 0.58, l: 0.25, m: 0.9, o: 0.6, s: 0.52, t: 0.36, x: 0.55,
  K: 0.64, M: 0.84, '%': 0.84, '/': 0.36, '.': 0.27, ' ': 0.26,
}
// Extra space between letters, in px
const TRACKING = 0.2

const textWidth = (text: string, size: PillSize): number => {
  const chars = [...text]
  let em = 0
  for (const c of chars) {
    if (c >= '0' && c <= '9') em += 0.62
    else em += ADVANCE[c] ?? 0.6
  }
  return em * size.font + TRACKING * Math.max(0, chars.length - 1)
}

const escapeXml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// textLength pins each text to its measured width, so another font never pushes into the next one
const svgText = (x: number, text: string, cls: string, hue: string, size: PillSize): string => {
  const pinned = `textLength="${textWidth(text, size).toFixed(1)}" lengthAdjust="spacing"`
  const tint = `--l:${lighten(hue, -0.42)};--d:${lighten(hue, 0.3)}`
  return `<text x="${x.toFixed(1)}" y="${size.baseline}" font-size="${size.font}" ${pinned} class="${cls}" style="${tint}">${escapeXml(text)}</text>`
}

const pill = (item: Item, x: number, size: PillSize): { svg: string; width: number } => {
  const segments: { text: string; cls: string; gapBefore: number }[] = []
  segments.push({ text: item.label, cls: 'ink label', gapBefore: 0 })
  if (item.value) segments.push({ text: item.value, cls: 'ink', gapBefore: size.inner })
  if (item.suffix) segments.push({ text: item.suffix, cls: 'mute', gapBefore: 1 })
  if (item.detail) {
    // The cache countdown is the figure to watch, so it keeps the pill's color
    let cls = 'mute'
    if (item.id === 'cache') cls = 'ink'
    segments.push({ text: item.detail, cls, gapBefore: size.inner })
  }

  let cursor = x + size.padX
  const texts: string[] = []
  for (const segment of segments) {
    cursor += segment.gapBefore
    texts.push(svgText(cursor, segment.text, segment.cls, item.color, size))
    cursor += textWidth(segment.text, size)
  }
  const pillWidth = Math.ceil(cursor + size.padX - x)

  const box = `x="${x}" y="${size.y}" height="${size.h}"`
  const hue = `style="--h:${item.color}"`
  const meterWidth = ((pillWidth * item.percent) / 100).toFixed(1)
  let drain = ''
  if (item.drainMs > 0) {
    const seconds = (item.drainMs / 1000).toFixed(1)
    drain = `<animate attributeName="width" from="${meterWidth}" to="0" dur="${seconds}s" fill="freeze"/>`
  }

  const svg =
    `<clipPath id="clip-${item.id}"><rect ${box} width="${pillWidth}" rx="${size.h / 2}"/></clipPath>` +
    `<rect ${box} width="${pillWidth}" rx="${size.h / 2}" class="pill" ${hue}/>` +
    `<g clip-path="url(#clip-${item.id})"><rect ${box} width="${meterWidth}" class="meter" ${hue}>${drain}</rect></g>` +
    `<rect x="${x + 0.5}" y="${size.y + 0.5}" width="${pillWidth - 1}" height="${size.h - 1}" rx="${size.h / 2 - 0.5}" class="edge" ${hue}/>` +
    texts.join('')
  return { svg, width: pillWidth }
}

// Declaring both color schemes lets the image follow the app's light or dark mode
const SVG_STYLE =
  `<style>` +
  `:root{color-scheme:light dark;background:transparent}` +
  `text{font-family:Inter,"SF Pro Text",system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:500;font-feature-settings:"tnum","cv05"}` +
  `.ink{fill:var(--l)}.label{font-weight:600}.mute{fill:#737882;font-weight:400}` +
  `.pill{fill:var(--h);fill-opacity:.1}.meter{fill:var(--h);fill-opacity:.3}.edge{fill:none;stroke:var(--h);stroke-opacity:.35}` +
  `@media (prefers-color-scheme:dark){.ink{fill:var(--d)}.mute{fill:#9aa0a8}.pill{fill-opacity:.12}.meter{fill-opacity:.32}.edge{stroke-opacity:.4}}` +
  `</style>`

const svgDocument = (width: number, body: string, size: PillSize): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${size.bandH}" viewBox="0 0 ${width} ${size.bandH}" style="color-scheme:light dark;background:transparent">` +
  SVG_STYLE +
  body +
  `</svg>`

// The whole band as one image, for surfaces wide enough to hold it on one row
export const desktopSvg = (items: Item[]): { svg: string; width: number; height: number } => {
  const size = REGULAR
  let x = 0
  const body: string[] = []
  for (const item of items) {
    const drawn = pill(item, x, size)
    body.push(drawn.svg)
    x += drawn.width + size.gap
  }
  const total = Math.max(1, x - size.gap)
  return { svg: svgDocument(total, body.join(''), size), width: total, height: size.bandH }
}

export type PillImage = { id: string; svg: string; width: number; height: number; alt: string }

// One image per pill, so a narrow surface (a VS Code side bar) can wrap them onto more rows
export const pillImages = (items: Item[]): PillImage[] => {
  const size = COMPACT
  const images: PillImage[] = []
  for (const item of items) {
    const drawn = pill(item, 0, size)
    images.push({ id: item.id, svg: svgDocument(drawn.width, drawn.svg, size), width: drawn.width, height: size.bandH, alt: item.alt })
  }
  return images
}
