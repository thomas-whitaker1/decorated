import { expect, test } from 'claude-code/testing'

import { parseBlocks } from './parse'
import { animation, nativeSvg, parseColor, pathPolys, svg } from './svg'

const plain = (runs: ReadonlyArray<{ text: string }>) => runs.map(r => r.text).join('')

test('a reply’s svg tag is one block, its root attributes the tag’s', () => {
  const blocks = parseBlocks('Look:\n\n<svg viewBox="0 0 10 10">\n<rect width="10" height="10"/>\n</svg>\nAfter.')
  expect(blocks.map(b => b.kind)).toEqual(['md', 'tag', 'md'])
  expect(blocks[1]).toMatchObject({ name: 'svg', attrs: { viewbox: '0 0 10 10' }, body: '<rect width="10" height="10"/>', isClosed: true })
})

test('a filled square is full blocks of its color, the viewBox giving the rows', () => {
  const rows = svg('<rect width="10" height="10" fill="#ff0000"/>', { viewbox: '0 0 10 10', cols: '8' }, 80)
  // Square pixels, two to a cell: 8 wide is 8 tall, in 4 rows.
  expect(rows.length).toBe(4)
  for (const r of rows) {
    expect(plain(r.runs)).toBe('█'.repeat(8))
    expect(r.runs[0]?.fg).toBe('#ff0000')
  }
})

test('two colors in a cell share it as foreground and background', () => {
  const body = '<rect width="4" height="1" fill="#ff0000"/><rect y="1" width="4" height="1" fill="#0000ff"/>'
  const [row] = svg(body, { viewbox: '0 0 4 2', cols: '4' }, 80)
  expect(row?.runs).toEqual([{ fg: '#ff0000', bg: '#0000ff', text: '▀▀▀▀' }])
})

test('a lone half pixel draws the half block without a background', () => {
  const [row] = svg('<rect y="1" width="2" height="1" fill="#00ff00"/>', { viewbox: '0 0 2 2', cols: '2' }, 80)
  expect(row?.runs).toEqual([{ fg: '#00ff00', text: '▄▄' }])
})

test('a circle is round: corners empty, middle full', () => {
  const rows = svg('<circle cx="10" cy="10" r="10" fill="#fff"/>', { viewbox: '0 0 20 20', cols: '20' }, 80)
  const text = rows.map(r => plain(r.runs).padEnd(20))
  expect(text[0]![0]).toBe(' ')
  expect(text[5]![10]).toBe('█')
  expect(text[5]![0]).toBe('█')
})

test('paths read every command, arcs with run-together flags included', () => {
  const segs = () => 4
  const [square] = pathPolys('M0 0 h10 v10 H0 z', segs)
  expect(square).toEqual({ pts: [[0, 0], [10, 0], [10, 10], [0, 10]], isClosed: true })
  const [arc] = pathPolys('M0 0 a5 5 0 0110 0', segs)
  // A semicircle over the top, ending where it said.
  expect(arc?.pts[2]?.map(v => Math.round(v) + 0)).toEqual([5, -5])
  expect(arc?.pts.at(-1)?.map(v => Math.round(v) + 0)).toEqual([10, 0])
  // A path still streaming draws as far as it has come.
  expect(pathPolys('M0 0 L5 5 L1', segs)[0]?.pts).toEqual([[0, 0], [5, 5]])
})

test('colors: hex, functions, CSS names and the style’s tone names', () => {
  expect(parseColor('#f00', '')).toEqual([255, 0, 0, 1])
  expect(parseColor('rgb(0, 128, 255)', '')).toEqual([0, 128, 255, 1])
  expect(parseColor('teal', '')).toEqual([0, 128, 128, 1])
  expect(parseColor('ok', '')).toEqual([0x4e, 0xba, 0x65, 1])
  expect(parseColor('none', '')).toBeUndefined()
  expect(parseColor('currentColor', '#00f')).toEqual([0, 0, 255, 1])
})

