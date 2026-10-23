import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

import { DEMO } from './demo'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const reply = (text: string, columns = 100) =>
  ({
    plugin: 'decorated',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true },
    viewport: { columns, rows: 40, isFullscreen: true },
  }) as const

test('a reply with no markup is left to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...reply('Plain **markdown**, `<ok>` in code and Array<string>.'), surface })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }
})

test('inline markup draws as styled runs beside the markdown around it', async $ => {
  const text = 'Intro paragraph.\n\nBuild is <ok>green</ok>, press <kbd>Ctrl+O</kbd>.\n\nOutro.'
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...reply(text), surface })
    const markdown = await ui.findAll({ type: 'Markdown' })
    expect(markdown.map(m => m.props.text)).toEqual(['Intro paragraph.', 'Outro.'])
    // A Text is found by its words, the row's own included: read the runs under it.
    const row = await ui.find({ type: 'Text', text: /green/ })
    expect(row?.text).toBe('Build is green, press  Ctrl+O .')
    const runs = (row?.children ?? []) as Array<{ props?: Record<string, unknown>; children?: unknown[] }>
    expect(runs.find(r => r.children?.[0] === 'green')?.props?.color).toBe('success')
    expect(runs.find(r => r.children?.[0] === ' Ctrl+O ')?.props?.inverse).toBe(true)
    await ui.unmount()
  }
})

test('warn is colored on the VS Code panel, whose warning key draws as plain text', async $ => {
  const text = 'Build is <ok>green</ok>, <warn>one flaky</warn>.\n\n<callout tone="warn">careful</callout>'
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...reply(text), surface })
    const row = await ui.find({ type: 'Text', text: /flaky/ })
    const runs = (row?.children ?? []) as Array<{ props?: Record<string, unknown>; children?: unknown[] }>
    const border = (await ui.findAll({ type: 'Box' })).find(b => b.props.borderStyle === 'round')
    const expected = surface === 'vscode' ? 'yellow' : 'warning'
    expect(runs.find(r => r.children?.[0] === 'one flaky')?.props?.color).toBe(expected)
    expect(runs.find(r => r.children?.[0] === 'green')?.props?.color).toBe('success')
    expect(border?.props.borderColor).toBe(expected)
    await ui.unmount()
  }
})

test('the whole demo draws on every surface, at a wide and a narrow width', async $ => {
  for (const surface of SURFACES) {
    for (const columns of [120, 50]) {
      const ui = await $.ui.mount({ ...reply(DEMO, columns), surface })
      expect(await ui.find({ type: 'Text', text: /mint session/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /parse\.ts/ })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('marks are glyphs every terminal font draws as text', async $ => {
  // ✔ and ✖ draw as color emoji in Windows Terminal and Ghostty; conhost's
  // fonts have no ◐, ⊘, ▶, ◀, ↺ or ⇠.
  const MISDRAWN = /[✔✖◐⊘▶◀↺⇠]/u
  const tones = ['note', 'info', 'tip', 'ok', 'warn', 'err'].map(t => `<callout tone="${t}">${t}</callout>`)
  const text = [
    '<steps>\n[x] a\n[ ] b\n[~] c\n[>] d\n[!] e\n[-] f\n[?] g\n</steps>',
    ...tones,
    '<flow>\na -> b -> c\nc -> a\n</flow>',
    '<flow>\na -> b\n</flow>',
    '<seq>\nA -> B: hi\nB --> A: ok\nA -> A: self\n</seq>',
  ].join('\n\n')
  for (const columns of [120, 12]) {
    const ui = await $.ui.mount({ ...reply(text, columns), surface: 'terminal' })
    const drawn = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(drawn).toContain('✓')
    expect(drawn.match(MISDRAWN)).toBeNull()
    await ui.unmount()
  }
})

test('off the terminal, arrowheads are one cell and the banner is a whole border', async $ => {
  const text = '<banner sub="sub">hi</banner>\n\n<seq>\nA -> B: hi\nB --> A: ok\n</seq>\n\n<bars>\na: 10 -> 4\n</bars>\n\n<flow>\na -> b, c\n</flow>'
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...reply(text), surface })
    const drawn = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    const boxed = (await ui.findAll({ type: 'Box' })).some(b => b.props.borderStyle === 'round')
    if (surface === 'terminal') {
      expect(drawn).toMatch(/►/)
      expect(drawn).toMatch(/░/)
      expect(drawn).toMatch(/╭─/)
      expect(boxed).toBe(false)
    } else {
      expect(drawn.match(/[►◄▼░]/u)).toBeNull()
      expect(drawn).toMatch(/─>│/)
      expect(drawn).toMatch(/·/)
      expect(drawn).toMatch(/H I/)
      expect(boxed).toBe(true)
    }
    await ui.unmount()
  }
})

test('a block still streaming draws what it has so far', async $ => {
  const ui = await $.ui.mount({ ...reply('<steps>\n[x] One\n[ ] Tw'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Tw' })).toBeDefined()
  await ui.unmount()
})

test('/decorated prints the demo and draws it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'decorated' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ran = await $.command.run({
    command: 'decorated',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 100 },
  })
  expect(ran.text).toBe(DEMO)

  const ui = await $.ui.mount({
    plugin: 'decorated',
    surface: 'terminal',
    component: 'CommandOutput',
    // As a session hands it over: headed by the plugin's name on the first line.
    props: { command: 'decorated', args: '', text: `decorated: ${DEMO}`, isErrored: false },
    viewport: { columns: 100, rows: 40 },
  })
  expect(await ui.find({ type: 'Text', text: /mint session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /D E C O R A T E D/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /<banner/ })).toBeUndefined()
  await ui.unmount()
})

const SLIDE =
  '<svg viewBox="0 0 20 8" cols="20">\n<rect width="4" height="4" fill="#f00"><animate attributeName="x" from="0" to="16" dur="1s" fill="freeze"/></rect>\n</svg>'
const AT_START = /^████$/
const HALF_WAY = /^ {8}████$/
const AT_END = /^ {16}████$/
// A row whose rect has slid off the start (the rect alone is a Text of its own).
const MOVED = /^ +████$/

const playing = (onScreen: { first: number; last: number; of: number } | null, isFullscreen = true, text = SLIDE) =>
  ({
    plugin: 'decorated',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: true, onScreen },
    viewport: { columns: 100, rows: 40, isFullscreen },
  }) as const

