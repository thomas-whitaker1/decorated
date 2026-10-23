import type { On, PromptComposeArgs, Register } from 'claude-code'
import { type Engine, type PluginTier, expect, mock, test } from 'claude-code/testing'

import { LEVELS, guideFor } from './guide'
import { BLOCK_TAGS, INLINE_TAGS } from './parse'

// The engine beneath every plugin: its own composition, its version, its
// drawing of a reply, and the status line, whose texts it keeps.
const engine = (on: On, version = '2.1.309') => {
  const statuses: Array<string | undefined> = []
  on('session.version', () => ({ value: { version, base: version } }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return statuses
}

const FACTS = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: [],
  outputStyle: null,
  traits: [],
} as const

const ids = async ($: Engine, facts: PromptComposeArgs = {}) =>
  (await $.prompt.compose({ ...FACTS, ...facts })).sections.map(s => s.id)

const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'decorated',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 100 },
  })

test('the guide is the last section of the prompt where a surface draws', async ($, on) => {
  mock.store(on)
  engine(on)
  const { sections } = await $.prompt.compose(FACTS)
  expect(sections.map(s => s.id)).toEqual(['intro', 'decorated:guide'])
  expect(sections[1]).toEqual({ id: 'decorated:guide', text: guideFor('medium'), scope: 'session' })
})

// The guide is sent with every request: about 860 tokens at 1,845 characters.
const GUIDE_BUDGET = 2000

for (const level of LEVELS)
  test(`the ${level} guide teaches only tags decorated draws, within its budget`, () => {
    const guide = guideFor(level)
    // `<text>` is SVG's own element, set inside an `<svg>`.
    const named = new Set([...guide.matchAll(/<([a-z]+)[\s/>]/g)].map(m => m[1]).filter(name => name !== 'text'))
    expect([...named].filter(name => !INLINE_TAGS.has(name ?? '') && !BLOCK_TAGS.has(name ?? ''))).toEqual([])
    expect(guide.length).toBeLessThanOrEqual(GUIDE_BUDGET)
  })

test('the levels differ only in how much they ask for', () => {
  const [low, medium, high] = LEVELS.map(guideFor)
  expect(new Set([low, medium, high]).size).toBe(3)
  // Everything after the first paragraph, the tag reference, is shared.
  const reference = (guide: string) => guide.split('\n\n').slice(2).join('\n\n')
  expect(reference(low!)).toBe(reference(medium!))
  expect(reference(high!)).toBe(reference(medium!))
})

const guideText = async ($: Engine) => (await $.prompt.compose(FACTS)).sections.find(s => s.id === 'decorated:guide')?.text

test('/decorated low|medium|high teaches that level, and says so', async ($, on) => {
  on('command.register', () => ({ value: { command: 'decorated' } }))
  mock.store(on)
  engine(on)

  const high = await run($, 'high')
  expect(high.text).toContain('Level high')
  expect(high.text).toContain('prompt cache')
  expect(await guideText($)).toBe(guideFor('high'))

  // The same level again changes nothing, so no word of the cache.
  expect((await run($, ' HIGH ')).text).not.toContain('prompt cache')

  await run($, 'low')
  expect(await guideText($)).toBe(guideFor('low'))
  await run($, 'medium')
  expect(await guideText($)).toBe(guideFor('medium'))
})

test('a level set while the tags are off is kept for when they are on', async ($, on) => {
  on('command.register', () => ({ value: { command: 'decorated' } }))
  mock.store(on)
  engine(on)

  await run($, 'off')
  const low = await run($, 'low')
  expect(low.text).toContain('/decorated on')
  expect(low.text).not.toContain('prompt cache')
  expect(await ids($)).toEqual(['intro'])

  await run($, 'on')
  expect(await guideText($)).toBe(guideFor('low'))
})

test('the level holds in the next session', async ($, on) => {
  mock.store(on, { level: 'high' })
  engine(on)
  expect(await guideText($)).toBe(guideFor('high'))
})

test('a stored level decorated does not know teaches medium', async ($, on) => {
  mock.store(on, { level: 'loud' })
  engine(on)
  expect(await guideText($)).toBe(guideFor('medium'))
})

test('no guide where no one sees the replies drawn', async ($, on) => {
  mock.store(on)
  engine(on)
  for (const facts of [
    { traits: ['print'] },
    { traits: ['bare'] },
    { traits: ['teammate'] },
    { surfaces: [] },
  ] as const)
    expect(await ids($, facts)).toEqual(['intro'])
})