test('text is set in glyphs on the cell it falls in, over the fill', () => {
  const body = '<rect width="20" height="10" fill="#000080"/><text x="10" y="6" text-anchor="middle" fill="white">hi</text>'
  const rows = svg(body, { viewbox: '0 0 20 10', cols: '20' }, 80)
  expect(rows.length).toBe(5)
  const row = rows.find(r => plain(r.runs).includes('hi'))
  expect(plain(row!.runs).indexOf('hi')).toBe(9)
  expect(row!.runs.find(r => r.text === 'hi')).toMatchObject({ fg: '#ffffff', bg: '#000080' })
})

test('braille mode draws a stroke as dots in one color', () => {
  const rows = svg('<line x1="0" y1="2" x2="40" y2="2" stroke="#ff0000" stroke-width="2"/>', { viewbox: '0 0 40 8', mode: 'braille', cols: '20' }, 80)
  expect(rows.length).toBe(2)
  const drawn = rows[0]!.runs.find(r => r.fg === '#ff0000')
  expect(drawn?.text).toMatch(/^[⠁-⣿]{20}$/)
})

test('a linear gradient runs between its stops', () => {
  const body =
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>' +
    '<rect width="10" height="2" fill="url(#g)"/>'
  const [row] = svg(body, { viewbox: '0 0 10 2', cols: '10' }, 80)
  const shades = row!.runs.map(r => parseInt(r.fg!.slice(1, 3), 16))
  expect(shades.length).toBeGreaterThan(3)
  for (let i = 1; i < shades.length; i++) expect(shades[i]!).toBeGreaterThan(shades[i - 1]!)
})

test('it never draws wider than the room', () => {
  const rows = svg('<rect width="100" height="10" fill="red"/>', { viewbox: '0 0 100 10', cols: '200' }, 30)
  for (const r of rows) expect(plain(r.runs).length).toBeLessThanOrEqual(30)
})

test('nothing drawable yet draws nothing, so a stream shows its placeholder', () => {
  expect(svg('<rect width="1', { viewbox: '0 0 10 10' }, 80)).toEqual([])
})

// ── bounds on what a reply may ask of the raster ────────────────────────

// Before the bounds these took 1 to 16 s, overflowed the stack or drew
// 100,000 rows; a time limit here is a tenth of that or less.
const within = (ms: number, f: () => unknown) => {
  const t = performance.now()
  f()
  expect(performance.now() - t).toBeLessThan(ms)
}

test('rows asks for 80 at most', () => {
  expect(svg('<rect width="1" height="2000" fill="red"/>', { viewbox: '0 0 1 100000', rows: '100000' }, 80)).toHaveLength(80)
})

test('markup nested past 48 deep is left unread, not a stack overflow', () => {
  const deep = (n: number) => '<g>'.repeat(n) + '<rect width="10" height="10" fill="#f00"/>'
  expect(svg(deep(20), { viewbox: '0 0 10 10', cols: '4' }, 80)[0]?.runs).toEqual([{ fg: '#ff0000', text: '████' }])
  within(400, () => expect(svg(deep(200_000), { viewbox: '0 0 10 10', cols: '4' }, 80)).toEqual([]))
})

test('a use that walks its own group stops at the visit budget', () => {
  const body = '<g id="x"><rect width="1" height="1" fill="#f00"/><use href="#x"/><use href="#x"/></g>'
  within(400, () => expect(svg(body, { viewbox: '0 0 10 10' }, 80).length).toBeGreaterThan(0))
})

test('thousands of shapes and points stop at the work budget, the first ones drawn', () => {
  const rects = '<rect x="1" y="1" width="5" height="5" fill="#f00" stroke="#00f"/>'.repeat(20_000)
  within(1000, () => expect(svg(rects, { viewbox: '0 0 10 10', cols: '10' }, 80).flatMap(r => r.runs).some(r => r.fg === '#ff0000')).toBe(true))
  const path = '<path d="M0 0' + ' L1 1 L9 9'.repeat(100_000) + '" stroke="#f00" fill="none"/>'
  within(1000, () => svg(path, { viewbox: '0 0 10 10' }, 80))
})

