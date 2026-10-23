import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { DEMO } from './demo'
import { type Clock, drawBlocks, kitFor } from './draw'
import { LEVELS, type Level, guideFor } from './guide'
import { BLOCK_TAGS, INLINE_TAGS, hasMarkup, parseBlocks } from './parse'
import { animation } from './svg'

// The reply's bullet takes two columns; one more keeps wide drawings off the edge.
const GUTTER = 3

// ── the guide ───────────────────────────────────────────────────────────
// The tags are taught by a section of the system prompt, in every session a
// surface draws. `/decorated off` stops the teaching, in this session and
// the next; replies already in the transcript keep their drawing.
// `/decorated low|medium|high` sets how much the guide asks Claude to
// decorate, kept the same way.

const SECTION = 'decorated:guide'
// Renders whose replies no one sees drawn: a headless run, the one-line
// prompt, a teammate's copy of its lead's prompt.
const UNDRAWN = new Set(['print', 'bare', 'teammate'])
const TEACH_KEY = 'teach'
const LEVEL_KEY = 'level'

type Store = { store: { get: (key: string) => Promise<unknown> } }

// Whether the person left the teaching on.
async function isTeaching($: Store): Promise<boolean> {
  return (await $.store.get(TEACH_KEY)) !== false
}

const isLevel = (value: unknown): value is Level => LEVELS.includes(value as Level)

// The level the person set; medium where they set none.
async function levelOf($: Store): Promise<Level> {
  const level = await $.store.get(LEVEL_KEY)

  return isLevel(level) ? level : 'medium'
}

// The oldest build that draws decorated's trees: up to 2.1.296 the engine
// refuses Text's `mono`, and a reply there would show its tags raw.
const FLOOR = [2, 1, 299] as const
const TOO_OLD = `decorated is off: it needs Claude Code ${FLOOR.join('.')} or later`

// Whether the engine is older than FLOOR. One that cannot say is; a build
// not spelled as a release is taken to be new enough.
async function isTooOld($: { session: { version: () => Promise<{ base?: string }> } }): Promise<boolean> {
  let base: string | undefined
  try {
    base = (await $.session.version()).base
  } catch {
    return true
  }
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(base ?? '')?.slice(1).map(Number)
  if (!parts) return false
  for (const [i, floor] of FLOOR.entries()) if (parts[i] !== floor) return parts[i]! < floor

  return false
}

const SWITCHED = {
  on: 'Tags on: Claude is taught them again from the next request.',
  off: 'Tags off: Claude is no longer taught them, from the next request. Replies already drawn keep their drawing.',
}
const LEVELLED: Record<Level, string> = {
  low: 'Level low: Claude is taught to decorate lightly, from the next request.',
  medium: 'Level medium: Claude is taught to decorate where a tag shows more than prose, from the next request.',
  high: 'Level high: Claude is taught to draw a block whenever a reply has a shape, from the next request.',
}
const UNCACHED = ' The system prompt changes, so that request is not served from the prompt cache.'
const STILL_OFF = ' Tags are off; `/decorated on` teaches them again.'

// ── another reply mod ───────────────────────────────────────────────────
// The tag names stay bare. Where another plugin's section of the prompt
// teaches tags of the same names, decorated steps aside: it teaches nothing
// and leaves the replies to that mod's drawing, so Claude learns one set of
// tags and one mod draws them.

const OUR_TAG = new RegExp(`<(${[...INLINE_TAGS, ...BLOCK_TAGS].join('|')})[\\s/>]`, 'g')
// Two of our names taught as tags make a guide to the same tags, not a mention.
const SHARED_ENOUGH = 2

// The plugin whose section teaches our tags, if one does.
function rivalIn(sections: readonly { id: string; text: string }[]): string | undefined {
  for (const { id, text } of sections) {
    const owner = /^([^:]+):/.exec(id)?.[1]
    if (!owner || owner === 'decorated') continue
    const shared = new Set([...text.matchAll(OUR_TAG)].map(m => m[1]))
    if (shared.size >= SHARED_ENOUGH) return owner
  }

  return undefined
}

// The plugin decorated last stepped aside for; the reply hook reads it.
let yieldedTo: string | undefined
// What the status line last said.
let shownStatus: string | undefined

// ── animation ───────────────────────────────────────────────────────────
// An animated <svg> plays where a reply is drawn again in place: the
// terminal's fullscreen layout, while the viewport shows it. Each frame is a
// write of `tick`, which redraws only the replies that read it. A playing
// drawing marks itself at every frame it draws and the ticker writes only
// while a mark is fresh, so a drawing scrolled away or cleared stops it by
// itself. A finite animation plays to its end; endless loops play on, but
// only the newest reply's: an older one rests on its still.

const tick = atom({ plugin: 'decorated', key: 'tick' } as const, 0)
const FRAME_MS = 100
// A drawing that has drawn no frame for this long is no longer playing.
const STALE_MS = 2000

// Module state, so a reload replays what is on screen. A drawing (by its
// markup) → when it was first drawn whole; a looping drawing → its group,
// the start of the first loop drawn in its reply; a playing drawing → when
// it last drew a frame.
const begun = new Map<string, number>()
const loopGroup = new Map<string, number>()
let newestGroup = -Infinity
const playing = new Map<string, number>()

// The value `key` holds, set to `value` the first time it is asked.
function remember(map: Map<string, number>, key: string, value: number): number {
  const known = map.get(key)
  if (known !== undefined) return known
  map.set(key, value)
  if (map.size > 256) map.delete(map.keys().next().value!)

  return value
}