test('an animated svg plays in a fullscreen reply on screen, then rests', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'decorated' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(playing({ first: 0, last: 3, of: 4 }))
  expect(await ui.find({ type: 'Text', text: AT_START })).toBeDefined()
  await clock.advance(500)
  expect(await ui.find({ type: 'Text', text: HALF_WAY })).toBeDefined()
  await clock.advance(1000)
  expect(await ui.find({ type: 'Text', text: AT_END })).toBeDefined()
  await ui.unmount()
})

test('off screen or on the main screen it draws its still', async $ => {
  for (const props of [playing(null), playing({ first: 0, last: 3, of: 4 }, false)]) {
    const ui = await $.ui.mount(props)
    expect(await ui.find({ type: 'Text', text: AT_END })).toBeDefined()
    await ui.unmount()
  }
})

test('a surface that draws SVG gets the markup, interactive when it animates', async $ => {
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...reply(`Look:\n\n${SLIDE}`), surface })
    const drawn = await ui.find({ type: 'Svg' })
    expect(drawn?.props.source).toContain('<animate attributeName="x"')
    expect(drawn?.props.isInteractive).toBe(true)
    await ui.unmount()
  }
})

// A rect sliding across and back to the start each second, without end.
const LOOP = (fill: string) =>
  `<svg viewBox="0 0 20 8" cols="20">
<rect width="4" height="4" fill="${fill}"><animate attributeName="x" from="0" to="16" dur="1s" repeatCount="indefinite"/></rect>
</svg>`
const SHOWN = { first: 0, last: 3, of: 4 }

const started = async ($: Engine, on: On, now: number) => {
  const clock = mock.clock(on, { now })
  on('command.register', () => ({ value: { command: 'decorated' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  return clock
}

test('an endless loop plays on while it is the newest', async ($, on) => {
  const clock = await started($, on, 2_000_000)
  const ui = await $.ui.mount(playing(SHOWN, true, LOOP('#f00')))
  await clock.advance(61_500)
  expect(await ui.find({ type: 'Text', text: HALF_WAY })).toBeDefined()
  await ui.unmount()
})

test('a newer reply’s loop rests the older one on its still', async ($, on) => {
  const clock = await started($, on, 3_000_000)
  const older = await $.ui.mount(playing(SHOWN, true, LOOP('#0f0')))
  await clock.advance(300)
  const newer = await $.ui.mount(playing(SHOWN, true, LOOP('#00f')))
  await clock.advance(500)
  expect(await newer.find({ type: 'Text', text: HALF_WAY })).toBeDefined()
  // Its still: the rect back at the start, no row of it slid along.
  expect(await older.find({ type: 'Text', text: AT_START })).toBeDefined()
  expect(await older.find({ type: 'Text', text: MOVED })).toBeUndefined()
  await newer.unmount()
  await older.unmount()
})

test('loops in one reply play together', async ($, on) => {
  const clock = await started($, on, 4_000_000)
  const ui = await $.ui.mount(playing(SHOWN, true, `${LOOP('#ff0')}

${LOOP('#0ff')}`))
  await clock.advance(500)
  // Two rows of each rect.
  expect((await ui.findAll({ type: 'Text', text: HALF_WAY })).length).toBe(4)
  await ui.unmount()
})

test('a loop scrolled out of view rests, and the ticker falls quiet', async ($, on) => {
  let frames = 0
  on('state.set', (_, e, next) => {
    frames += 1

    return next(e)
  })
  const clock = await started($, on, 6_000_000)
  const shown = playing(SHOWN, true, LOOP('#fa0'))
  const ui = await $.ui.mount(shown)
  await clock.advance(300)
  expect(frames).toBeGreaterThan(0)
  // Still mounted, but the viewport has left it.
  await ui.redraw({ ...shown.props, onScreen: null })
  expect(await ui.find({ type: 'Text', text: AT_START })).toBeDefined()
  await clock.advance(3000)
  const quiet = frames
  await clock.advance(1000)
  expect(frames).toBe(quiet)
  await ui.unmount()
})

test('callouts nested past 8 deep show the rest as markdown', async $ => {
  const text = '<callout>\n'.repeat(3000) + 'core\n' + '</callout>\n'.repeat(3000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...reply(text), surface })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.filter(b => b.props.borderStyle === 'round')).toHaveLength(8)
    expect((await ui.findAll({ type: 'Markdown' })).some(m => String(m.props.text).startsWith('<callout>'))).toBe(true)
    await ui.unmount()
  }
})

test('the ticker falls quiet once nothing plays', async ($, on) => {
  let frames = 0
  on('state.set', (_, e, next) => {
    frames += 1

    return next(e)
  })
  const clock = await started($, on, 5_000_000)
  const ui = await $.ui.mount(playing(SHOWN, true, LOOP('#f0f')))
  await clock.advance(300)
  expect(frames).toBeGreaterThan(0)
  await ui.unmount()
  await clock.advance(3000)
  const quiet = frames
  await clock.advance(1000)
  expect(frames).toBe(quiet)
})
