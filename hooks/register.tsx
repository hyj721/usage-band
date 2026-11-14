import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheEntry, Measure, Ttl, TurnTokens } from '../types'
import { buildItems, describe, desktopSvg, detectStyle, fitTerminal, itemsKey, pillImages, terminalSpans, TTL_MS } from './band'
import type { Item, Look } from './band'

const IDLE: CacheEntry = { lastAt: 0, cold: null }

const measureAtom = atom({ plugin: 'usage-band', key: 'measure' } as const, null)
const turnAtom = atom({ plugin: 'usage-band', key: 'turn' } as const, null)
const cacheAtom = atom({ plugin: 'usage-band', key: 'cache' } as const, IDLE)
const ttlAtom = atom({ plugin: 'usage-band', key: 'ttl' } as const, '1h')
const nowAtom = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const phaseAtom = atom({ plugin: 'usage-band', key: 'phase' } as const, 0)
const styleAtom = atom({ plugin: 'usage-band', key: 'style' } as const, 'unicode')

const FRAME_MS = 200
const PREVIEW = 'usage-band-preview'
const CACHE_TTL = 'cache-ttl'
// Toasts go out when this much of the cache lifetime is left
const WARN_MS: Record<Ttl, number[]> = { '5m': [60_000], '1h': [5 * 60_000, 60_000] }
// How many sessions keep their cache entry in the store
const KEEP_SESSIONS = 30
// Icon set override for the terminal (auto, nerd, unicode or ascii); $.env.get needs the literal name
const ICONS_ENV = 'USAGE_BAND_ICONS'

// Shown by the preview when the session has no reading yet
const SAMPLE_MEASURE: Measure = {
  context: { tokens: 176_000, window: 1_000_000, percent: 18 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 42 },
    { kind: 'seven_day', percentUsed: 43 },
  ],
}
const SAMPLE_TURN: TurnTokens = { input: 900, output: 2_000, cacheRead: 170_000, cacheWrite: 1_000 }

const PROFILES: { name: string; look: Look }[] = [
  { name: 'Ghostty', look: { style: 'nerd', colors: 'true' } },
  { name: 'iTerm2 / Warp / WezTerm / kitty', look: { style: 'unicode', colors: 'true' } },
  { name: 'macOS Terminal (256 colors)', look: { style: 'unicode', colors: '256' } },
  { name: 'ascii fallback', look: { style: 'ascii', colors: '256' } },
]

const isTtl = (v: unknown): v is Ttl => v === '5m' || v === '1h'

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const clockTime = (t: number) => {
  const d = new Date(t)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

type Readings = { measure: Measure | null; turn: TurnTokens | null; cache: CacheEntry; ttl: Ttl }

const readAll = async ($: EngineInterface): Promise<Readings> => {
  return {
    measure: await read($, measureAtom),
    turn: await read($, turnAtom),
    cache: await read($, cacheAtom),
    ttl: await read($, ttlAtom),
  }
}

const itemsOf = (r: Readings, at: number): Item[] => buildItems(r.measure, r.turn, r.cache, r.ttl, at)

// Every write a drawing reads redraws the band, so these only write what changes the picture

const setMeasure = async ($: EngineInterface, next: Measure) => {
  const r = await readAll($)
  const at = await $.clock.now()
  const isSamePicture = itemsKey(itemsOf(r, at)) === itemsKey(itemsOf({ ...r, measure: next }, at))
  if (r.measure && isSamePicture) return
  await update($, measureAtom, () => next)
}

const setTurn = async ($: EngineInterface, next: TurnTokens) => {
  const r = await readAll($)
  const at = await $.clock.now()
  const isSamePicture = itemsKey(itemsOf(r, at)) === itemsKey(itemsOf({ ...r, turn: next }, at))
  if (r.turn && isSamePicture) return
  await update($, turnAtom, () => next)
}

// Moves the band's clock forward only when a countdown shows a new figure
const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const was = await read($, nowAtom)
  const r = await readAll($)
  if (was && itemsKey(itemsOf(r, was)) === itemsKey(itemsOf(r, at))) return
  await update($, nowAtom, () => at)
}

