import { expect, test } from 'claude-code/testing'

import { hasMarkup, parseBlocks, rich, richRows } from './parse'
import { bars, flow, seq, steps, tree } from './widgets'

const plain = (runs: ReadonlyArray<{ text: string }>) => runs.map(r => r.text).join('')

test('only known tags outside code are markup', () => {
  expect(hasMarkup('Array<string> and <div> stay text')).toBe(false)
  expect(hasMarkup('write `<ok>` to color')).toBe(false)
  expect(hasMarkup('```\n<flow>\na -> b\n</flow>\n```')).toBe(false)
  expect(hasMarkup('now <ok>green</ok>')).toBe(true)
  expect(hasMarkup('<steps>\n[x] a\n</steps>')).toBe(true)
})

test('a fence holding a block tag stays markdown', () => {
  const text = 'Before\n\n```xml\n<flow>\na -> b\n</flow>\n```\n\n<rule>After</rule>'
  const blocks = parseBlocks(text)
  expect(blocks.map(b => b.kind)).toEqual(['md', 'tag'])
  expect(blocks[0]).toEqual({ kind: 'md', text: 'Before\n\n```xml\n<flow>\na -> b\n</flow>\n```\n' })
})

test('a one-line block tag and the text after its close', () => {
  const blocks = parseBlocks('<rule tone="ok">Done</rule>\nThen prose.')
  expect(blocks).toEqual([
    { kind: 'tag', name: 'rule', attrs: { tone: 'ok' }, body: 'Done', isClosed: true },
    { kind: 'md', text: 'Then prose.' },
  ])
})

test('nested callouts close at their own tag', () => {
  const blocks = parseBlocks('<callout>\nouter\n<callout>\ninner\n</callout>\n</callout>\nafter')
  expect(blocks[0]).toMatchObject({ name: 'callout', body: 'outer\n<callout>\ninner\n</callout>', isClosed: true })
  expect(blocks[1]).toEqual({ kind: 'md', text: 'after' })
})

test('only the paragraphs holding inline markup leave the markdown', () => {
  const blocks = parseBlocks('# Title\n\n- one\n- two\n\nNow <ok>green</ok>.\n\nEnd.')
  expect(blocks.map(b => b.kind)).toEqual(['md', 'rich', 'md'])
  expect(blocks[0]).toEqual({ kind: 'md', text: '# Title\n\n- one\n- two' })
})

test('inline tags nest, and an unclosed one runs to the end', () => {
  const runs = rich('a <ok>b <c fg="#ff0000">c</c></ok> <warn>d')
  expect(plain(runs)).toBe('a b c d')
  expect(runs.find(r => r.text === 'c')?.fg).toBe('#ff0000')
  expect(runs.find(r => r.text === 'd')?.fg).toBe('warning')
})

test('markdown emphasis inside a rich paragraph, and snake_case left alone', () => {
  const runs = rich('**bold** and `code` and snake_case_name')
  expect(runs[0]).toMatchObject({ text: 'bold', bold: true })
  expect(runs.find(r => r.text === 'code')?.fg).toBe('permission')
  expect(plain(runs)).toBe('bold and code and snake_case_name')
})

test('emphasis and links span the inline tags inside them', () => {
  const runs = rich('[a <info>b</info>](https://x.y) **c <ok>d</ok>** *e <ok>f</ok>* ~~g <err>h</err>~~ `**i**`')
  expect(plain(runs)).toBe('a b c d e f g h **i**')
  expect(runs.find(r => r.text === 'b')).toMatchObject({ fg: 'suggestion', underline: true })
  expect(runs.find(r => r.text === 'd')).toMatchObject({ fg: 'success', bold: true })
  expect(runs.find(r => r.text === 'f')).toMatchObject({ fg: 'success', italic: true })
  expect(runs.find(r => r.text === 'h')).toMatchObject({ fg: 'error', strike: true })
  expect(runs.find(r => r.text === '**i**')?.bold).toBeUndefined()
})

test('a table holding inline markup draws boxed, and as key-value rows when narrow', () => {
  const text = '| Hook | Lines |\n|---|---:|\n| `a|b` | <ok>43</ok> |'
  expect(parseBlocks(text).map(b => b.kind)).toEqual(['rich'])
  expect(richRows(text, 80).map(r => plain(r.runs))).toEqual([
    '┌──────┬───────┐',
    '│ Hook │ Lines │',
    '├──────┼───────┤',
    '│ a|b  │    43 │',
    '└──────┴───────┘',
  ])
  expect(richRows(text, 10).map(r => plain([...(r.lead ?? []), ...r.runs]))).toEqual(['Hook   a|b', 'Lines  43'])
})

test("a block tag's title may hold inline markup", () => {
  const [b] = parseBlocks(`<callout tone="warn" title="See <hl>this</hl> and <meter value='1'/>">\nBody.\n</callout>\nafter`)
  expect(b).toMatchObject({ attrs: { tone: 'warn', title: "See <hl>this</hl> and <meter value='1'/>" }, body: 'Body.', isClosed: true })
})

test('a step takes a trailing tone, and its detail inline markup and a second dash', () => {
  const rows = steps('[?] Unsure {#ff00aa}\n[!] Failed — press <kbd>Esc</kbd> — then retry', {})
  expect(rows[0]!.runs[0]).toMatchObject({ text: 'Unsure', fg: '#ff00aa' })
  expect(plain(rows[1]!.runs)).toBe('Failed  press  Esc  — then retry')
  expect(rows[1]!.runs.find(r => r.text === ' Esc ')?.inverse).toBe(true)
})