function canAnimate(e: { surface: string; viewport?: { isFullscreen?: boolean }; props: object }): boolean {
  return e.surface === 'terminal' && e.viewport?.isFullscreen === true && (e.props as { onScreen?: unknown }).onScreen !== null
}

// A clock for one reply's drawing pass, and whether anything it timed plays.
function player(now: number): { clock: Clock; isPlaying: () => boolean } {
  let isPlaying = false
  // The reply's loops share the group of the first one drawn.
  let group: number | undefined
  const clock: Clock = (body, attrs) => {
    const info = animation(body)
    if (!info) return undefined
    const key = JSON.stringify([body, attrs])
    const start = remember(begun, key, now)
    if (info.endMs === Infinity) {
      group ??= loopGroup.get(key) ?? start
      newestGroup = Math.max(newestGroup, remember(loopGroup, key, group))
      if (loopGroup.get(key) !== newestGroup) return undefined
    } else if (now >= start + info.endMs) return undefined
    playing.set(key, now)
    isPlaying = true

    return (now - start) / 1000
  }

  return { clock, isPlaying: () => isPlaying }
}

// A player at the time now; none where the clock cannot be read, so the
// drawing rests on its still rather than the reply going undrawn.
async function playerNow($: { clock: { now: () => Promise<number> } }): Promise<ReturnType<typeof player> | undefined> {
  try {
    return player(await $.clock.now())
  } catch {
    return undefined
  }
}

const ANIMATES = /<(?:animate|set|animateTransform|animateMotion|animateColor)[\s/>]/

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'decorated',
      description: 'Show every markup decorated draws; on or off turns the teaching of its tags, low, medium or high sets how much',
      argumentHint: '[on|off|low|medium|high]',
    })
    // Each frame redraws the replies that read `tick`; the write after a
    // play ends lets its reply draw the still and stop reading.
    $.clock.every(FRAME_MS, () => {
      if (playing.size === 0) return
      void (async () => {
        const now = await $.clock.now()
        for (const [key, drawn] of playing) if (now - drawn > STALE_MS) playing.delete(key)
        if (playing.size > 0) await update($, tick, () => now)
      })()
    })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.surfaces.length === 0 || e.traits.some(t => UNDRAWN.has(t))) return composed
    const tooOld = await isTooOld($)
    // Composed again through every other plugin, to see one above decorated too.
    const rival = tooOld
      ? undefined
      : (rivalIn(composed.sections) ?? rivalIn((await $.prompt.compose(e).catch(() => composed)).sections))
    yieldedTo = rival
    const status = tooOld ? TOO_OLD : rival && `decorated steps aside: ${rival} teaches tags of the same names`
    if (status !== shownStatus) {
      shownStatus = status
      $.ui.status(status)
    }
    if (tooOld || rival || !(await isTeaching($))) return composed

    return { sections: [...composed.sections, { id: SECTION, text: guideFor(await levelOf($)), scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'decorated' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      const was = await isTeaching($)
      const teaching = arg === 'on'
      await $.store.set(TEACH_KEY, teaching)

      return {
        text: SWITCHED[arg] + (was === teaching ? '' : UNCACHED),
        context: [`The person turned decorated's tags ${arg}; nothing to act on.`],
      }
    }
    if (isLevel(arg)) {
      const was = await levelOf($)
      await $.store.set(LEVEL_KEY, arg)
      const teaching = await isTeaching($)

      return {
        text: LEVELLED[arg] + (teaching && was !== arg ? UNCACHED : '') + (teaching ? '' : STILL_OFF),
        context: [`The person set decorated's level to ${arg}; nothing to act on.`],
      }
    }

    return {
      text: DEMO,
      context: ['That was a rendering demo of the decorated mod; nothing to act on.'],
    }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'decorated' } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const T = $.ui.resolve(e)
    const { Box, Text } = T
    const avail = (e.viewport?.columns ?? 80) - GUTTER
    // The engine heads a plugin's output with its name on the first line,
    // which would hide a block tag opening that line: draw the name apart.
    const label = /^([\w-]+):[ \t]*/.exec(e.props.text)
    const text = label ? e.props.text.slice(label[0].length) : e.props.text
    const play = canAnimate(e) && ANIMATES.test(text) ? await playerNow($) : undefined
    const drawn = drawBlocks(kitFor(T, e.surface), parseBlocks(text), avail, play?.clock)
    if (play?.isPlaying()) await read($, tick)

    return (
      <Box flexDirection="column" gap={1}>
        {label && <Text dimColor>{label[1]}</Text>}
        {drawn}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (yieldedTo || e.props.isSummary || !hasMarkup(e.props.text)) return next(e)
    // The plugins beneath still see the reply, for what they do besides
    // drawing it (one records where replies are); their drawing gives way to
    // decorated's. A rewrite of the text beneath does not reach it.
    await next(e).catch(() => undefined)
    const T = $.ui.resolve(e)
    const { Box, Text } = T
    const avail = (e.viewport?.columns ?? 80) - GUTTER
    const play = canAnimate(e) && ANIMATES.test(e.props.text) ? await playerNow($) : undefined
    const body = (
      <Box flexDirection="column" gap={1}>
        {drawBlocks(kitFor(T, e.surface), parseBlocks(e.props.text), avail, play?.clock)}
      </Box>
    )
    // Read after drawing, so only a reply with something playing subscribes.
    if (play?.isPlaying()) await read($, tick)
    if (e.surface !== 'terminal') return body

    return (
      <Box flexDirection="row">
        <Box minWidth={2} flexShrink={0}>
          <Text>{e.props.isFirstOfReply ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {body}
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
