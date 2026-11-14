import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, buildItems, desktopSvg, detectStyle, fitTerminal, fmtCountdown, fmtLeft, fmtTokens, hitRate, itemsKey, to256, width } from '../hooks/band'
import type { Measure } from '../types'

const IDLE = { lastAt: 0, cold: null }
const MEASURE: Measure = {
  context: { tokens: 100_000, window: 1_000_000, percent: 10 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 20, resetsAt: new Date(160 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 58, resetsAt: new Date(31 * 3_600_000).toISOString() },
  ],
}
const TURN = { input: 50, output: 3_000, cacheRead: 900, cacheWrite: 50 }

const usage = (cached: number) => ({
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: cached,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
})

const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }
const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 140 } as never,
} as const

function setup(on: On, cached = 1000) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const toasts: string[] = []
  const written: Record<string, unknown> = {}
  on('state.set', ($, e, next) => {
    if (e.plugin === 'usage-band') written[e.key] = e.value
    return next(e)
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('env.get', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { context: { tokens: 0, window: 1_000_000, percent: 0 }, rateLimits: [] } }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* ($, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage: usage(cached) }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(cached) }
  })
  return { clock, toasts, written }
}

async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId })
  for await (const chunk of stream) void chunk
  return stream.result
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

test('formats tokens, countdowns and hit rate', async () => {
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(15_600)).toBe('15.6K')
  expect(fmtTokens(100_000)).toBe('100K')
  expect(fmtTokens(1_000_000)).toBe('1M')
  expect(fmtLeft((2 * 60 + 40) * 60_000)).toBe('2h40m')
  expect(fmtLeft(31 * 60 * 60_000)).toBe('1d7h')
  expect(fmtCountdown(59 * 60_000 + 42_000)).toBe('60m')
  expect(fmtCountdown(61_000)).toBe('2m')
  expect(fmtCountdown(30_000)).toBe('30s')
  expect(hitRate({ input: 50, output: 10, cacheRead: 900, cacheWrite: 50 })).toBe(90)
  expect(hitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(null)
})

test('the cache item joins the hit rate with the countdown and changes color as it runs out', async () => {
  const cacheAt = (at: number, cold: string | null = null) => {
    const items = buildItems(null, TURN, { lastAt: cold ? 0 : 1, cold }, '1h', at)
    const item = items[0]!
    return [item.value, item.detail, item.color]
  }
  expect(cacheAt(18_000)).toEqual(['90%', '60m', '#72cf9f'])
  expect(cacheAt(56 * 60_000 + 1)).toEqual(['90%', '4m', '#e8a25f'])
  expect(cacheAt(59 * 60_000 + 30_001)).toEqual(['90%', '30s', '#e5685f'])
  expect(cacheAt(60 * 60_000 + 1)).toEqual(['90%', 'cold', '#8b8f97'])
  expect(cacheAt(0, 'compacted')).toEqual(['90%', 'cold', '#8b8f97'])
  // No cached request and no turn yet: nothing to show
  expect(buildItems(null, null, IDLE, '1h', 0)).toEqual([])
})

test('a draining cache meter alone does not change the picture key', async () => {
  const entry = { lastAt: 1, cold: null }
  const a = itemsKey(buildItems(MEASURE, TURN, entry, '1h', 60_001))
  const b = itemsKey(buildItems(MEASURE, TURN, entry, '1h', 61_000))
  const c = itemsKey(buildItems(MEASURE, TURN, entry, '1h', 5 * 60_000))
  expect(a).toBe(b)
  expect(a === c).toBe(false)
})

test('the terminal line steps down to fit narrow terminals', async () => {
  const items = buildItems(MEASURE, TURN, { lastAt: 1, cold: null }, '1h', 1)
  const look = { style: 'unicode', colors: 'true' } as const
  const wide = fitTerminal(items, 140, 0, look)
  const narrow = fitTerminal(items, 50, 0, look)
  expect(wide.some(s => s.text === ' · 2h40m')).toBe(true)
  expect(narrow.some(s => s.text === ' · 2h40m')).toBe(false)
  expect(narrow.some(s => s.text === '60m')).toBe(true)
  expect(width(narrow)).toBeLessThan(50)
})

test('the bar highlight keeps the bar width', async () => {
  for (const frame of [0, 3, 7, 20]) expect(width(bar(50, 8, '#5cc4d6', frame))).toBe(8)
})