test('a tree note keeps a later # and its inline markup', () => {
  const rows = tree('lib/\n  a.mjs # note with a # hash and <ok>ok</ok>', {})
  expect(plain(rows[1]!.runs)).toBe('└── a.mjs  note with a # hash and ok')
  expect(rows[1]!.runs.find(r => r.text === 'ok')?.fg).toBe('success')
})

test('a shrinking bar keeps to whole cells so its trace follows without a gap', () => {
  const rows = bars('a: 51 -> 38', {}, 60)
  const solid = rows[0]!.runs[1]!.text
  expect(solid).toMatch(/^█+$/)
  expect(rows[0]!.runs[2]!.text).toMatch(/^░+$/)
})

test("a toned box's shaft starts in the edge's color", () => {
  const rows = flow('a {ok} -> b\nb -> a', {}, 80)
  const junction = rows.flatMap(r => r.runs).find(r => r.text.includes('┬'))
  expect(junction?.fg).toBe('inactive')
})

test('a flow too wide for the room falls back to a list', () => {
  const body = 'a-very-long-node-name -> another-very-long-node, a-third-long-node, a-fourth-long-node'
  const rows = flow(body, {}, 40)
  expect(rows.map(r => plain(r.runs))).toEqual([
    'a-very-long-node-name → another-very-long-node, a-third-long-node, a-fourth-long-node',
  ])
})

test('a cycle is drawn without its back edge and listed under the drawing', () => {
  const rows = flow('a -> b -> c\nc -> a', {}, 80)
  expect(plain(rows[rows.length - 1]!.runs)).toBe('cycle: c → a')
})

// Hostile replies, each of which took one to twenty seconds to parse before
// parsing was bounded. The limit is a tenth of that or less, with room for a slow machine.
const within = (ms: number, f: () => unknown) => {
  const t = performance.now()
  f()
  expect(performance.now() - t).toBeLessThan(ms)
}

test('a reply of many blocks parses in one pass', () => {
  const reply = '<steps>\n[x] one\n[ ] two\n</steps>\n\nSome prose between.\n\n'.repeat(2000)
  within(150, () => expect(parseBlocks(reply).length).toBe(4000))
})

test('quotes and unfinished tags cost linear time', () => {
  within(400, () => parseBlocks('<svg ' + '"a" '.repeat(16000)))
  within(400, () => parseBlocks('<callout>\n' + '<callout "x" '.repeat(8000)))
})

test('a long line of unclosed emphasis costs linear time', () => {
  for (const unit of ['**a ', '*a ', '_a _', '[a](']) within(1000, () => rich('<ok>x</ok> ' + unit.repeat(16000)))
})

test('emphasis spans up to 500 characters', () => {
  const long = 'word '.repeat(80).trim()
  expect(rich(`**${long}**`)[0]).toMatchObject({ text: long, bold: true })
  expect(plain(rich(`**${long} ${long}**`))).toBe(`**${long} ${long}**`)
})

test('a body opening on its tag’s line skips a close inside a code span there', () => {
  const blocks = parseBlocks('<callout>see `</callout>` here\n</callout>\nafter')
  expect(blocks[0]).toMatchObject({ name: 'callout', body: 'see `</callout>` here', isClosed: true })
  expect(blocks[1]).toEqual({ kind: 'md', text: 'after' })
})

test('a flow past its layout limits is listed, quickly', () => {
  // 60 nodes, each to every other: 70 s to lay out before the limits.
  const dense = Array.from({ length: 60 }, (_, i) => `n${i} -> ` + Array.from({ length: 60 }, (_, j) => `n${j}`).join(', ')).join('\n')
  within(500, () => expect(plain(flow(dense, {}, 200)[0]!.runs)).toMatch(/^n0 → n1, n2, /))
  // A chain whose layout overflowed the stack, listed.
  const chain = Array.from({ length: 20000 }, (_, i) => `n${i}`).join(' -> ')
  within(500, () => expect(plain(flow(chain, {}, 80)[0]!.runs)).toBe('n0 → n1'))
})

test('a fan of fans keeps the first 2000 edges and says so', () => {
  const side = (p: string) => Array.from({ length: 1000 }, (_, i) => `${p}${i}`).join(', ')
  let rows: ReturnType<typeof flow> = []
  within(500, () => (rows = flow(`${side('a')} -> ${side('b')}`, {}, 80)))
  expect(rows).toHaveLength(3)
  expect(plain(rows[2]!.runs)).toBe('… edges past the first 2000 not listed')
})

test('tree rails run down to the last sibling and stop', () => {
  const rows = tree('a/\n  b/\n    c\n  d\ne', {}).map(r => plain(r.runs))
  expect(rows).toEqual(['a/', '├── b/', '│   └── c', '└── d', 'e'])
})

test('a tree deeper than the room draws at 32 levels, in linear time', () => {
  // Each line one level deeper: 1,500 lines took seconds before.
  const body = Array.from({ length: 1500 }, (_, i) => '  '.repeat(i) + 'x').join('\n')
  let rows: ReturnType<typeof tree> = []
  within(300, () => (rows = tree(body, {})))
  expect(rows[rows.length - 1]!.runs[0]!.text).toBe('    '.repeat(31) + '└── ')
})

test('a sequence arrow joins its source lifeline only', () => {
  const rows = seq('A -> B: hi', {}, 80).map(r => plain(r.runs))
  expect(rows).toContain('  ├─────►│')
})