// Functions that take $ must sit at the top level, so the state they share is module-level too
let sessionId = ''
// Warning thresholds already toasted for the current cache entry
let warned = new Set<number>()

const saveCache = async ($: EngineInterface, entry: CacheEntry) => {
  if (!sessionId) return
  const all = ((await $.store.get('sessions')) ?? {}) as Record<string, CacheEntry>
  all[sessionId] = entry
  const newest = Object.entries(all).sort((a, b) => b[1].lastAt - a[1].lastAt)
  await $.store.set('sessions', Object.fromEntries(newest.slice(0, KEEP_SESSIONS)))
}

const setCache = async ($: EngineInterface, entry: CacheEntry) => {
  warned = new Set()
  await update($, cacheAtom, () => entry)
  await saveCache($, entry)
}

const warnBeforeExpiry = async ($: EngineInterface) => {
  const entry = await read($, cacheAtom)
  const ttl = await read($, ttlAtom)
  if (entry.cold || !entry.lastAt) return
  const left = entry.lastAt + TTL_MS[ttl] - (await $.clock.now())
  if (left <= 0) return
  for (const threshold of WARN_MS[ttl]) {
    if (left <= threshold && !warned.has(threshold)) {
      warned.add(threshold)
      $.ui.toast(`Prompt cache expires in ${mmss(left)}`)
    }
  }
}