test('icon style and 256-color helpers', async () => {
  expect(detectStyle('auto', 'ghostty')).toBe('nerd')
  expect(detectStyle('auto', 'Apple_Terminal')).toBe('unicode')
  expect(detectStyle('ascii', 'ghostty')).toBe('ascii')
  expect(to256('#5cc4d6')).toBe('#5fd7d7')
})

test('the desktop SVG draws one pill per item and drains the cache pill', async () => {
  const items = buildItems(MEASURE, TURN, { lastAt: 1, cold: null }, '1h', 60_000)
  const { svg } = desktopSvg(items)
  expect(svg.match(/class="pill"/g)?.length).toBe(4)
  expect(svg.match(/<animate /g)?.length).toBe(1)
})

test('band shows limits, context, hit rate and the cache countdown on desktop and terminal', async ($, on) => {
  setup(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }))
  await start($)
  await $.session.measure({
    context: { tokens: 100_000, window: 1_000_000, percent: 10 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 20 },
      { kind: 'seven_day', percentUsed: 58 },
    ],
    changed: ['context', 'rateLimits'],
  })
  await step($)
  await $.turn.complete({
    answer: 'ok',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { ...usage(900), input_tokens: 50, cache_creation_input_tokens: 50 },
  })

  const desk = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', ...BAND })
  const svg = await desk.find({ type: 'Svg' })
  expect(svg?.props.alt).toBe(
    '5-hour limit 20% used, 7-day limit 58% used, context 100K of 1M, cache hit 90%, cache expires in 60m',
  )
  expect(String(svg?.props.source)).toContain('<animate')
  await desk.unmount()

  const term = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', ...BAND })
  expect(await term.find({ type: 'Text', text: /^20%$/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '/1M' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '90%' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '60m' })).toBeDefined()
  await term.unmount()

  // VS Code draws one image per pill so a narrow side bar can wrap them
  const code = await $.ui.mount({ plugin: 'usage-band', surface: 'vscode', ...BAND })
  const pills = await code.findAll({ type: 'Svg' })
  expect(pills.map(pill => pill.props.alt)).toEqual([
    '5-hour limit 20% used',
    '7-day limit 58% used',
    'context 100K of 1M',
    'cache hit 90%, cache expires in 60m',
  ])
  expect(await code.find({ type: 'Text' })).toBeUndefined()
  await code.unmount()
})

test('records when the cached request was sent', async ($, on) => {
  const { clock, written } = setup(on)
  await start($)
  await step($)
  expect(written.cache).toEqual({ lastAt: 1_000_000, cold: null })
  await clock.advance(5000)
  await step($)
  expect(written.cache).toEqual({ lastAt: 1_005_000, cold: null })
})

test('a subagent step or an uncached step does not reset the timer', async ($, on) => {
  const { written } = setup(on, 0)
  await start($)
  await step($)
  await step($, 'agent-1')
  expect(written.cache).toBeUndefined()
})

test('warns at five minutes and one minute left on a 1h TTL', async ($, on) => {
  const { clock, toasts } = setup(on)
  await start($)
  await step($)
  await clock.advance(55 * 60_000)
  await clock.advance(4 * 60_000)
  expect(toasts).toEqual(['Prompt cache expires in 5:00', 'Prompt cache expires in 1:00'])
})

test('/cache-ttl sets the TTL and reports state', async ($, on) => {
  const { written } = setup(on)
  await start($)
  await step($)
  const set = await $.command.run({ command: 'cache-ttl', args: '5m', ...RUN })
  expect(set.text).toBe('Cache timer TTL set to 5m.')
  expect(written.ttl).toBe('5m')
  const shown = await $.command.run({ command: 'cache-ttl', args: '', ...RUN })
  expect(shown.text).toMatch(/^TTL 5m, last cached request sent at \d\d:\d\d:\d\d, 5:00 left\.$/)
})

test('a main-thread compaction marks the cache cold, a precompute does not', async ($, on) => {
  const { written } = setup(on)
  const kept = [{ role: 'user' as const, text: 'summary', toolUses: [] }]
  on('session.compact', () => ({ messages: kept }) as never)
  await start($)
  await step($)
  await $.session.compact({ trigger: 'precompute', messages: kept } as never)
  expect((written.cache as { cold: string | null }).cold).toBe(null)
  await $.session.compact({ trigger: 'auto', messages: kept } as never)
  expect(written.cache).toEqual({ lastAt: 0, cold: 'compacted' })
})