// ── SMIL ────────────────────────────────────────────────────────────────

const rowsAt = (body: string, attrs: Record<string, string>, t?: number) => svg(body, attrs, 80, t).map(r => plain(r.runs))

const SLIDE =
  '<rect width="4" height="4" fill="#f00"><animate id="a" attributeName="x" from="0" to="16" dur="1s" fill="freeze"/></rect>' +
  '<circle cx="2" cy="6" r="2" fill="#0f0"><animate attributeName="cx" from="2" to="18" begin="a.end" dur="1s" fill="freeze"/></circle>'
const BOX = { viewbox: '0 0 20 8', cols: '20' }

test('an animation draws the frame its time asks, and freezes at its end', () => {
  expect(rowsAt(SLIDE, BOX, 0)[0]).toBe('████')
  expect(rowsAt(SLIDE, BOX, 0.5)[0]).toBe(' '.repeat(8) + '████')
  expect(rowsAt(SLIDE, BOX, 5)[0]).toBe(' '.repeat(16) + '████')
})

test('a begin on another animation’s end waits for it', () => {
  expect(rowsAt(SLIDE, BOX, 1)[2]).toBe('▄██▄')
  expect(rowsAt(SLIDE, BOX, 1.5)[2]).toBe(' '.repeat(8) + '▄██▄')
})

test('with no time it draws the still it comes to rest on', () => {
  expect(rowsAt(SLIDE, BOX)).toEqual(rowsAt(SLIDE, BOX, 2))
})

test('without fill="freeze" an ended animation gives its target back its own value', () => {
  const body = '<rect x="0" width="4" height="4" fill="#f00"><animate attributeName="x" to="16" dur="1s"/></rect>'
  expect(rowsAt(body, BOX, 0.5)[0]).toBe(' '.repeat(8) + '████')
  expect(rowsAt(body, BOX, 2)[0]).toBe('████')
})

test('animateTransform turns about its centre', () => {
  const body =
    '<rect x="5" y="5" width="10" height="2" fill="#fff"><animateTransform attributeName="transform" type="rotate" from="0 10 6" to="360 10 6" dur="2s" repeatCount="indefinite"/></rect>'
  const flat = rowsAt(body, { viewbox: '0 0 20 12', cols: '20' }, 0).filter(r => r.trim())
  const upright = rowsAt(body, { viewbox: '0 0 20 12', cols: '20' }, 0.5).filter(r => r.trim())
  expect(flat.length).toBe(2)
  expect(upright.length).toBe(6)
})

test('colors pass through the colors between', () => {
  const body = '<rect width="4" height="2" fill="#000"><animate attributeName="fill" values="#000000;#ffffff" dur="1s" fill="freeze"/></rect>'
  const fg = (t: number) => svg(body, { viewbox: '0 0 4 2', cols: '4' }, 80, t)[0]?.runs[0]?.fg
  expect([fg(0), fg(0.5), fg(1)]).toEqual(['#000000', '#808080', '#ffffff'])
})

test('animateMotion moves along its path at an even pace', () => {
  const body = '<circle r="1" fill="#ff0"><animateMotion path="M2 2 H18" dur="1s" fill="freeze"/></circle>'
  const at = (t: number) => rowsAt(body, { viewbox: '0 0 20 4', cols: '20' }, t)[0]!.indexOf('▄')
  expect([at(0), at(0.5), at(1)]).toEqual([1, 9, 17])
})