export const register: Register = on => {
  let iconSetting = 'auto'
  // The terminal animates by redrawing; started by its first draw, so desktop never runs it
  let isAnimating = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    sessionId = await $.session.id()

    const rawSetting = (await $.env.get('USAGE_BAND_ICONS')) ?? 'auto'
    iconSetting = rawSetting.trim().toLowerCase() || 'auto'
    const termProgram = await $.env.get('TERM_PROGRAM')
    await update($, styleAtom, () => detectStyle(iconSetting, termProgram))

    const savedTtl = await $.store.get('ttl')
    if (isTtl(savedTtl)) await update($, ttlAtom, () => savedTtl)
    // A resumed session picks its cache entry back up, unless a reload already holds one
    const current = await read($, cacheAtom)
    if (!current.lastAt && !current.cold) {
      const all = ((await $.store.get('sessions')) ?? {}) as Record<string, CacheEntry>
      const saved = all[sessionId]
      if (saved) await update($, cacheAtom, () => saved)
    }

    await $.command.register({
      name: PREVIEW,
      description: 'Preview how the usage band looks in different terminals',
    })
    await $.command.register({
      name: CACHE_TTL,
      description: 'Show the prompt cache timer, or set its TTL: /cache-ttl 5m | 1h',
      argumentHint: '[5m|1h]',
    })

    const usage = await $.session.usage()
    await setMeasure($, { context: usage.context, rateLimits: usage.rateLimits })
    await tick($)
    $.clock.every(1000, () => {
      void tick($)
      void warnBeforeExpiry($)
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const limits = e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
    const context = { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent }
    await setMeasure($, { context, rateLimits: limits })
    await tick($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Main loop only; subagent runs raise their own turn.complete
    if (e.agentId === undefined && e.usage) {
      await setTurn($, {
        input: e.usage.input_tokens,
        output: e.usage.output_tokens,
        cacheRead: e.usage.cache_read_input_tokens,
        cacheWrite: e.usage.cache_creation_input_tokens,
      })
    }
    return next(e)
  })

  // A main-thread request that read or wrote the cache restarts the cache lifetime from its send time
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const sentAt = await $.clock.now()
    const stream = next(e)
    let isCached = false
    for await (const chunk of stream) {
      if (chunk.kind === 'stop' && chunk.usage) {
        isCached = chunk.usage.cache_read_input_tokens + chunk.usage.cache_creation_input_tokens > 0
      }
      yield chunk
    }
    const result = await stream.result
    if (isCached) await setCache($, { lastAt: sentAt, cold: null }).catch(() => undefined)
    return result
  })

  // Compacting the main thread rewrites the prompt, so the old cache no longer matches
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && !result.skip) {
      await setCache($, { lastAt: 0, cold: 'compacted' }).catch(() => undefined)
    }
    return result
  })

  on('command.run', { command: CACHE_TTL }, async ($, e) => {
    const arg = e.args.trim()
    if (isTtl(arg)) {
      warned = new Set()
      await update($, ttlAtom, () => arg)
      await $.store.set('ttl', arg)
      return { text: `Cache timer TTL set to ${arg}.` }
    }
    if (arg) return { text: `Unknown TTL "${arg}". Use /cache-ttl 5m or /cache-ttl 1h.` }

    const entry = await read($, cacheAtom)
    const ttl = await read($, ttlAtom)
    if (entry.cold) return { text: `TTL ${ttl}. Cache cold (${entry.cold}).` }
    if (!entry.lastAt) return { text: `TTL ${ttl}. No cached request yet.` }
    const left = entry.lastAt + TTL_MS[ttl] - (await $.clock.now())
    let state = 'expired'
    if (left > 0) state = `${mmss(left)} left`
    return { text: `TTL ${ttl}, last cached request sent at ${clockTime(entry.lastAt)}, ${state}.` }
  })

  on('command.run', { command: PREVIEW }, async () => ({
    text: `usage-band style preview (${ICONS_ENV}: ${iconSetting})`,
  }))

  on('ui.render', { component: 'CommandOutput', props: { command: PREVIEW } }, async ($, e) => {
    const r = await readAll($)
    const at = await $.clock.now()
    const sample: Readings = { ...r, measure: r.measure ?? SAMPLE_MEASURE, turn: r.turn ?? SAMPLE_TURN }
    if (!sample.cache.lastAt && !sample.cache.cold) sample.cache = { lastAt: at - 18 * 60_000, cold: null }
    const items = itemsOf(sample, at)
    const current = await read($, styleAtom)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {ICONS_ENV}: {iconSetting} → using {current}
        </Text>
        {PROFILES.map(profile => (
          <Box key={profile.name} flexDirection="column" marginTop={1}>
            <Text dimColor>{profile.name}</Text>
            <Box flexDirection="row">
              {terminalSpans(items, 2, 3, profile.look).map((span, i) => (
                <Text key={`s${i}`} color={span.color} dimColor={span.dim}>
                  {span.text}
                </Text>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await readAll($)
    // Read only to redraw when the clock moves; the picture itself uses the real time
    await read($, nowAtom)
    const items = itemsOf(r, await $.clock.now())
    if (e.props.hasSurvey || items.length === 0) return next(e)

    // Desktop and mobile draw one SVG image; its cache meter drains by its own animation
    if (e.surface === 'desktop' || e.surface === 'mobile') {
      const { Box, Svg } = $.ui.resolve(e)
      const { svg, width, height } = desktopSvg(items)
      return (
        <Box flexDirection="row" justifyContent="center" flexGrow={1} paddingX={1}>
          <Svg source={svg} alt={describe(items)} width={width} height={height} />
        </Box>
      )
    }

    // VS Code draws one image per pill in a wrapping row, since its panel is often a narrow side bar
    if (e.surface === 'vscode') {
      const { Box, Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" flexWrap="wrap" justifyContent="center" columnGap={1} flexGrow={1} paddingX={1}>
          {pillImages(items).map(image => (
            <Svg key={image.id} source={image.svg} alt={image.alt} width={image.width} height={image.height} />
          ))}
        </Box>
      )
    }

    if (!isAnimating) {
      isAnimating = true
      $.clock.every(FRAME_MS, () => {
        void update($, phaseAtom, frame => (frame ?? 0) + 1)
      })
    }
    const frame = await read($, phaseAtom)
    const style = await read($, styleAtom)
    const spans = fitTerminal(items, e.props.bodyColumns - 2, frame, { style, colors: 'true' })
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" flexWrap="wrap" paddingX={1}>
        {spans.map((span, i) => (
          <Text key={`s${i}`} color={span.color} dimColor={span.dim}>
            {span.text}
          </Text>
        ))}
      </Box>
    )
  })
}
