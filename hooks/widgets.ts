// The block widgets: each takes a tag's body, its attributes and the width it
// may use, and answers rows of styled runs. A widget that cannot fit answers
// a plainer form of the same content rather than a broken drawing.

import type { Attrs } from './parse'
import { rich } from './parse'
import {
  bar,
  clip,
  HEAT,
  hexOf,
  mix,
  luminance,
  nums,
  num,
  pad,
  ramp,
  type Row,
  type Run,
  runsWidth,
  SERIES,
  splitTone,
  type Style,
  tone,
  width,
} from './text'

const DIM: Style = { fg: 'inactive' }

function lines(body: string): string[] {
  return body.split('\n').filter(l => l.trim() && !/^\s*\/\//.test(l))
}

// At the first separator only, so a detail may hold another one.
function splitOnce(s: string, sep: RegExp): [string, string | undefined] {
  const m = sep.exec(s)

  return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length)] : [s, undefined]
}

function fmt(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}k`
  if (a >= 100 || Number.isInteger(n)) return String(Math.round(n))

  return String(+n.toFixed(2))
}

function title(attrs: Attrs, extra: Run[] = []): Row[] {
  if (!attrs.title) return []

  return [{ runs: [...rich(attrs.title, { bold: true }), ...extra] }]
}

// ── canvas: a cell grid whose lines join by direction ───────────────────

const U = 1
const R = 2
const D = 4
const L = 8
const JOIN: Record<number, string> = {
  1: '│', 4: '│', 5: '│', 2: '─', 8: '─', 10: '─',
  6: '╭', 12: '╮', 3: '╰', 9: '╯', 7: '├', 13: '┤', 14: '┬', 11: '┴', 15: '┼',
}

type Cell = { ch?: string; mask: number; style?: Style }

class Canvas {
  cells: Cell[][]
  readonly w: number

  constructor(w: number, h: number) {
    this.w = w
    this.cells = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ mask: 0 })))
  }

  at(x: number, y: number): Cell | undefined {
    return this.cells[y]?.[x]
  }

  text(x: number, y: number, s: string, style?: Style) {
    let cx = x
    for (const ch of s) {
      const cell = this.at(cx, y)
      if (cell) Object.assign(cell, { ch, style })
      cx += width(ch)
      // A wide glyph takes the next cell too: blank it so the row stays aligned.
      if (width(ch) === 2 && this.at(cx - 1, y)) Object.assign(this.at(cx - 1, y)!, { ch: '', style })
    }
  }

  join(x: number, y: number, mask: number, style?: Style) {
    const cell = this.at(x, y)
    if (!cell || cell.ch !== undefined) return
    cell.mask |= mask
    cell.style ??= style
  }

  vline(x: number, y0: number, y1: number, style?: Style) {
    const [a, b] = y0 <= y1 ? [y0, y1] : [y1, y0]
    for (let y = a; y <= b; y++) this.join(x, y, (y > a ? U : 0) | (y < b ? D : 0) || U | D, style)
  }

  hline(y: number, x0: number, x1: number, style?: Style) {
    const [a, b] = x0 <= x1 ? [x0, x1] : [x1, x0]
    for (let x = a; x <= b; x++) this.join(x, y, (x > a ? L : 0) | (x < b ? R : 0) || L | R, style)
  }

  box(x: number, y: number, w: number, label: string, style: Style, labelStyle: Style) {
    this.text(x, y, '╭' + '─'.repeat(w - 2) + '╮', style)
    this.text(x, y + 1, '│', style)
    this.text(x + 1, y + 1, pad(' ' + label, w - 2), labelStyle)
    this.text(x + w - 1, y + 1, '│', style)
    this.text(x, y + 2, '╰' + '─'.repeat(w - 2) + '╯', style)
  }

  rows(): Row[] {
    const out = this.cells.map(row => {
      const runs: Run[] = []
      for (const cell of row) {
        const ch = cell.ch ?? JOIN[cell.mask] ?? ' '
        const style = ch === ' ' ? undefined : cell.style
        const last = runs[runs.length - 1]
        if (last && sameStyle(last, style)) last.text += ch
        else runs.push({ ...style, text: ch })
      }
      const tail = runs[runs.length - 1]
      if (tail) tail.text = tail.text.trimEnd()

      return { runs: runs.filter(r => r.text) }
    })
    while (out.length > 0 && out[out.length - 1]!.runs.length === 0) out.pop()

    return out
  }
}

function sameStyle(a: Style, b: Style | undefined): boolean {
  const keys = ['fg', 'bg', 'bold', 'italic', 'underline', 'strike', 'dim', 'inverse'] as const

  return keys.every(k => a[k] === b?.[k])
}

// ── flow: a layered graph of boxes ──────────────────────────────────────

type FlowNode = { id: string; label: string; tone?: string; layer: number; order: number; w: number; x: number; isDummy: boolean }

// The most edges a flow keeps: a line of fans (`a, b, … -> x, y, …`) makes
// the product of its sides, so a short body could ask for millions.
const FLOW_KEPT_EDGES = 2000

function parseFlow(body: string) {
  const nodes = new Map<string, { label: string; tone?: string }>()
  const edges: Array<[string, string]> = []
  const seen = new Set<string>()
  let isCut = false
  const edge = (a: string, b: string) => {
    const key = a + '\u0000' + b
    if (a === b || seen.has(key)) return
    if (edges.length === FLOW_KEPT_EDGES) {
      isCut = true

      return
    }
    seen.add(key)
    edges.push([a, b])
  }
  const node = (raw: string) => {
    const [label, t] = splitTone(raw)
    if (!label) return undefined
    const known = nodes.get(label)
    if (!known) nodes.set(label, { label, tone: t })
    else if (t) known.tone = t

    return label
  }
  for (const line of lines(body)) {
    const steps = line.split(/\s*(?:-->|->|→|=>)\s*/).map(seg =>
      seg
        .split(/\s*,\s*/)
        .map(node)
        .filter((id): id is string => id !== undefined),
    )
    for (let i = 0; i + 1 < steps.length && !isCut; i++) for (const a of steps[i]!) for (const b of steps[i + 1]!) edge(a, b)
  }

  return { nodes, edges, isCut }
}

// Each node's edges, in the order given.
function adjacency<T>(edges: ReadonlyArray<readonly [T, T]>, isReversed = false): Map<T, T[]> {
  const out = new Map<T, T[]>()
  for (const [a, b] of edges) {
    const [from, to] = isReversed ? [b, a] : [a, b]
    const list = out.get(from)
    if (list) list.push(to)
    else out.set(from, [to])
  }

  return out
}

// Past these a graph is listed, not laid out: it could not fit the width,
// and its layout costs time with the square of its size.
const FLOW_MAX_NODES = 100
const FLOW_MAX_EDGES = 300

export function flow(body: string, attrs: Attrs, avail: number): Row[] {
  const { nodes, edges, isCut } = parseFlow(body)
  if (nodes.size === 0) return []
  const ids = [...nodes.keys()]
  if (ids.length > FLOW_MAX_NODES || edges.length > FLOW_MAX_EDGES) {
    const more: Row[] = isCut ? [{ runs: [{ ...DIM, text: `… edges past the first ${FLOW_KEPT_EDGES} not listed` }] }] : []

    return [...title(attrs), ...flowList(ids, adjacency(edges), nodes), ...more]
  }

  // Back edges (cycles) are kept out of the layout and listed under it.
  const back: Array<[string, string]> = []
  const forward: Array<[string, string]> = []
  {
    const state = new Map<string, 'open' | 'done'>()
    const outOf = adjacency(edges)
    const visit = (v: string) => {
      state.set(v, 'open')
      for (const to of outOf.get(v) ?? []) {
        const e: [string, string] = [v, to]
        const s = state.get(e[1])
        if (s === 'open') back.push(e)
        else {
          forward.push(e)
          if (!s) visit(e[1])
        }
      }
      state.set(v, 'done')
    }
    for (const v of ids) if (!state.has(v)) visit(v)
  }

  const succOf = adjacency(forward)
  const predOf = adjacency(forward, true)
  const succ = (v: string) => succOf.get(v) ?? []
  const pred = (v: string) => predOf.get(v) ?? []

  const isPath =
    back.length === 0 &&
    forward.length === ids.length - 1 &&
    ids.every(v => succ(v).length <= 1 && pred(v).length <= 1)
  if (isPath) {
    const start = ids.find(v => pred(v).length === 0)!
    const chain = [start]
    for (let next = succ(start)[0]; next !== undefined; next = succ(next)[0]) chain.push(next)
    const drawn = chainRow(chain.map(id => nodes.get(id)!), avail, attrs.dir !== 'down')
    if (drawn) return [...title(attrs), ...drawn]
  }

  // Longest-path layering over the acyclic edges.
  const layer = new Map<string, number>()
  const depth = (v: string, seen = new Set<string>()): number => {
    if (layer.has(v)) return layer.get(v)!
    if (seen.has(v)) return 0
    seen.add(v)
    const d = Math.max(-1, ...pred(v).map(p => depth(p, seen))) + 1
    layer.set(v, d)

    return d
  }
  ids.forEach(v => depth(v))

  // Edges that skip layers run through one-cell dummies, a layer at a time.
  const all = new Map<string, FlowNode>()
  for (const id of ids) {
    const n = nodes.get(id)!
    all.set(id, { id, label: n.label, tone: n.tone, layer: layer.get(id)!, order: 0, w: width(n.label) + 4, x: 0, isDummy: false })
  }
  const links: Array<[string, string]> = []
  let dummies = 0
  for (const [a, b] of forward) {
    let from = a
    for (let l = layer.get(a)! + 1; l < layer.get(b)!; l++) {
      const id = `\u0000${dummies++}`
      all.set(id, { id, label: '', layer: l, order: 0, w: 1, x: 0, isDummy: true })
      links.push([from, id])
      from = id
    }
    links.push([from, b])
  }

  const depthCount = Math.max(...[...all.values()].map(n => n.layer)) + 1
  const layers: FlowNode[][] = Array.from({ length: depthCount }, () => [])
  for (const n of all.values()) layers[n.layer]!.push(n)
  layers.forEach(ls => ls.forEach((n, i) => (n.order = i)))

  const upOf = adjacency(links, true)
  const downOf = adjacency(links)
  const up = (n: FlowNode) => (upOf.get(n.id) ?? []).map(id => all.get(id)!)
  const down = (n: FlowNode) => (downOf.get(n.id) ?? []).map(id => all.get(id)!)
  const mean = (xs: number[], dflt: number) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : dflt)
  // The middle parent (or child) so a node sits straight under one of them.
  const median = (xs: number[], dflt: number) => {
    if (xs.length === 0) return dflt
    const sorted = [...xs].sort((a, b) => a - b)

    return sorted[Math.floor((sorted.length - 1) / 2)] ?? dflt
  }

  // Barycentre sweeps to cut crossings.
  for (let pass = 0; pass < 4; pass++) {
    const range = pass % 2 === 0 ? layers.slice(1) : layers.slice(0, -1).reverse()
    for (const ls of range) {
      const key = new Map(ls.map(n => [n, mean((pass % 2 === 0 ? up(n) : down(n)).map(m => m.order), n.order)]))
      ls.sort((a, b) => key.get(a)! - key.get(b)! || a.order - b.order)
      ls.forEach((n, i) => (n.order = i))
    }
  }

  const centre = (n: FlowNode) => n.x + Math.floor(n.w / 2)
  const place = (gap: number) => {
    const placeLayer = (ls: FlowNode[], toward: (n: FlowNode) => FlowNode[]) => {
      let right = -gap
      for (const n of ls) {
        const want = median(toward(n).map(centre), centre(n)) - Math.floor(n.w / 2)
        n.x = Math.max(Math.round(want), right + gap, 0)
        right = n.x + n.w
      }
    }
    let x = 0
    for (const n of layers[0]!) {
      n.x = x
      x += n.w + gap
    }
    for (const ls of layers.slice(1)) placeLayer(ls, up)
    for (const ls of layers.slice(0, -1).reverse()) placeLayer(ls, down)
    for (const ls of layers.slice(1)) placeLayer(ls, up)

    return Math.max(...[...all.values()].map(n => n.x + n.w))
  }
  let gap = 3
  let total = place(gap)
  while (total > avail && gap > 1) total = place(--gap)
  if (total > avail) return [...title(attrs), ...flowList(ids, adjacency([...forward, ...back]), nodes)]

  // Channels between layers: one track per source whose edges run sideways.
  type Span = { src: FlowNode; lo: number; hi: number; targets: Set<number>; track: number }
  const channels = layers.slice(0, -1).map(ls => {
    const spans: Span[] = []
    for (const src of ls) {
      const xs = down(src).map(centre)
      if (xs.length === 0) continue
      const lo = Math.min(centre(src), ...xs)
      const hi = Math.max(centre(src), ...xs)
      if (lo !== hi) spans.push({ src, lo, hi, targets: new Set(xs), track: -1 })
    }
    spans.sort((a, b) => a.lo - b.lo)
    const tracks: Span[][] = []
    for (const s of spans) {
      const clash = (t: Span) =>
        s.lo <= t.hi && t.lo <= s.hi && !((s.hi === t.lo || t.hi === s.lo) && [...s.targets].some(x => t.targets.has(x) && (x === s.hi || x === s.lo)))
      let i = tracks.findIndex(tr => !tr.some(clash))
      if (i === -1) i = tracks.push([]) - 1
      tracks[i]!.push(s)
      s.track = i
    }

    return { spans, height: tracks.length + 2 }
  })

  const tops: number[] = []
  let y = 0
  layers.forEach((_, i) => {
    tops.push(y)
    y += 3 + (channels[i]?.height ?? 0)
  })
  const canvas = new Canvas(total, y)
  const edge: Style = DIM

  layers.forEach((ls, i) => {
    const top = tops[i]!
    for (const n of ls) {
      if (n.isDummy) canvas.vline(n.x, top, top + 2, edge)
      else {
        const color = n.tone
        canvas.box(n.x, top, n.w, n.label, { fg: color ?? 'inactive' }, { fg: color, bold: true })
      }
    }
    const ch = channels[i]
    if (!ch) return
    const stub = top + 3
    const arrow = stub + ch.height - 1
    for (const src of ls) {
      const px = centre(src)
      const kids = down(src)
      if (kids.length === 0) continue
      // In the edge's color, not the box's, so a toned box doesn't tint its shaft.
      if (!src.isDummy) canvas.text(px, top + 2, '┬', edge)
      const span = ch.spans.find(s => s.src === src)
      const row = span ? stub + 1 + span.track : arrow
      canvas.vline(px, stub, row, edge)
      if (span) canvas.hline(row, span.lo, span.hi, edge)
      for (const kid of kids) {
        const cx = centre(kid)
        canvas.vline(cx, row, arrow, edge)
        if (!kid.isDummy) canvas.text(cx, arrow, '▼', edge)
      }
    }
  })

  const notes: Row[] = back.map(([a, b]) => ({ runs: [{ ...DIM, text: `cycle: ${a} → ${b}` }] }))

  return [...title(attrs), ...canvas.rows(), ...notes]
}

function chainRow(chain: Array<{ label: string; tone?: string }>, avail: number, isAllowed: boolean): Row[] | undefined {
  const arrow = ' ──► '
  const total = chain.reduce((s, n) => s + width(n.label) + 4, 0) + (chain.length - 1) * width(arrow)
  if (!isAllowed || total > avail) return undefined
  const canvas = new Canvas(total, 3)
  let x = 0
  chain.forEach((n, i) => {
    const w = width(n.label) + 4
    canvas.box(x, 0, w, n.label, { fg: n.tone ?? 'inactive' }, { fg: n.tone, bold: true })
    x += w
    if (i < chain.length - 1) {
      canvas.text(x, 1, arrow, DIM)
      x += width(arrow)
    }
  })

  return canvas.rows()
}

function flowList(ids: string[], outOf: Map<string, string[]>, nodes: Map<string, { tone?: string }>): Row[] {
  return ids
    .map((id): Row | undefined => {
      const to = outOf.get(id) ?? []
      if (to.length === 0) return undefined
      const runs: Run[] = [{ fg: nodes.get(id)?.tone, bold: true, text: id }, { ...DIM, text: ' → ' }]
      to.forEach((b, i) => {
        if (i) runs.push({ ...DIM, text: ', ' })
        runs.push({ fg: nodes.get(b)?.tone, text: b })
      })

      return { runs, wrap: true }
    })
    .filter((r): r is Row => r !== undefined)
}

// ── seq: a sequence diagram ─────────────────────────────────────────────

type SeqItem =
  | { kind: 'msg'; from: number; to: number; label: string; isReply: boolean; tone?: string }
  | { kind: 'divider'; label: string }

export function seq(body: string, attrs: Attrs, avail: number): Row[] {
  const names: string[] = []
  const who = (s: string) => {
    const name = s.trim()
    let i = names.indexOf(name)
    if (i === -1) i = names.push(name) - 1

    return i
  }
  const items: SeqItem[] = []
  for (const line of lines(body)) {
    const divider = /^\s*={2,}\s*(.*?)\s*={2,}\s*$/.exec(line)
    if (divider) {
      items.push({ kind: 'divider', label: divider[1] ?? '' })
      continue
    }
    const m = /^(.+?)\s*(-->|->|→|<--|<-|←)\s*(.+?)\s*(?::\s*(.*))?$/.exec(line) as [string, string, string, string, string?] | null
    if (!m) continue
    const [label, t] = splitTone(m[4] ?? '')
    const isBackward = m[2].startsWith('<') || m[2] === '←'
    const a = who(m[1])
    const b = who(m[3])
    items.push({
      kind: 'msg',
      from: isBackward ? b : a,
      to: isBackward ? a : b,
      label,
      isReply: m[2].includes('--'),
      tone: t,
    })
  }
  if (names.length === 0) return []

  // Columns far enough apart for every label drawn between them.
  const hw = names.map(n => width(n) + 4)
  const W = (i: number) => hw[i] ?? 0
  const X = (i: number) => xs[i] ?? 0
  const xs: number[] = [Math.floor(W(0) / 2)]
  for (let j = 1; j < names.length; j++) {
    let x = X(j - 1) + Math.ceil(W(j - 1) / 2) + Math.floor(W(j) / 2) + 2
    for (const it of items) {
      if (it.kind !== 'msg') continue
      const lo = Math.min(it.from, it.to)
      const hi = Math.max(it.from, it.to)
      if (hi === j && lo < j) x = Math.max(x, X(lo) + width(it.label) + 4)
      if (it.from === it.to && it.from === j - 1) x = Math.max(x, X(j - 1) + width(it.label) + 7)
    }
    xs.push(x)
  }
  const last = names.length - 1
  let total = X(last) + Math.ceil(W(last) / 2)
  for (const it of items) if (it.kind === 'msg' && it.from === it.to && it.from === last) total = Math.max(total, X(last) + 5 + width(it.label))
  if (total > avail) return [...title(attrs), ...seqList(names, items)]

  const height = 3 + items.reduce((h, it) => h + (it.kind === 'divider' ? 1 : 2), 0) + 1
  const canvas = new Canvas(total, height)
  names.forEach((n, i) => {
    canvas.box(X(i) - Math.floor(W(i) / 2), 0, W(i), n, { fg: 'inactive' }, { bold: true })
    canvas.text(X(i), 2, '┬', { fg: 'inactive' })
  })

  let y = 3
  for (const it of items) {
    if (it.kind === 'divider') {
      const text = it.label ? ` ${it.label} ` : ''
      const start = Math.max(0, Math.floor((total - width(text)) / 2))
      canvas.text(0, y, '┈'.repeat(total), DIM)
      canvas.text(start, y, text, { fg: 'inactive', italic: true })
      y += 1
      continue
    }
    const color = it.tone ?? (it.isReply ? 'inactive' : 'suggestion')
    const style: Style = { fg: color }
    const a = X(it.from)
    const b = X(it.to)
    if (it.from === it.to) {
      canvas.hline(y, a, a + 2, style)
      canvas.vline(a + 2, y, y + 1, style)
      canvas.text(a + 4, y, it.label, { fg: it.tone })
      canvas.hline(y + 1, a + 1, a + 2, style)
      canvas.text(a + 1, y + 1, '◄', style)
    } else {
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      canvas.text(lo + 1 + Math.max(0, Math.floor((hi - lo - 1 - width(it.label)) / 2)), y, it.label, { fg: it.tone, italic: it.isReply })
      // Stops short of the target's lifeline, so only the source joins it.
      canvas.hline(y + 1, a, b < a ? b + 1 : b - 1, style)
      if (it.isReply)
        for (let x = lo + 1; x < hi; x++) if (!xs.includes(x)) canvas.text(x, y + 1, '╌', style)
      canvas.text(b < a ? b + 1 : b - 1, y + 1, b < a ? '◄' : '►', style)
    }
    y += 2
  }
  // Lifelines last: they join what crosses them and fill every gap.
  xs.forEach(x => canvas.vline(x, 3, height - 1, DIM))

  return [...title(attrs), ...canvas.rows()]
}

function seqList(names: string[], items: SeqItem[]): Row[] {
  return items.map((it): Row =>
    it.kind === 'divider'
      ? { runs: [{ ...DIM, italic: true, text: `── ${it.label} ──` }] }
      : {
          wrap: true,
          runs: [
            { bold: true, text: names[it.from] ?? '' },
            { fg: it.tone ?? (it.isReply ? 'inactive' : 'suggestion'), text: it.isReply ? ' --> ' : ' → ' },
            { bold: true, text: names[it.to] ?? '' },
            ...(it.label ? [{ ...DIM, text: ': ' }, { fg: it.tone, text: it.label }] : []),
          ],
        },
  )
}

// ── bars: a horizontal bar chart, optionally before → after ────────────

export function bars(body: string, attrs: Attrs, avail: number): Row[] {
  type Item = { label: string; a: number; b?: number; shown: string; tone?: string }
  const items: Item[] = []
  for (const line of lines(body)) {
    const m = /^(.*?)\s*[:|]\s*([^:|]*)$/.exec(line) as [string, string, string] | null
    if (!m) continue
    const [rawValue, t] = splitTone(m[2])
    const [before, after] = rawValue.split(/\s*(?:->|→)\s*/)
    const a = num(before ?? '')
    if (a === undefined) continue
    const b = after === undefined ? undefined : num(after)
    items.push({ label: m[1].trim(), a, b, shown: rawValue, tone: t })
  }
  if (items.length === 0) return []

  const better = attrs.better
  const unit = attrs.unit ?? ''
  const max = Number(attrs.max) || Math.max(...items.flatMap(i => [i.a, i.b ?? 0]))
  const labelW = Math.min(24, Math.max(...items.map(i => width(i.label))))
  const shown = items.map(i => {
    if (i.b === undefined) return [{ text: i.shown + unit }] as Run[]
    const delta = i.a === 0 ? 0 : ((i.b - i.a) / Math.abs(i.a)) * 100
    const good = better === 'lower' ? delta < 0 : better === 'higher' ? delta > 0 : undefined
    const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±'

    return [
      { ...DIM, text: `${fmt(i.a)}${unit} → ` },
      { bold: true, text: `${fmt(i.b)}${unit}` },
      { fg: good === undefined || delta === 0 ? 'inactive' : good ? 'success' : 'error', text: ` ${sign}${Math.abs(Math.round(delta))}%` },
    ] as Run[]
  })
  const valueW = Math.max(...shown.map(runsWidth))
  const cells = Math.max(6, Math.min(48, avail - labelW - valueW - 3))
  const base = tone(attrs.tone) ?? 'claude'

  const rows: Row[] = items.map((it, i) => {
    const color = it.tone ?? (items.length > 1 && 'series' in attrs ? SERIES[i % SERIES.length] : base)
    const head: Run = { text: pad(clip(it.label, labelW), labelW) + ' ' }
    if (it.b === undefined) {
      const fill = bar(max ? it.a / max : 0, cells)

      return { runs: [head, { fg: color, text: fill }, { text: ' '.repeat(cells - width(fill) + 1) }, ...shown[i]!] }
    }
    // Before and after on one row: the after bar solid, the before as a
    // faint trace past it when it was longer. With a trace, the solid bar
    // keeps to whole cells: an eighth block would leave a gap before it.
    const nowFrac = max ? it.b / max : 0
    const wasCells = Math.round((max ? it.a / max : 0) * cells)
    const solid = Math.max(it.b > 0 ? 1 : 0, Math.round(nowFrac * cells))
    const hasTrace = wasCells > solid
    const now = hasTrace ? '█'.repeat(solid) : bar(nowFrac, cells)
    const trace = hasTrace ? wasCells - solid : 0

    return {
      runs: [
        head,
        { fg: color, text: now },
        { ...DIM, text: '░'.repeat(trace) },
        { text: ' '.repeat(Math.max(0, cells - width(now) - trace) + 1) },
        ...shown[i]!,
      ],
    }
  })

  return [...title(attrs), ...rows]
}

// ── chart: a braille line chart ─────────────────────────────────────────

const BRAILLE = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

export function chart(body: string, attrs: Attrs, avail: number): Row[] {
  const series: Array<{ name: string; values: number[]; tone?: string }> = []
  const loose: number[] = []
  if (attrs.values) loose.push(...nums(attrs.values))
  for (const line of lines(body)) {
    const m = /^\s*([^:\d-][^:]*):\s*(.+)$/.exec(line) as [string, string, string] | null
    if (m) {
      const [values, t] = splitTone(m[2])
      series.push({ name: m[1].trim(), values: nums(values), tone: t })
    } else loose.push(...nums(line))
  }
  if (loose.length) series.unshift({ name: '', values: loose })
  const live = series.filter(s => s.values.length > 0)
  if (live.length === 0) return []

  const every = live.flatMap(s => s.values)
  const lo = attrs.min !== undefined ? Number(attrs.min) : 'zero' in attrs ? Math.min(0, ...every) : Math.min(...every)
  const hi = attrs.max !== undefined ? Number(attrs.max) : Math.max(...every)
  const span = hi - lo || 1
  const rowsN = Math.max(2, Math.min(24, Number(attrs.height) || 8))
  const unit = attrs.unit ?? ''
  const labels = [fmt(hi) + unit, fmt((hi + lo) / 2) + unit, fmt(lo) + unit]
  const labelW = Math.max(...labels.map(width))
  const cols = Math.max(8, Math.min(Number(attrs.width) || 64, avail - labelW - 2))
  const dotsW = cols * 2
  const dotsH = rowsN * 4

  const grid = Array.from({ length: rowsN }, () => Array.from({ length: cols }, () => ({ bits: 0, owner: -1, count: 0 })))
  const dot = (x: number, y: number, s: number) => {
    const cell = grid[Math.floor(y / 4)]?.[Math.floor(x / 2)]
    if (!cell) return
    const bit = BRAILLE[y % 4]![x % 2]!
    if (!(cell.bits & bit)) {
      cell.bits |= bit
      if (cell.owner === -1 || s < cell.owner) cell.owner = s
    }
  }
  live.forEach((s, si) => {
    const pts = s.values.map((v, i): [number, number] => [
      s.values.length === 1 ? 0 : Math.round((i * (dotsW - 1)) / (s.values.length - 1)),
      dotsH - 1 - Math.round(((Math.max(lo, Math.min(hi, v)) - lo) / span) * (dotsH - 1)),
    ])
    pts.forEach(([x, y], i) => {
      dot(x, y, si)
      const next = pts[i + 1]
      if (!next) return
      const steps = Math.max(Math.abs(next[0] - x), Math.abs(next[1] - y))
      for (let k = 1; k < steps; k++) dot(Math.round(x + ((next[0] - x) * k) / steps), Math.round(y + ((next[1] - y) * k) / steps), si)
    })
  })

  const colorOf = (si: number) => live[si]?.tone ?? (live.length === 1 ? tone(attrs.tone) ?? 'claude' : SERIES[si % SERIES.length])
  const rows: Row[] = grid.map((row, r) => {
    const label = r === 0 ? labels[0] : r === rowsN - 1 ? labels[2] : rowsN >= 5 && r === Math.floor((rowsN - 1) / 2) ? labels[1] : ''
    const runs: Run[] = [{ ...DIM, text: pad(label ?? '', labelW, 'right') + (label ? ' ┤' : ' │') }]
    for (const cell of row) {
      const ch = String.fromCharCode(0x2800 + cell.bits)
      const fg = cell.bits ? colorOf(cell.owner) : undefined
      const prev = runs[runs.length - 1]!
      if (prev.fg === fg && runs.length > 1) prev.text += ch
      else runs.push({ fg, text: ch })
    }

    return { runs }
  })
  rows.push({ runs: [{ ...DIM, text: ' '.repeat(labelW + 1) + '└' + '─'.repeat(cols) }] })

  const xLabels = (attrs.x ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (xLabels.length) {
    const line = Array.from({ length: cols }, () => ' ')
    let free = 0
    xLabels.forEach((t, i) => {
      const at = xLabels.length === 1 ? 0 : Math.round((i * (cols - 1)) / (xLabels.length - 1))
      const start = Math.min(cols - width(t), i === 0 ? 0 : Math.max(0, at - Math.floor(width(t) / 2)))
      if (start < free) return
      ;[...t].forEach((ch, k) => (line[start + k] = ch))
      free = start + width(t) + 1
    })
    rows.push({ runs: [{ ...DIM, text: ' '.repeat(labelW + 2) + line.join('').trimEnd() }] })
  }
  if (live.length > 1 || live[0]!.name) {
    const legend: Run[] = [{ text: ' '.repeat(labelW + 2) }]
    live.forEach((s, i) => {
      if (i) legend.push({ text: '   ' })
      legend.push({ fg: colorOf(i), text: '━━ ' }, { text: s.name || 'series' })
    })
    rows.push({ runs: legend, wrap: true })
  }

  return [...title(attrs), ...rows]
}

// ── heat: a heat map ────────────────────────────────────────────────────

export function heat(body: string, attrs: Attrs, avail: number): Row[] {
  const data: Array<{ label: string; values: number[] }> = []
  for (const line of lines(body)) {
    const m = /^\s*(.*?)\s*[:|]\s*(.+)$/.exec(line) as [string, string, string] | null
    if (m) data.push({ label: m[1], values: nums(m[2]) })
    else data.push({ label: '', values: nums(line) })
  }
  if (data.length === 0) return []

  const header = (attrs.cols ?? attrs.x ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const every = data.flatMap(d => d.values)
  const lo = attrs.min !== undefined ? Number(attrs.min) : Math.min(...every)
  const hi = attrs.max !== undefined ? Number(attrs.max) : Math.max(...every)
  const n = Math.max(...data.map(d => d.values.length))
  const showValues = 'values' in attrs
  const labelW = Math.min(20, Math.max(0, ...data.map(d => width(d.label))))
  let cellW = Math.max(2, Math.min(5, ...[Math.max(0, ...header.map(width))].map(w => Math.max(w, 2))))
  if (showValues) cellW = Math.max(cellW, ...every.map(v => width(fmt(v)) + 1))
  while (cellW > 1 && labelW + 1 + cellW * n > avail) cellW -= 1
  const stops = attrs.colors ? attrs.colors.split(',').map(s => s.trim()) : HEAT

  const rows: Row[] = []
  if (header.length) {
    rows.push({ runs: [{ ...DIM, text: ' '.repeat(labelW + 1) + header.map(h => pad(clip(h, cellW), cellW, 'center')).join('') }] })
  }
  for (const d of data) {
    const runs: Run[] = [{ text: pad(clip(d.label, labelW), labelW) + ' ' }]
    for (let i = 0; i < n; i++) {
      const v = d.values[i]
      if (v === undefined) {
        runs.push({ text: ' '.repeat(cellW) })
        continue
      }
      const bg = ramp(stops, hi === lo ? 0.5 : (v - lo) / (hi - lo))
      const text = showValues ? pad(fmt(v), cellW, 'center') : ' '.repeat(cellW)
      runs.push({ bg, fg: luminance(bg) > 0.5 ? '#111111' : '#f5f5f5', text })
    }
    rows.push({ runs })
  }
  const legend: Run[] = [{ text: ' '.repeat(labelW + 1) }, { ...DIM, text: fmt(lo) + ' ' }]
  for (let i = 0; i < 8; i++) legend.push({ bg: ramp(stops, i / 7), text: ' ' })
  legend.push({ ...DIM, text: ' ' + fmt(hi) + (attrs.unit ?? '') })
  rows.push({ runs: legend })

  return [...title(attrs), ...rows]
}

// ── tree ────────────────────────────────────────────────────────────────

// Deeper lines draw at this depth: its rails already fill 128 cells.
const TREE_MAX_DEPTH = 32

export function tree(body: string, attrs: Attrs): Row[] {
  const raw = body.split('\n').filter(l => l.trim())
  const indents = raw.map(l => /^[ \t]*/.exec(l)![0].replace(/\t/g, '    ').length)
  const steps = indents.filter(i => i > 0)
  const unit = steps.length ? Math.min(...steps) : 2
  const items = raw.map((l, i) => ({ depth: Math.min(TREE_MAX_DEPTH, Math.round(indents[i]! / unit)), text: l.trim() }))

  // Whether a later sibling follows each item: read from the bottom up,
  // `below[d]` says a line at depth d has come since the last shallower one.
  const hasNext: boolean[] = []
  const below: boolean[] = []
  for (let i = items.length - 1; i >= 0; i--) {
    const d = items[i]!.depth
    hasNext[i] = below[d] === true
    below.length = d
    below[d] = true
  }

  // From the top down, `open[d]` says the nearest line at depth d or
  // shallower is at d and has a later sibling: its rail runs on down.
  const open: boolean[] = []
  const rows: Row[] = items.map((it, i) => {
    const prefix: string[] = []
    for (let d = 1; d < it.depth; d++) prefix.push(open[d] ? '│   ' : '    ')
    if (it.depth > 0) prefix.push(hasNext[i] ? '├── ' : '└── ')
    open.length = it.depth
    open[it.depth] = hasNext[i]!

    let text = it.text
    let mark: Style = {}
    const sigil = /^([+~!-])\s+/.exec(text) as [string, '+' | '~' | '!' | '-'] | null
    if (sigil) {
      mark = { fg: { '+': 'success', '-': 'error', '~': 'warning', '!': 'error' }[sigil[1]] }
      text = text.slice(sigil[0].length)
    }
    // A tone may close the line or the name before its note.
    const [line, lineTone] = splitTone(text)
    const [main, comment] = splitOnce(line, /\s+(?:#|—|--)\s+/)
    const [name, nameTone] = splitTone(main)
    const t = nameTone ?? lineTone
    const isDir = name.endsWith('/')
    const style: Style = { ...mark, fg: t ?? mark.fg ?? (isDir ? 'suggestion' : undefined), bold: isDir || it.depth === 0 }
    const runs: Run[] = [{ ...DIM, text: prefix.join('') }]
    if (sigil) runs.push({ ...mark, text: sigil[1] + ' ' })
    runs.push(...rich(name, style))
    if (comment) runs.push({ text: '  ' }, ...rich(comment, DIM))

    return { runs }
  })

  return [...title(attrs), ...rows]
}

// ── steps: a checklist with states ──────────────────────────────────────

// Marks every terminal font draws as text: ✔ is a color emoji in Windows
// Terminal and Ghostty, and conhost has no ◐ or ⊘.
const STEP: Record<string, { glyph: string; style: Style; text?: Style }> = {
  x: { glyph: '✓', style: { fg: 'success' } },
  ' ': { glyph: '○', style: DIM },
  '~': { glyph: '●', style: { fg: 'claude', bold: true }, text: { bold: true } },
  '>': { glyph: '▸', style: { fg: 'claude', bold: true }, text: { bold: true } },
  '!': { glyph: '✘', style: { fg: 'error', bold: true } },
  '-': { glyph: '–', style: DIM, text: { fg: 'inactive', strike: true } },
  '?': { glyph: '?', style: { fg: 'warning', bold: true } },
}

export function steps(body: string, attrs: Attrs): Row[] {
  const items = lines(body).map(l => {
    const m = /^\s*(?:[-*]\s+)?\[([ xX~>!?-])\]\s*(.*)$/.exec(l) as [string, string, string] | null

    return m ? { state: m[1].toLowerCase(), text: m[2] } : { state: ' ', text: l.trim() }
  })
  const done = items.filter(i => i.state === 'x').length
  const rows: Row[] = items.map(({ state, text }) => {
    const s = STEP[state] ?? STEP[' ']!
    const [line, t] = splitTone(text)
    const [main, detail] = splitOnce(line, /\s+(?:—|--)\s+/)

    return {
      lead: [{ ...s.style, text: s.glyph + ' ' }],
      runs: [...rich(main, { ...s.text, ...(t ? { fg: t } : {}) }), ...(detail ? [{ text: '  ' }, ...rich(detail, DIM)] : [])],
      wrap: true,
    }
  })

  return [...title(attrs, [{ ...DIM, text: `  ${done}/${items.length}` }]), ...rows]
}

// ── timeline ────────────────────────────────────────────────────────────

export function timeline(body: string, attrs: Attrs): Row[] {
  const items = lines(body).map(l => {
    const m = (/^\s*(.+?)\s+(?:\||—|--)\s+(.*)$/.exec(l) ?? /^\s*([^:]+?):\s+(.*)$/.exec(l)) as [string, string, string] | null
    const [what, t] = splitTone(m ? m[2] : l)

    return { when: m ? m[1].trim() : '', what, tone: t }
  })
  const whenW = Math.min(20, Math.max(0, ...items.map(i => width(i.when))))
  const rows: Row[] = []
  items.forEach((it, i) => {
    rows.push({
      lead: [{ fg: it.tone ?? 'claude', text: '● ' }, { ...DIM, text: pad(clip(it.when, whenW), whenW) + '  ' }],
      runs: rich(it.what, { fg: it.tone }),
      wrap: true,
    })
    if (i < items.length - 1) rows.push({ runs: [{ ...DIM, text: '│' }] })
  })

  return [...title(attrs), ...rows]
}

// ── kv: aligned keys and values ─────────────────────────────────────────

export function kv(body: string, attrs: Attrs): Row[] {
  const items = lines(body).map(l => {
    const m = (/^\s*([^:=]+?)\s*[:=]\s+(.*)$/.exec(l) ?? /^\s*([^:=]+?)\s*[:=](.*)$/.exec(l)) as [string, string, string] | null

    return m ? { key: m[1], value: m[2] } : { key: '', value: l.trim() }
  })
  const keyW = Math.min(24, Math.max(0, ...items.map(i => width(i.key))))
  const keyStyle: Style = { fg: tone(attrs.tone) ?? 'inactive' }

  return [
    ...title(attrs),
    ...items.map(it => ({ lead: [{ ...keyStyle, text: pad(clip(it.key, keyW), keyW) + '  ' }], runs: rich(it.value), wrap: true })),
  ]
}

// ── rule and banner ─────────────────────────────────────────────────────

export function rule(body: string, attrs: Attrs, avail: number): Row[] {
  const label = (attrs.title ?? body).trim()
  const color = tone(attrs.tone) ?? 'inactive'
  const w = Math.min(avail, Number(attrs.width) || avail)
  if (!label) return [{ runs: [{ fg: color, text: '─'.repeat(w) }] }]
  const text = rich(label, { bold: true, fg: tone(attrs.tone) })
  const side = Math.max(2, w - runsWidth(text) - 2)

  return [{ runs: [{ fg: color, text: '──' + ' ' }, ...text, { fg: color, text: ' ' + '─'.repeat(Math.max(0, side - 2)) }] }]
}

// A banner's spaced, gradient letters, its subtitle and its border color.
export function bannerParts(body: string, attrs: Attrs): { text: string; letters: Run[]; sub?: string; border: Style } {
  const text = (attrs.title ?? body).trim().toUpperCase()
  const chars = [...[...text].join(' ')]
  const from = hexOf(attrs.from, '#d77757')
  const to = hexOf(attrs.to, '#af87ff')
  const letters: Run[] = chars.map((ch, i) => ({ fg: mix(from, to, chars.length > 1 ? i / (chars.length - 1) : 0), bold: true, text: ch }))

  return { text, letters, sub: attrs.sub ?? attrs.subtitle, border: { fg: tone(attrs.tone) ?? 'inactive' } }
}

export function banner(body: string, attrs: Attrs, avail: number): Row[] {
  const { text, letters, sub, border } = bannerParts(body, attrs)
  const spaced = letters.map(r => r.text).join('')
  const inner = Math.min(avail - 2, Math.max(width(spaced), sub ? width(sub) : 0) + 6)
  if (width(spaced) + 4 > avail - 2) return [{ runs: rich(text, { bold: true, fg: 'claude' }) }]
  const lead = Math.floor((inner - width(spaced)) / 2)

  const rows: Row[] = [
    { runs: [{ ...border, text: '╭' + '─'.repeat(inner) + '╮' }] },
    { runs: [{ ...border, text: '│' + ' '.repeat(lead) }, ...letters, { ...border, text: ' '.repeat(inner - lead - width(spaced)) + '│' }] },
  ]
  if (sub) {
    const s = clip(sub, inner - 2)
    const l = Math.floor((inner - width(s)) / 2)
    rows.push({ runs: [{ ...border, text: '│' + ' '.repeat(l) }, { ...DIM, italic: true, text: s }, { ...border, text: ' '.repeat(inner - l - width(s)) + '│' }] })
  }
  rows.push({ runs: [{ ...border, text: '╰' + '─'.repeat(inner) + '╯' }] })

  return rows
}

export const WIDGETS: Record<string, (body: string, attrs: Attrs, avail: number) => Row[]> = {
  flow,
  seq,
  bars,
  chart,
  heat,
  tree,
  steps,
  timeline,
  kv,
  rule,
  banner,
}