test('discrete values, keyTimes and set switch without easing', () => {
  const steps = '<rect width="4" height="4" fill="#f00"><animate attributeName="x" values="0;8;16" keyTimes="0;0.2;0.9" calcMode="discrete" dur="1s"/></rect>'
  const x = (t: number) => rowsAt(steps, BOX, t)[0]!.indexOf('█')
  expect([x(0.1), x(0.5), x(0.95)]).toEqual([0, 8, 16])
  const shown = '<rect width="4" height="4" fill="#f00" visibility="hidden"><set attributeName="visibility" to="visible" begin="1s"/></rect>'
  expect(rowsAt(shown, BOX, 0.5).every(r => !r.trim())).toBe(true)
  expect(rowsAt(shown, BOX, 1)[0]).toBe('████')
})

test('keySplines ease between values', () => {
  const body =
    '<rect width="2" height="4" fill="#f00"><animate attributeName="x" values="0;18" keyTimes="0;1" calcMode="spline" keySplines="0.9 0 1 0.1" dur="1s"/></rect>'
  // A slow start: at half time it has gone far less than half way.
  expect(rowsAt(body, BOX, 0.5)[0]!.indexOf('█')).toBeLessThan(4)
})

test('how long a drawing plays: finite, endless, or a still', () => {
  expect(animation(SLIDE)).toEqual({ endMs: 2000 })
  expect(animation('<rect><animate attributeName="x" to="5" dur="1s" repeatCount="indefinite"/></rect>')).toEqual({ endMs: Infinity })
  // A held value changes once, when it begins.
  expect(animation('<rect><set attributeName="fill" to="red" begin="3s"/></rect>')).toEqual({ endMs: 3000 })
  // Waiting on an event that never comes in a terminal: nothing plays.
  expect(animation('<rect><animate attributeName="x" to="5" begin="click" dur="1s"/></rect>')).toBeUndefined()
  expect(animation('<rect width="4" height="4"/>')).toBeUndefined()
})

test('a surface that draws SVG gets the markup whole, in colors a browser knows', () => {
  const n = nativeSvg('<rect width="4" height="4" fill="ok"/><text x="1" y="3">cpu</text>', { viewbox: '0 0 20 8', cols: '20', mode: 'braille', title: 'Load' })
  expect(n.source).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 8"><rect width="4" height="4" fill="#4eba65"/><text x="1" y="3">cpu</text></svg>')
  expect(n).toMatchObject({ alt: 'Load', width: 160, isAnimated: false })
  expect(nativeSvg('<text>a</text><text>b</text>', {}).alt).toBe('a, b')
  expect(nativeSvg(SLIDE, {}).isAnimated).toBe(true)
})

test('the markup a surface gets loads nothing from elsewhere and runs nothing', () => {
  const body =
    '<script>alert(1)</script><image href="https://x.example/?q=secret"/>' +
    '<foreignObject><div>html</div></foreignObject><style>@import url(https://x.example/a.css)</style>' +
    '<rect width="4" height="4" fill="url(#g)" onload="alert(1)" style="background:url(https://x.example/b)"/>' +
    '<use href="#shape"/><use xlink:href="https://x.example/c.svg#d"/>' +
    '<a href="https://x.example/"><text>link</text></a>' +
    '<use href="#shape"><set attributeName="href" to="https://x.example/e.svg#f"/></use>'
  const { source } = nativeSvg(body, { viewbox: '0 0 4 4', onload: 'alert(1)', bg: 'url(https://x.example/g)' })
  expect(source).not.toMatch(/x\.example|script|alert|foreignObject|<style|<image|<set/)
  expect(source).toBe(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4" fill="url(#g)"/>' +
      '<use href="#shape"/><use/><a><text>link</text></a><use href="#shape"></use></svg>',
  )
})

test('the markup a surface gets is well formed, text and tspans in their order', () => {
  const { source } = nativeSvg('<g><text x="1">a &amp; <tspan>b</tspan> c</text></rect><g>', {})
  expect(source).toBe('<svg xmlns="http://www.w3.org/2000/svg"><g><text x="1">a &amp; <tspan>b</tspan> c</text><g></g></g></svg>')
  expect(nativeSvg('<rect/>', { cols: '100000' }).width).toBe(1600)
})