test('/decorated off stops the teaching and /decorated on brings it back', async ($, on) => {
  on('command.register', () => ({ value: { command: 'decorated' } }))
  mock.store(on)
  engine(on)

  const off = await run($, 'off')
  expect(off.text).toContain('Tags off')
  expect(off.text).toContain('prompt cache')
  expect(await ids($)).toEqual(['intro'])

  // Off again changes nothing, so no word of the cache.
  expect((await run($, ' OFF ')).text).not.toContain('prompt cache')

  await run($, 'on')
  expect(await ids($)).toEqual(['intro', 'decorated:guide'])
})

test('off holds in the next session', async ($, on) => {
  // What an earlier session stored.
  mock.store(on, { teach: false })
  engine(on)
  expect(await ids($)).toEqual(['intro'])
})

// Another reply mod, teaching tags of the same names as cc-crayon does, until
// `/crayon off`. An inline plugin loads on its own, so its register holds
// everything it uses.
const crayon: Register = on => {
  let isTeaching = true
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!isTeaching) return composed
    const text = 'Color words with <ok>done</ok>, <warn>careful</warn> and <muted>aside</muted>; <badge ok>PASS</badge>.'

    return { sections: [...composed.sections, { id: 'crayon:tags', text, scope: 'session' as const }] }
  })
  on('command.run', { command: 'crayon' }, () => {
    isTeaching = false

    return { text: 'off' }
  })
}

const rival = (tier: PluginTier) => ({ name: 'crayon', tier, register: crayon })

// One that names a tag of ours in passing.
const keys: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)

    return { sections: [...sections, { id: 'keys:hint', text: 'Wrap keys in <kbd>.', scope: 'session' as const }] }
  })
}

const mention = { name: 'keys', tier: 'append', register: keys } as const

const reply = {
  plugin: 'decorated',
  surface: 'terminal',
  component: 'AssistantMessage',
  props: { text: 'Build is <ok>green</ok>.', isFirstOfReply: true },
  viewport: { columns: 100, rows: 40 },
} as const

const drawnBy = async ($: Engine) => {
  const ui = await $.ui.mount(reply)
  const engineDrew = (await ui.find({ type: 'Text', text: 'engine' })) !== undefined
  await ui.unmount()

  return engineDrew ? 'engine' : 'decorated'
}

for (const tier of ['prepend', 'append'] as const)
  test(`a mod teaching the same tags, ${tier === 'prepend' ? 'above' : 'beneath'} decorated, has it step aside`, { plugins: [rival(tier)] }, async ($, on) => {
    mock.store(on)
    const statuses = engine(on)
    expect(await ids($)).not.toContain('decorated:guide')
    expect(await ids($)).toContain('crayon:tags')
    expect(statuses).toEqual(['decorated steps aside: crayon teaches tags of the same names'])
    // The reply is left to what draws beneath.
    expect(await drawnBy($)).toBe('engine')
  })

test('a mod that names one of the tags in passing is no rival', { plugins: [mention] }, async ($, on) => {
  mock.store(on)
  engine(on)
  expect(await ids($)).toEqual(['intro', 'keys:hint', 'decorated:guide'])
  expect(await drawnBy($)).toBe('decorated')
})

test('once the other mod stops teaching, decorated teaches and draws again', { plugins: [rival('append')] }, async ($, on) => {
  mock.store(on)
  const statuses = engine(on)
  expect(await ids($)).toEqual(['intro', 'crayon:tags'])
  expect(await drawnBy($)).toBe('engine')

  await $.command.run({
    command: 'crayon',
    args: 'off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 100 },
  })
  expect(await ids($)).toEqual(['intro', 'decorated:guide'])
  expect(statuses.at(-1)).toBeUndefined()
  expect(statuses).toHaveLength(2)
  expect(await drawnBy($)).toBe('decorated')
})

test('below 2.1.299 nothing is taught, and the status line says why', async ($, on) => {
  mock.store(on)
  const statuses = engine(on, '2.1.296')
  expect(await ids($)).toEqual(['intro'])
  expect(await ids($)).toEqual(['intro'])
  expect(statuses).toEqual(['decorated is off: it needs Claude Code 2.1.299 or later'])
})

for (const version of ['2.1.299', '2.1.300-dev', '2.2.0', '3.0.1'])
  test(`on ${version} the guide is taught`, async ($, on) => {
    mock.store(on)
    const statuses = engine(on, version)
    expect(await ids($)).toEqual(['intro', 'decorated:guide'])
    expect(statuses).toEqual([])
  })

test('an engine that cannot say its version is taken to be too old', async ($, on) => {
  mock.store(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  on('ui.status', () => ({ value: undefined }))
  expect(await ids($)).toEqual(['intro'])
})
