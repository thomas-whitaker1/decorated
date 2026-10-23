// Inline SVG rasterised into terminal cells. Half blocks (the default) give
// each cell two full-color pixels, near square on a 1:2 cell; braille gives
// 2×4 dots in one color, finer for line art. `<text>` is set in real glyphs
// on the nearest cell, so labels stay crisp however small the drawing is.
//
// Shapes: rect (rounded), circle, ellipse, line, polyline, polygon, path
// (every command, arcs included), g, use, text; solid, linear and radial
// paint; transform, opacity, fill-rule, stroke-linecap. No filters, masks,
// clipping, patterns or dashes.

import type { Attrs } from './parse'
import { HEX_OF, rgbToHex, type Row, type Run, tone, width } from './text'

type El = { name: string; attrs: Attrs; kids: El[]; text: string }
type Pt = [number, number]
type Poly = { pts: Pt[]; isClosed: boolean }
type M = [number, number, number, number, number, number]
type Rgba = [number, number, number, number]

// ── a forgiving XML reader, enough for the SVG a reply holds ────────────

const TOKEN =
  /<!--[\s\S]*?(?:-->|$)|<[?!][^>]*>|<(\/?)([\w:-]+)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>/]+))?)*)\s*(\/?)>|([^<]+|<)/g
const XATTR = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g
const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decode(s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))

    return ENTITY[e] ?? m
  })
}

// Case kept, unlike block attributes: SVG spells `viewBox`, `fill-rule`.
function xmlAttrs(s: string): Attrs {
  const out: Attrs = {}
  for (const m of s.matchAll(XATTR)) out[m[1]!] = decode(m[2] ?? m[3] ?? m[4] ?? '')

  return out
}

// Past these the markup is left unread, as if it had not streamed in yet:
// elements nested deeper than the walk draws, and more of them than any
// drawing in a reply needs.
const XML_MAX_DEPTH = 48
const XML_MAX_ELEMENTS = 4000

export function parseXml(src: string): El[] {
  const root: El = { name: '', attrs: {}, kids: [], text: '' }
  const stack = [root]
  let count = 0
  // Elements opened past XML_MAX_DEPTH, unread along with what they hold.
  let unread = 0
  for (const m of src.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!
    if (m[5] !== undefined) {
      if (!unread) top.text += decode(m[5])
      continue
    }
    if (!m[2]) continue
    if (m[1]) {
      if (unread) {
        unread -= 1
        continue
      }
      const at = stack.map(e => e.name).lastIndexOf(m[2])
      if (at > 0) stack.length = at
      continue
    }
    if (unread || stack.length > XML_MAX_DEPTH) {
      if (!m[4]) unread += 1
      continue
    }
    if (++count > XML_MAX_ELEMENTS) break
    const el: El = { name: m[2], attrs: xmlAttrs(m[3] ?? ''), kids: [], text: '' }
    top.kids.push(el)
    if (!m[4]) stack.push(el)
  }

  return root.kids
}

// ── numbers, lengths, transforms ────────────────────────────────────────

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

function numList(s: string | undefined): number[] {
  return (s?.match(NUM) ?? []).map(Number)
}

const ID: M = [1, 0, 0, 1, 0, 0]

// `m` after `n`: a point goes through `n` first.
function mul(m: M, n: M): M {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

function apply(m: M, [x, y]: Pt): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function parseTransform(s: string | undefined): M {
  let m = ID
  for (const t of s?.matchAll(/(\w+)\s*\(([^)]*)\)/g) ?? []) {
    const v = numList(t[2])
    const [a = 0, b, c] = v
    const rad = (a * Math.PI) / 180
    let n: M
    switch (t[1]) {
      case 'matrix':
        n = v.length >= 6 ? (v.slice(0, 6) as M) : ID
        break
      case 'translate':
        n = [1, 0, 0, 1, a, b ?? 0]
        break
      case 'scale':
        n = [a, 0, 0, b ?? a, 0, 0]
        break
      case 'rotate':
        n = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0]
        if (b !== undefined) n = mul(mul([1, 0, 0, 1, b, c ?? 0], n), [1, 0, 0, 1, -b, -(c ?? 0)])
        break
      case 'skewX':
        n = [1, 0, Math.tan(rad), 1, 0, 0]
        break
      case 'skewY':
        n = [1, Math.tan(rad), 0, 1, 0, 0]
        break
      default:
        continue
    }
    m = mul(m, n)
  }

  return m
}

// ── geometry: every shape becomes polylines in user space ───────────────

type Segs = (len: number) => number

function ellipsePts(cx: number, cy: number, rx: number, ry: number, segs: Segs, from = 0, to = Math.PI * 2): Pt[] {
  const n = segs(Math.abs(to - from) * Math.max(rx, ry))
  const out: Pt[] = []
  for (let k = 0; k <= n; k++) {
    const t = from + ((to - from) * k) / n
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)])
  }

  return out
}

function arcPts(x1: number, y1: number, rx: number, ry: number, phi: number, isLarge: boolean, isSweep: boolean, x2: number, y2: number, segs: Segs): Pt[] {
  if (x1 === x2 && y1 === y2) return []
  if (rx === 0 || ry === 0) return [[x2, y2]]
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const r = (phi * Math.PI) / 180
  const co = Math.cos(r)
  const si = Math.sin(r)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const xp = co * dx + si * dy
  const yp = -si * dx + co * dy
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  if (lam > 1) {
    rx *= Math.sqrt(lam)
    ry *= Math.sqrt(lam)
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
  const den = rx * rx * yp * yp + ry * ry * xp * xp
  const k = (isLarge === isSweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den))
  const cxp = (k * rx * yp) / ry
  const cyp = (-k * ry * xp) / rx
  const cx = co * cxp - si * cyp + (x1 + x2) / 2
  const cy = si * cxp + co * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t1 = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry)
  let dt = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry)
  if (!isSweep && dt > 0) dt -= Math.PI * 2
  if (isSweep && dt < 0) dt += Math.PI * 2
  const n = segs(Math.abs(dt) * Math.max(rx, ry))
  const out: Pt[] = []
  for (let j = 1; j <= n; j++) {
    const t = t1 + (dt * j) / n
    out.push([cx + co * rx * Math.cos(t) - si * ry * Math.sin(t), cy + si * rx * Math.cos(t) + co * ry * Math.sin(t)])
  }

  return out
}

// Stops at the first thing it cannot read, so a path still streaming draws
// as far as it has come.
export function pathPolys(d: string, segs: Segs): Poly[] {
  const polys: Poly[] = []
  let cur: Pt[] = []
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let ctrl: Pt = [0, 0]
  let prev = ''
  let cmd = ''
  let i = 0
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++
  }
  const n = (): number | undefined => {
    skip()
    const re = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y
    re.lastIndex = i
    const m = re.exec(d)
    if (!m) return undefined
    i += m[0].length

    return Number(m[0])
  }
  // Arc flags may run together: `a1 1 0 011 1`.
  const flag = (): boolean | undefined => {
    skip()
    const c = d[i]
    if (c !== '0' && c !== '1') return undefined
    i += 1

    return c === '1'
  }
  const nums = (k: number): number[] | undefined => {
    const out: number[] = []
    for (let j = 0; j < k; j++) {
      const v = n()
      if (v === undefined) return undefined
      out.push(v)
    }

    return out
  }
  const flush = (isClosed: boolean) => {
    if (cur.length > 1) polys.push({ pts: cur, isClosed })
    cur = []
  }
  const to = (...pts: Pt[]) => {
    if (cur.length === 0) cur.push([x, y])
    cur.push(...pts)
  }
  const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt) => {
    const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1])
    const k = segs(len)
    for (let j = 1; j <= k; j++) {
      const t = j / k
      const u = 1 - t
      to([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ])
    }
  }
  const quad = (p0: Pt, p1: Pt, p2: Pt) => cubic(p0, [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])], [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])], p2)

  for (;;) {
    skip()
    if (i >= d.length) break
    if (/[a-zA-Z]/.test(d[i]!)) cmd = d[i++]!
    else if (!cmd) break
    const isRel = cmd >= 'a'
    const C = cmd.toUpperCase()
    const ox = isRel ? x : 0
    const oy = isRel ? y : 0
    if (C === 'Z') {
      if (cur.length > 0) flush(true)
      x = sx
      y = sy
      prev = 'Z'
      cmd = ''
      continue
    }
    const at = i
    let ok = true
    if (C === 'M') {
      const v = nums(2)
      if (v) {
        flush(false)
        x = ox + v[0]!
        y = oy + v[1]!
        sx = x
        sy = y
        cur = [[x, y]]
        cmd = isRel ? 'l' : 'L'
      } else ok = false
    } else if (C === 'L') {
      const v = nums(2)
      if (v) {
        to([ox + v[0]!, oy + v[1]!])
        ;[x, y] = [ox + v[0]!, oy + v[1]!]
      } else ok = false
    } else if (C === 'H' || C === 'V') {
      const v = n()
      if (v !== undefined) {
        if (C === 'H') x = ox + v
        else y = oy + v
        to([x, y])
      } else ok = false
    } else if (C === 'C' || C === 'S') {
      const v = nums(C === 'C' ? 6 : 4)
      if (v) {
        const p1: Pt = C === 'C' ? [ox + v[0]!, oy + v[1]!] : prev === 'C' || prev === 'S' ? [2 * x - ctrl[0], 2 * y - ctrl[1]] : [x, y]
        const rest = C === 'C' ? v.slice(2) : v
        const p2: Pt = [ox + rest[0]!, oy + rest[1]!]
        const p3: Pt = [ox + rest[2]!, oy + rest[3]!]
        cubic([x, y], p1, p2, p3)
        ctrl = p2
        ;[x, y] = p3
      } else ok = false
    } else if (C === 'Q' || C === 'T') {
      const v = nums(C === 'Q' ? 4 : 2)
      if (v) {
        const p1: Pt = C === 'Q' ? [ox + v[0]!, oy + v[1]!] : prev === 'Q' || prev === 'T' ? [2 * x - ctrl[0], 2 * y - ctrl[1]] : [x, y]
        const rest = C === 'Q' ? v.slice(2) : v
        const p2: Pt = [ox + rest[0]!, oy + rest[1]!]
        quad([x, y], p1, p2)
        ctrl = p1
        ;[x, y] = p2
      } else ok = false
    } else if (C === 'A') {
      const v = nums(3)
      const large = v && flag()
      const sweep = large !== undefined ? flag() : undefined
      const end = sweep !== undefined ? nums(2) : undefined
      if (v && large !== undefined && sweep !== undefined && end) {
        const ex = ox + end[0]!
        const ey = oy + end[1]!
        const pts = arcPts(x, y, v[0]!, v[1]!, v[2]!, large, sweep, ex, ey, segs)
        if (pts.length) to(...pts)
        ;[x, y] = [ex, ey]
      } else ok = false
    } else ok = false
    if (!ok) {
      i = at
      break
    }
    prev = C
  }
  flush(false)

  return polys
}

// ── paint ───────────────────────────────────────────────────────────────

const CSS: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00',
  cyan: '00ffff', aqua: '00ffff', magenta: 'ff00ff', fuchsia: 'ff00ff', gray: '808080', grey: '808080',
  orange: 'ffa500', purple: '800080', pink: 'ffc0cb', brown: 'a52a2a', navy: '000080', teal: '008080',
  lime: '00ff00', maroon: '800000', olive: '808000', silver: 'c0c0c0', gold: 'ffd700', skyblue: '87ceeb',
  steelblue: '4682b4', royalblue: '4169e1', dodgerblue: '1e90ff', tomato: 'ff6347', coral: 'ff7f50',
  salmon: 'fa8072', crimson: 'dc143c', firebrick: 'b22222', indigo: '4b0082', violet: 'ee82ee',
  orchid: 'da70d6', plum: 'dda0dd', tan: 'd2b48c', khaki: 'f0e68c', wheat: 'f5deb3', beige: 'f5f5dc',
  ivory: 'fffff0', chocolate: 'd2691e', sienna: 'a0522d', saddlebrown: '8b4513', turquoise: '40e0d0',
  seagreen: '2e8b57', forestgreen: '228b22', darkgreen: '006400', darkblue: '00008b', darkred: '8b0000',
  lightgray: 'd3d3d3', lightgrey: 'd3d3d3', darkgray: 'a9a9a9', darkgrey: 'a9a9a9', dimgray: '696969',
  slategray: '708090', lightblue: 'add8e6', lightgreen: '90ee90', hotpink: 'ff69b4', limegreen: '32cd32',
}

// [r, g, b, a] in 0..255 and 0..1; undefined for none.
export function parseColor(s: string | undefined, current: string): Rgba | undefined {
  const v = s?.trim().toLowerCase()
  if (!v || v === 'none' || v === 'transparent') return undefined
  if (v === 'currentcolor') return parseColor(current, '#000')
  const hex = /^#([\da-f]{3,8})$/.exec(v)?.[1] ?? CSS[v]
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const h = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex
    const n = (k: number) => parseInt(h.slice(k, k + 2), 16)

    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1]
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v)
  if (fn) {
    const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean)
    const val = (p: string | undefined, scale: number) => (p === undefined ? 1 : p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p))
    const a = parts[3] === undefined ? 1 : val(parts[3], 1)
    if (fn[1]!.startsWith('rgb')) return [val(parts[0], 255), val(parts[1], 255), val(parts[2], 255), a]
    const [hh = 0, ss = 0, ll = 0] = [parseFloat(parts[0] ?? '0'), val(parts[1], 1), val(parts[2], 1)]
    const f = (k: number) => {
      const t = (k + hh / 30) % 12

      return 255 * (ll - ss * Math.min(ll, 1 - ll) * Math.max(-1, Math.min(t - 3, 9 - t, 1)))
    }

    return [f(0), f(8), f(4), a]
  }
  // The style's own tone names: `fill="ok"`, `stroke="accent"`.
  const themed = HEX_OF[tone(v) ?? '']

  return themed ? parseColor(themed, current) : undefined
}

type Paint = Rgba | ((x: number, y: number) => Rgba)

type Stop = { at: number; rgba: Rgba }

function stopsOf(el: El, ids: Map<string, El>, current: string, seen = new Set<El>()): Stop[] {
  const own = el.kids
    .filter(k => k.name === 'stop')
    .map(k => {
      const p = props(k.attrs)
      const at = p.offset?.endsWith('%') ? parseFloat(p.offset) / 100 : Number(p.offset ?? 0)
      const c = parseColor(p['stop-color'] ?? 'black', current) ?? [0, 0, 0, 0]
      const op = Number(p['stop-opacity'] ?? 1)

      return { at: Math.max(0, Math.min(1, at || 0)), rgba: [c[0], c[1], c[2], c[3] * op] as Rgba }
    })
  if (own.length > 0) return own
  const ref = ids.get(hrefOf(el.attrs) ?? '')
  if (!ref || seen.has(ref)) return []
  seen.add(el)

  return stopsOf(ref, ids, current, seen)
}

function at(stops: Stop[], t: number): Rgba {
  t = Math.max(0, Math.min(1, t))
  let lo = stops[0]!
  for (const s of stops) {
    if (s.at >= t) {
      const span = s.at - lo.at
      const f = span > 0 ? (t - lo.at) / span : 1

      return lo.rgba.map((v, k) => v + ((s.rgba[k] ?? v) - v) * f) as Rgba
    }
    lo = s
  }

  return lo.rgba
}

function gradient(el: El, ids: Map<string, El>, current: string, box: [number, number, number, number], m: M, alpha: number): Paint | undefined {
  const stops = stopsOf(el, ids, current).sort((a, b) => a.at - b.at)
  if (stops.length === 0) return undefined
  if (stops.length === 1) return withAlpha(stops[0]!.rgba, alpha)
  const a = el.attrs
  const isUser = a.gradientUnits === 'userSpaceOnUse'
  const [bx, by, bw, bh] = box
  // A coordinate in the gradient's units, to user space.
  const frac = (v: string | undefined, dflt: number) => (v === undefined ? dflt : v.endsWith('%') ? parseFloat(v) / 100 : Number(v))
  const ux = (v: string | undefined, dflt: number) => (isUser ? (v?.endsWith('%') ? bx + frac(v, dflt) * bw : Number(v ?? dflt * bw + bx)) : bx + frac(v, dflt) * bw)
  const uy = (v: string | undefined, dflt: number) => (isUser ? (v?.endsWith('%') ? by + frac(v, dflt) * bh : Number(v ?? dflt * bh + by)) : by + frac(v, dflt) * bh)
  const gm = mul(m, parseTransform(a.gradientTransform))
  if (el.name === 'linearGradient') {
    const p1 = apply(gm, [ux(a.x1, 0), uy(a.y1, 0)])
    const p2 = apply(gm, [ux(a.x2, 1), uy(a.y2, 0)])
    const dx = p2[0] - p1[0]
    const dy = p2[1] - p1[1]
    const len2 = dx * dx + dy * dy || 1

    return (x, y) => withAlpha(at(stops, ((x - p1[0]) * dx + (y - p1[1]) * dy) / len2), alpha)
  }
  const c = apply(gm, [ux(a.cx, 0.5), uy(a.cy, 0.5)])
  const r = frac(a.r, 0.5)
  const rx = (isUser ? r : r * bw) * Math.hypot(gm[0], gm[1]) || 1
  const ry = (isUser ? r : r * bh) * Math.hypot(gm[2], gm[3]) || 1

  return (x, y) => withAlpha(at(stops, Math.hypot((x - c[0]) / rx, (y - c[1]) / ry)), alpha)
}

function withAlpha(c: Rgba, alpha: number): Rgba {
  return [c[0], c[1], c[2], c[3] * alpha]
}

function hrefOf(a: Attrs): string | undefined {
  return (a.href ?? a['xlink:href'])?.replace(/^#/, '')
}

// Presentation attributes with the `style` declarations laid over them.
function props(a: Attrs): Attrs {
  if (!a.style) return a
  const out = { ...a }
  for (const decl of a.style.split(';')) {
    const [k, ...v] = decl.split(':')
    if (k?.trim() && v.length) out[k.trim()] = v.join(':').trim()
  }

  return out
}

// ── the raster: premultiplied RGBA samples, S×S per pixel ───────────────

// A crossing's cost in a fill (finding it, sorting it, painting from it),
// in units of reading an edge.
const CROSSING_WORK = 16

class Raster {
  readonly buf: Float32Array

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.buf = new Float32Array(w * h * 4)
  }

  // Scanline fill: each sample row's crossings, inside by the fill rule.
  // Answers the work it took, in edges read, crossings sorted and samples
  // painted, or Infinity where that passed `budget`: the fill stops at the
  // row where it does.
  fill(polys: readonly Pt[][], rule: string, paint: Paint, budget = Infinity): number {
    type Edge = { x0: number; y0: number; x1: number; y1: number; dir: number }
    const edges: Edge[] = []
    let top = Infinity
    let bottom = -Infinity
    for (const pts of polys) {
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k]!
        const b = pts[(k + 1) % pts.length]!
        if (a[1] === b[1]) continue
        edges.push(a[1] < b[1] ? { x0: a[0], y0: a[1], x1: b[0], y1: b[1], dir: 1 } : { x0: b[0], y0: b[1], x1: a[0], y1: a[1], dir: -1 })
        top = Math.min(top, a[1], b[1])
        bottom = Math.max(bottom, a[1], b[1])
      }
    }
    // A point that is not a number leaves the shape unpainted.
    if (edges.length === 0 || Number.isNaN(top) || Number.isNaN(bottom)) return 0
    const isEvenOdd = rule === 'evenodd'
    const solid = typeof paint === 'function' ? undefined : paint
    const from = Math.max(0, Math.floor(top))
    const to = Math.min(this.h - 1, Math.ceil(bottom))
    // Edges by their top, each joining the rows' active list when the rows
    // reach it and leaving it past its bottom: a row reads only the edges
    // that cross it.
    edges.sort((a, b) => a.y0 - b.y0)
    let work = edges.length
    let next = 0
    const active: Edge[] = []
    const xs: Array<[number, number]> = []
    for (let row = from; row <= to; row++) {
      const y = row + 0.5
      while (next < edges.length && edges[next]!.y0 <= y) active.push(edges[next++]!)
      let kept = 0
      for (const e of active) if (y < e.y1) active[kept++] = e
      active.length = kept
      xs.length = 0
      for (const e of active) xs.push([e.x0 + ((y - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), e.dir])
      work += kept * CROSSING_WORK
      if (work > budget) return Infinity
      if (xs.length < 2) continue
      xs.sort((a, b) => a[0] - b[0])
      let wind = 0
      for (let k = 0; k < xs.length - 1; k++) {
        wind += xs[k]![1]
        const inside = isEvenOdd ? wind % 2 !== 0 : wind !== 0
        if (!inside) continue
        const c0 = Math.max(0, Math.ceil(xs[k]![0] - 0.5))
        const c1 = Math.min(this.w, Math.ceil(xs[k + 1]![0] - 0.5))
        for (let col = c0; col < c1; col++) this.over(col, row, solid ?? (paint as (x: number, y: number) => Rgba)(col + 0.5, y))
        work += Math.max(0, c1 - c0)
      }
    }

    return work
  }

  over(x: number, y: number, [r, g, b, a]: Rgba) {
    if (a <= 0) return
    const i = (y * this.w + x) * 4
    const keep = 1 - a
    const buf = this.buf
    buf[i] = r * a + buf[i]! * keep
    buf[i + 1] = g * a + buf[i + 1]! * keep
    buf[i + 2] = b * a + buf[i + 2]! * keep
    buf[i + 3] = a + buf[i + 3]! * keep
  }
}

function orient(pts: Pt[]): Pt[] {
  let area = 0
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k]!
    const b = pts[(k + 1) % pts.length]!
    area += a[0] * b[1] - b[0] * a[1]
  }

  return area < 0 ? [...pts].reverse() : pts
}

// A stroke as filled pieces, every one wound the same way so the nonzero
// rule unions them: a quad per segment, a disc per join and round cap.
function strokePolys(pts: readonly Pt[], isClosed: boolean, w: number, cap: string): Pt[][] {
  const h = w / 2
  const out: Pt[][] = []
  const line = isClosed ? [...pts, pts[0]!] : pts
  const disc = (c: Pt) => orient(ellipsePts(c[0], c[1], h, h, () => Math.max(6, Math.min(16, Math.ceil(h * 2)))))
  for (let k = 0; k + 1 < line.length; k++) {
    let [ax, ay] = line[k]!
    let [bx, by] = line[k + 1]!
    const len = Math.hypot(bx - ax, by - ay)
    if (len === 0) continue
    const ux = (bx - ax) / len
    const uy = (by - ay) / len
    if (cap === 'square' && !isClosed) {
      if (k === 0) [ax, ay] = [ax - ux * h, ay - uy * h]
      if (k === line.length - 2) [bx, by] = [bx + ux * h, by + uy * h]
    }
    const nx = -uy * h
    const ny = ux * h
    out.push(orient([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]))
  }
  if (h >= 1) {
    const inner = isClosed ? line.slice(0, -1) : line.slice(1, -1)
    for (const p of inner) out.push(disc(p))
    if (cap === 'round' && !isClosed && line.length > 1) out.push(disc(line[0]!), disc(line[line.length - 1]!))
  }

  return out
}

// ── the walk: elements to fills, strokes and text ───────────────────────

type Ctx = {
  m: M
  fill: string
  stroke: string
  sw: string
  opacity: number
  fillOpacity: number
  strokeOpacity: number
  rule: string
  cap: string
  fontSize: number
  anchor: string
  isBold: boolean
  color: string
}

type Label = { x: number; y: number; text: string; anchor: string; rgba?: Rgba; isBold: boolean }

// SMIL's elements: the frame drawn carries what they say (see below).
const ANIMS = new Set(['animate', 'set', 'animateTransform', 'animateMotion', 'animateColor'])
const SKIP = new Set(['defs', 'linearGradient', 'radialGradient', 'title', 'desc', 'metadata', 'style', 'clipPath', 'mask', 'pattern', 'symbol', 'marker', 'filter', 'script', 'mpath', ...ANIMS])

// What one drawing may spend: elements walked (a `use` walks its target
// again, so a few lines can ask for billions), and raster work, in edges
// read per sample row, crossings, samples painted and stroke points built.
// A unit measured 11 to 19 ns, so the most is about 150 to 230 ms (400
// stroked circles take 8.7 million); past it the drawing stops where it
// is, as if the rest had not streamed in yet.
const SVG_MAX_VISITS = 20_000
const SVG_MAX_WORK = 12_000_000
// A stroke point's cost, in edges read: building its quad and disc takes
// about as long as reading this many edges.
const STROKE_POINT_WORK = 100

type Scene = {
  raster: Raster
  ids: Map<string, El>
  vb: [number, number, number, number]
  S: number
  labels: Label[]
  drawn: number
  visits: number
  work: number
}

function len(v: string | undefined, ref: number, fontSize: number, dflt = 0): number {
  if (v === undefined || v === '') return dflt
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return dflt
  if (v.endsWith('%')) return (n / 100) * ref
  if (/em$/.test(v)) return n * fontSize

  return n
}

function inherit(ctx: Ctx, attrs: Attrs): Ctx {
  const p = props(attrs)
  const fontSize = len(p['font-size'], ctx.fontSize, ctx.fontSize, ctx.fontSize)

  return {
    m: p.transform ? mul(ctx.m, parseTransform(p.transform)) : ctx.m,
    fill: p.fill ?? ctx.fill,
    stroke: p.stroke ?? ctx.stroke,
    sw: p['stroke-width'] ?? ctx.sw,
    opacity: ctx.opacity * Number(p.opacity ?? 1),
    fillOpacity: p['fill-opacity'] !== undefined ? Number(p['fill-opacity']) : ctx.fillOpacity,
    strokeOpacity: p['stroke-opacity'] !== undefined ? Number(p['stroke-opacity']) : ctx.strokeOpacity,
    rule: p['fill-rule'] ?? ctx.rule,
    cap: p['stroke-linecap'] ?? ctx.cap,
    fontSize: Number.isFinite(fontSize) ? fontSize : ctx.fontSize,
    anchor: p['text-anchor'] ?? ctx.anchor,
    isBold: p['font-weight'] !== undefined ? /bold|[6-9]00/.test(p['font-weight']) : ctx.isBold,
    color: p.color ?? ctx.color,
  }
}

function shapePolys(el: El, ctx: Ctx, scene: Scene, segs: Segs): Poly[] {
  const a = el.attrs
  const [, , vw, vh] = scene.vb
  const diag = Math.hypot(vw, vh) / Math.SQRT2
  const L = (k: string, ref: number) => len(a[k], ref, ctx.fontSize)
  switch (el.name) {
    case 'rect': {
      const x = L('x', vw)
      const y = L('y', vh)
      const w = L('width', vw)
      const h = L('height', vh)
      if (w <= 0 || h <= 0) return []
      let rx = a.rx !== undefined ? L('rx', vw) : a.ry !== undefined ? L('ry', vh) : 0
      let ry = a.ry !== undefined ? L('ry', vh) : rx
      rx = Math.min(rx, w / 2)
      ry = Math.min(ry, h / 2)
      if (rx <= 0 || ry <= 0) return [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], isClosed: true }]
      const q = Math.PI / 2

      return [
        {
          pts: [
            ...ellipsePts(x + w - rx, y + ry, rx, ry, segs, -q, 0),
            ...ellipsePts(x + w - rx, y + h - ry, rx, ry, segs, 0, q),
            ...ellipsePts(x + rx, y + h - ry, rx, ry, segs, q, 2 * q),
            ...ellipsePts(x + rx, y + ry, rx, ry, segs, 2 * q, 3 * q),
          ],
          isClosed: true,
        },
      ]
    }
    case 'circle':
    case 'ellipse': {
      const rx = el.name === 'circle' ? L('r', diag) : L('rx', vw)
      const ry = el.name === 'circle' ? rx : L('ry', vh)
      if (rx <= 0 || ry <= 0) return []
      const pts = ellipsePts(L('cx', vw), L('cy', vh), rx, ry, segs)

      return [{ pts: pts.slice(0, -1), isClosed: true }]
    }
    case 'line':
      return [{ pts: [[L('x1', vw), L('y1', vh)], [L('x2', vw), L('y2', vh)]], isClosed: false }]
    case 'polyline':
    case 'polygon': {
      const v = numList(a.points)
      const pts: Pt[] = []
      for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k]!, v[k + 1]!])

      return pts.length > 1 ? [{ pts, isClosed: el.name === 'polygon' }] : []
    }
    case 'path':
      return pathPolys(a.d ?? '', segs)
    default:
      return []
  }
}

function paintOf(spec: string, ctx: Ctx, alpha: number, scene: Scene, polys: Poly[]): Paint | undefined {
  const url = /^url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(spec.trim())
  if (url) {
    const el = scene.ids.get(url[1]!)
    if (!el || (el.name !== 'linearGradient' && el.name !== 'radialGradient')) return undefined
    const all = polys.flatMap(p => p.pts)
    const xs = all.map(p => p[0])
    const ys = all.map(p => p[1])
    const box: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs) || 1, Math.max(...ys) - Math.min(...ys) || 1]

    return gradient(el, scene.ids, ctx.color, box, ctx.m, alpha)
  }
  const c = parseColor(spec, ctx.color)

  return c && withAlpha(c, alpha)
}

function textOf(el: El): string {
  return (el.text + el.kids.map(textOf).join('')).replace(/\s+/g, ' ')
}

function walk(els: readonly El[], ctx: Ctx, scene: Scene, depth = 0) {
  if (depth > 32) return
  for (const el of els) {
    if (scene.visits >= SVG_MAX_VISITS || scene.work >= SVG_MAX_WORK) return
    scene.visits += 1
    if (SKIP.has(el.name)) continue
    const p = props(el.attrs)
    if (p.display === 'none' || p.visibility === 'hidden') continue
    const c = inherit(ctx, el.attrs)
    if (el.name === 'g' || el.name === 'svg' || el.name === 'a' || el.name === 'switch') {
      walk(el.kids, c, scene, depth + 1)
      continue
    }
    if (el.name === 'use') {
      const ref = scene.ids.get(hrefOf(el.attrs) ?? '')
      if (!ref) continue
      const at: M = [1, 0, 0, 1, len(el.attrs.x, scene.vb[2], c.fontSize), len(el.attrs.y, scene.vb[3], c.fontSize)]
      walk(ref.name === 'symbol' ? ref.kids : [ref], { ...c, m: mul(c.m, at) }, scene, depth + 1)
      continue
    }
    if (el.name === 'text') {
      const text = textOf(el).trim()
      const tspan = el.kids.find(k => k.name === 'tspan')
      const x = len(el.attrs.x ?? tspan?.attrs.x, scene.vb[2], c.fontSize)
      const y = len(el.attrs.y ?? tspan?.attrs.y, scene.vb[3], c.fontSize)
      // Glyphs are a cell tall whatever the font size: the baseline finds the row.
      const [dx, dy] = apply(c.m, [x, y])
      const fill = parseColor(c.fill, c.color)
      if (text) scene.labels.push({ x: dx, y: dy, text, anchor: c.anchor, rgba: fill, isBold: c.isBold })
      continue
    }
    const scale = Math.sqrt(Math.abs(c.m[0] * c.m[3] - c.m[1] * c.m[2])) || 1
    const segs: Segs = l => Math.max(2, Math.min(96, Math.ceil((l * scale) / (scene.S * 0.75))))
    const polys = shapePolys(el, c, scene, segs)
    if (polys.length === 0) continue
    scene.drawn += 1
    const spend = (work: number) => (scene.work = work === Infinity ? SVG_MAX_WORK : scene.work + work)
    const fill = el.name === 'line' ? undefined : paintOf(c.fill, c, c.opacity * c.fillOpacity, scene, polys)
    if (fill) spend(scene.raster.fill(polys.map(poly => poly.pts.map(pt => apply(c.m, pt))), c.rule, fill, SVG_MAX_WORK - scene.work))
    const stroke = scene.work < SVG_MAX_WORK ? paintOf(c.stroke, c, c.opacity * c.strokeOpacity, scene, polys) : undefined
    if (stroke) {
      // Each point of a stroke builds a quad and a disc of up to 17 points.
      spend(polys.reduce((n, poly) => n + poly.pts.length, 0) * STROKE_POINT_WORK)
      if (scene.work >= SVG_MAX_WORK) continue
      // Hairlines widen to one pixel rather than vanish.
      const w = Math.max(scene.S, len(c.sw, Math.hypot(scene.vb[2], scene.vb[3]) / Math.SQRT2, c.fontSize, 1) * scale)
      const pieces = polys.flatMap(poly => strokePolys(poly.pts.map(pt => apply(c.m, pt)), poly.isClosed, w, c.cap))
      spend(scene.raster.fill(pieces, 'nonzero', stroke, SVG_MAX_WORK - scene.work))
    }
  }
}

function indexIds(els: readonly El[], ids: Map<string, El>) {
  for (const el of els) {
    if (el.attrs.id) ids.set(el.attrs.id, el)
    indexIds(el.kids, ids)
  }
}

// ── SMIL: animate, set, animateTransform, animateMotion ─────────────────
// The tree as it stands `t` seconds in: each animation's value laid over
// its target's attributes, so the walk draws a frame as it draws a still.

const ANIM_TAG = /<(?:animate|set|animateTransform|animateMotion|animateColor)[\s/>]/
const COLOR_ATTRS = new Set(['fill', 'stroke', 'stop-color', 'color', 'flood-color', 'lighting-color'])

type Anim = { el: El; target: El; begin: number; dur: number; end: number; ids: Map<string, El> }

// Seconds in a clock value: `2s`, `150ms`, `1.5min`, `00:01.5`, `3`.
function seconds(v: string | undefined): number | undefined {
  const s = v?.trim()
  if (!s) return undefined
  if (s === 'indefinite') return Infinity
  const clock = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s)
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
  const m = /^([-+]?\d*\.?\d+)\s*(h|min|s|ms)?$/.exec(s)
  if (!m) return undefined
  const unit: Record<string, number> = { h: 3600, min: 60, s: 1, ms: 0.001 }

  return Number(m[1]) * (unit[m[2] ?? 's'] ?? 1)
}

// Every animation with its target and its interval. A begin it cannot
// resolve (an event such as `click`) never comes: the target keeps its own
// values, as a page would until the event.
function timings(els: readonly El[]): Anim[] {
  const ids = new Map<string, El>()
  const found: Array<{ el: El; parent?: El }> = []
  const visit = (list: readonly El[], parent?: El) => {
    for (const el of list) {
      if (el.attrs.id) ids.set(el.attrs.id, el)
      if (ANIMS.has(el.name)) found.push({ el, parent })
      else visit(el.kids, el)
    }
  }
  visit(els)
  const byId = new Map(found.filter(f => f.el.attrs.id).map(f => [f.el.attrs.id!, f]))
  const memo = new Map<El, { begin: number; dur: number; end: number }>()
  const resolve = (f: { el: El }, depth = 0): { begin: number; dur: number; end: number } => {
    const known = memo.get(f.el)
    if (known) return known
    const never = { begin: Infinity, dur: Infinity, end: Infinity }
    if (depth > 16) return never
    const a = f.el.attrs
    let begin = Infinity
    for (const part of (a.begin ?? '0s').split(';')) {
      const p = part.trim()
      const offset = seconds(p)
      if (offset !== undefined) {
        if (Number.isFinite(offset)) begin = Math.min(begin, offset)
        continue
      }
      const sync = /^([\w-]+)\.(begin|end)\s*(?:([+-])\s*(.+))?$/.exec(p)
      const other = sync && byId.get(sync[1]!)
      if (!sync || !other) continue
      const r = resolve(other, depth + 1)
      const shift = (seconds(sync[4]) ?? 0) * (sync[3] === '-' ? -1 : 1)
      const at = (sync[2] === 'begin' ? r.begin : r.end) + shift
      if (Number.isFinite(at)) begin = Math.min(begin, at)
    }
    if (!Number.isFinite(begin)) {
      memo.set(f.el, never)

      return never
    }
    // No `dur` is an indefinite simple duration: the value holds from its begin.
    const dur = seconds(a.dur) ?? Infinity
    const count = a.repeatCount
    const repeatDur = seconds(a.repeatDur)
    let active = dur
    if (count === 'indefinite') active = Infinity
    else if (Number(count) > 0) active = dur * Number(count)
    if (repeatDur !== undefined) active = count ? Math.min(active, repeatDur) : repeatDur
    const end = seconds(a.end)
    if (end !== undefined && end > begin) active = Math.min(active, end - begin)
    const r = { begin, dur, end: begin + active }
    memo.set(f.el, r)

    return r
  }

  return found.flatMap(f => {
    const target = ids.get(hrefOf(f.el.attrs) ?? '') ?? f.parent
    if (!target) return []
    const r = resolve(f)

    return Number.isFinite(r.begin) ? [{ el: f.el, target, ids, ...r }] : []
  })
}

// When the drawing stops changing (Infinity for a loop), and the time of
// the still it rests on: the last moment any finite animation changes.
function settle(anims: readonly Anim[]): { endS: number; restS: number } {
  const changes = anims.map(a => (Number.isFinite(a.dur) ? a.end : a.begin))
  const finite = changes.filter(Number.isFinite)

  return { endS: Math.max(0, ...changes), restS: Math.max(0, ...finite) }
}

// Whether a drawing animates, and for how long; undefined for a still.
export function animation(body: string): { endMs: number } | undefined {
  if (!ANIM_TAG.test(body)) return undefined
  const anims = timings(rootOf(body, {}).els)
  if (anims.length === 0) return undefined

  return { endMs: settle(anims).endS * 1000 }
}

function lerpText(a: string, b: string, f: number): string | undefined {
  const na = a.match(NUM) ?? []
  const nb = b.match(NUM) ?? []
  if (na.length === 0 || na.length !== nb.length) return undefined
  let k = 0

  return a.replace(NUM, () => {
    const v = Number(na[k]) + (Number(nb[k]) - Number(na[k])) * f
    k += 1

    return String(+v.toFixed(4))
  })
}

function lerp(name: string, a: string, b: string, f: number): string {
  if (COLOR_ATTRS.has(name)) {
    const ca = parseColor(a, '#000')
    const cb = parseColor(b, '#000')
    if (ca && cb) {
      const c = ca.map((v, k) => v + ((cb[k] ?? v) - v) * f)

      return `rgba(${Math.round(c[0]!)},${Math.round(c[1]!)},${Math.round(c[2]!)},${+c[3]!.toFixed(3)})`
    }
  }

  // What does not interpolate switches halfway, as a discrete value would.
  return lerpText(a, b, f) ?? (f < 0.5 ? a : b)
}

// A cubic-bezier ease: y at x, by bisection.
function ease([x1 = 0, y1 = 0, x2 = 1, y2 = 1]: readonly number[], x: number): number {
  const at = (t: number, p1: number, p2: number) => 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t
  let lo = 0
  let hi = 1
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2
    if (at(mid, x1, x2) < x) lo = mid
    else hi = mid
  }

  return at((lo + hi) / 2, y1, y2)
}

// Where `p` (0..1 of a simple duration) falls among the values.
function pick(a: Attrs, values: readonly string[], p: number, mode: string, mix: (x: string, y: string, f: number) => string): string {
  const n = values.length
  if (n === 1) return values[0]!
  const given = a.keyTimes?.split(';').map(Number)
  const times = given?.length === n && given.every(Number.isFinite) ? given : undefined
  if (mode === 'discrete') {
    if (!times) return values[Math.min(n - 1, Math.floor(p * n))]!
    let i = 0
    times.forEach((k, j) => {
      if (k <= p) i = j
    })

    return values[i]!
  }
  const kt = times ?? values.map((_, i) => i / (n - 1))
  let i = 0
  while (i < n - 2 && p >= kt[i + 1]!) i++
  const span = kt[i + 1]! - kt[i]!
  let f = Math.max(0, Math.min(1, span > 0 ? (p - kt[i]!) / span : 1))
  if (mode === 'spline') {
    const spline = a.keySplines?.split(';')[i]
    if (spline) f = ease(numList(spline), f)
  }

  return mix(values[i]!, values[i + 1]!, f)
}

// The progress through the simple duration at `t`, or undefined while the
// animation has no say (not begun, or ended without `fill="freeze"`).
function progress(an: Anim, t: number): number | undefined {
  if (t < an.begin) return undefined
  if (t < an.end) return Number.isFinite(an.dur) && an.dur > 0 ? ((t - an.begin) % an.dur) / an.dur : 0
  if (an.el.attrs.fill !== 'freeze') return undefined
  if (!Number.isFinite(an.dur) || an.dur <= 0) return 0
  const span = an.end - an.begin
  const rest = span - Math.floor(span / an.dur) * an.dur

  // Frozen at a whole number of repeats: the last value, not the first.
  return rest < 1e-9 ? 1 : rest / an.dur
}

function motionAt(an: Anim, p: number): string | undefined {
  const a = an.el.attrs
  const mpath = an.el.kids.find(k => k.name === 'mpath')
  let d = a.path ?? (mpath ? an.ids.get(hrefOf(mpath.attrs) ?? '')?.attrs.d : undefined)
  if (!d) {
    const pts = a.values?.split(';') ?? [a.from, a.to].filter((v): v is string => v !== undefined)
    if (pts.length > 0) d = 'M' + pts.join(' L')
  }
  const line = pathPolys(d ?? '', () => 16).flatMap(poly => poly.pts)
  if (line.length === 0) return undefined
  const lens = [0]
  for (let k = 1; k < line.length; k++) lens.push(lens[k - 1]! + Math.hypot(line[k]![0] - line[k - 1]![0], line[k]![1] - line[k - 1]![1]))
  // Paced: equal distance in equal time, whatever the calcMode.
  const want = Math.max(0, Math.min(1, p)) * lens[lens.length - 1]!
  let k = 1
  while (k < line.length - 1 && lens[k]! < want) k++
  const [ax, ay] = line[k - 1] ?? line[0]!
  const [bx, by] = line[k] ?? line[0]!
  const seg = (lens[k] ?? 0) - (lens[k - 1] ?? 0)
  const f = seg > 0 ? (want - lens[k - 1]!) / seg : 0
  const x = ax + (bx - ax) * f
  const y = ay + (by - ay) * f
  const auto = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI
  const turn = a.rotate === 'auto' ? auto : a.rotate === 'auto-reverse' ? auto + 180 : Number(a.rotate) || 0

  return `translate(${+x.toFixed(3)} ${+y.toFixed(3)})${turn ? ` rotate(${+turn.toFixed(2)})` : ''}`
}

function animated(els: readonly El[], anims: readonly Anim[], t: number): El[] {
  const over = new Map<El, Attrs>()
  const motion = new Map<El, string>()
  for (const an of anims) {
    const p = progress(an, t)
    if (p === undefined) continue
    const a = an.el.attrs
    const base = over.get(an.target) ?? (({ style: _, ...rest }) => rest)(props(an.target.attrs))
    over.set(an.target, base)
    if (an.el.name === 'animateMotion') {
      const m = motionAt(an, p)
      if (m) motion.set(an.target, m)
      continue
    }
    const isTransform = an.el.name === 'animateTransform'
    const name = isTransform ? 'transform' : a.attributeName
    if (!name) continue
    const type = a.type ?? 'translate'
    const own = isTransform ? '' : base[name] ?? ''
    let values: string[]
    if (an.el.name === 'set') values = [a.to ?? '']
    else if (a.values) values = a.values.split(';').map(v => v.trim()).filter(Boolean)
    else if (a.by !== undefined && a.to === undefined) {
      const from = a.from ?? (isTransform ? a.by.replace(NUM, '0') : own || '0')
      values = [from, sum(from, a.by)]
    } else values = [a.from ?? own, a.to ?? own]
    if (values.length === 0) continue
    const mode = an.el.name === 'set' ? 'discrete' : (a.calcMode ?? 'linear')
    const v = pick(a, values, p, mode, (x, y, f) => lerp(name, x, y, f))
    if (isTransform) {
      const step = `${type}(${v})`
      base.transform = a.additive === 'sum' && base.transform ? `${base.transform} ${step}` : step
    } else base[name] = a.additive === 'sum' && own ? sum(own, v) : v
  }
  // Motion lies over every other transform of its target.
  for (const [el, m] of motion) {
    const attrs = over.get(el)!
    attrs.transform = attrs.transform ? `${m} ${attrs.transform}` : m
  }
  const copy = (el: El): El => ({ ...el, attrs: over.get(el) ?? el.attrs, kids: el.kids.map(copy) })

  return els.map(copy)
}

// Two values added number by number, as `additive="sum"` and `by` ask;
// `b` alone where their numbers do not line up.
function sum(a: string, b: string): string {
  const na = a.match(NUM) ?? []
  const nb = b.match(NUM) ?? []
  if (na.length === 0 || na.length !== nb.length) return b
  let k = 0

  return a.replace(NUM, n => String(+(Number(n) + Number(nb[k++])).toFixed(4)))
}

// ── native surfaces: the markup as written, for a surface that draws SVG ─

const OWN = new Set(['title', 'cols', 'rows', 'mode', 'bg', 'background', 'width', 'height'])
const CASED: Record<string, string> = { viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio' }

function quoteAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// What a surface's own SVG element is handed holds nothing that reaches
// past the drawing: no script or handler (the surfaces strip those too),
// and nothing loaded from elsewhere. An animated drawing shows in a frame,
// where an external <image> would be fetched, and its URL could carry
// whatever a reply was steered into writing there. The cells draw none of
// these either.
const UNSAFE = new Set(['script', 'foreignObject', 'image', 'feImage', 'iframe', 'style', 'object', 'embed', 'audio', 'video'])

function isSafeAttr(k: string, v: string): boolean {
  if (/^on/i.test(k)) return false
  if (/^(?:xlink:)?href$/i.test(k)) return v.trim().startsWith('#')

  return !/url\(\s*['"]?\s*(?!#)/i.test(v)
}

const TONED = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'color'])

// An attribute as a browser should read it: the style's tone names turned
// to colors it knows.
function nativeAttr(k: string, v: string): string {
  const hex = TONED.has(k) && /^[\w-]+$/.test(v) && !CSS[v.toLowerCase()] ? HEX_OF[tone(v) ?? ''] : undefined

  return ` ${k}="${quoteAttr(hex ?? v)}"`
}

// The markup read as the cells read it and written again, well formed:
// unsafe elements left out with all they hold, unsafe attributes dropped,
// declarations and comments gone, every open element closed.
function nativeMarkup(src: string): string {
  let out = ''
  const stack: string[] = []
  // Elements opened inside an unsafe one, itself included.
  let skipped = 0
  for (const m of src.matchAll(TOKEN)) {
    if (m[5] !== undefined) {
      if (!skipped) out += escapeText(decode(m[5]))
      continue
    }
    const name = m[2]
    if (!name) continue
    if (m[1]) {
      if (skipped) {
        skipped -= 1
        continue
      }
      // A close with no open element of its name is dropped; one with
      // closes what was left open inside it too.
      const at = stack.lastIndexOf(name)
      if (at === -1) continue
      out += stack.splice(at).reverse().map(open => `</${open}>`).join('')
      continue
    }
    const attrs = xmlAttrs(m[3] ?? '')
    // An animation of a link could set it to an address elsewhere.
    const isUnsafe = UNSAFE.has(name) || (ANIMS.has(name) && /href$/i.test(attrs.attributeName ?? ''))
    if (skipped || isUnsafe) {
      if (!m[4]) skipped += 1
      continue
    }
    const safe = Object.entries(attrs).filter(([k, v]) => isSafeAttr(k, v))
    out += `<${name}${safe.map(([k, v]) => nativeAttr(k, v)).join('')}${m[4] ? '/' : ''}>`
    if (!m[4]) stack.push(name)
  }

  return out + stack.reverse().map(name => `</${name}>`).join('')
}

// The widest a surface's own drawing is set, in cells of 8 CSS pixels.
const NATIVE_MAX_COLS = 200

// What a surface with its own SVG element is handed: a whole document.
export function nativeSvg(body: string, attrs: Attrs): { source: string; alt: string; width: number; isAnimated: boolean } {
  const { els } = rootOf(body, {})
  const isWhole = els.length === 1 && els[0]!.name === 'svg'
  // A background only as a color, so it cannot name an image elsewhere.
  const bg = parseColor(attrs.bg ?? attrs.background, '#000')
  const head = Object.entries(attrs)
    .filter(([k, v]) => !OWN.has(k) && isSafeAttr(k, v))
    .map(([k, v]) => `${CASED[k] ?? k}="${quoteAttr(v)}"`)
  if (bg) head.push(`style="background:${rgbToHex(bg)}"`)
  const source = isWhole ? nativeMarkup(body.trim()) : `<svg ${['xmlns="http://www.w3.org/2000/svg"', ...head].join(' ')}>${nativeMarkup(body)}</svg>`
  const words = (list: readonly El[]): string[] => list.flatMap(el => (el.name === 'text' ? [textOf(el).trim()] : words(el.kids)))
  const alt = attrs.title ?? (words(els).filter(Boolean).join(', ') || 'a drawing')

  return { source, alt, width: Math.min(NATIVE_MAX_COLS, Number(attrs.cols) || 48) * 8, isAnimated: ANIM_TAG.test(body) }
}

// ── cells ───────────────────────────────────────────────────────────────

const BRAILLE = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]

type Px = Rgba | undefined

const cache = new Map<string, Row[]>()

// `t`, seconds into the animation; absent, the still it comes to rest on.
export function svg(body: string, attrs: Attrs, avail: number, t?: number): Row[] {
  const key = JSON.stringify([body, attrs, avail, t])
  const hit = cache.get(key)
  if (hit) return hit
  const rows = draw(body, attrs, avail, t)
  cache.set(key, rows)
  if (cache.size > 24) cache.delete(cache.keys().next().value!)

  return rows
}

// The reply's tag is the root element; an <svg> inside it may carry its own.
function rootOf(body: string, blockAttrs: Attrs): { els: El[]; root: Attrs } {
  const els = parseXml(body)
  const root: Attrs = { ...blockAttrs, viewBox: blockAttrs.viewbox ?? blockAttrs.viewBox ?? '' }
  if (els.length === 1 && els[0]!.name === 'svg') return { els: els[0]!.kids, root: { ...root, ...els[0]!.attrs } }

  return { els, root }
}

// The tallest drawing `rows` may ask for: two screens of a tall terminal.
const SVG_MAX_ROWS = 80

function draw(body: string, blockAttrs: Attrs, avail: number, t?: number): Row[] {
  let { els, root } = rootOf(body, blockAttrs)
  const anims = timings(els)
  if (anims.length > 0) els = animated(els, anims, t ?? settle(anims).restS)
  const isBraille = /^braille|^dots|^line/.test(blockAttrs.mode ?? '')
  const pxW = isBraille ? 2 : 1
  const pxH = isBraille ? 4 : 2
  const S = isBraille ? 2 : 4

  const vbList = numList(root.viewBox)
  const vb: [number, number, number, number] =
    vbList.length >= 4 && vbList[2]! > 0 && vbList[3]! > 0
      ? (vbList.slice(0, 4) as [number, number, number, number])
      : [0, 0, parseFloat(root.width ?? '') || 100, parseFloat(root.height ?? '') || 100]
  const aspect = vb[3] / vb[2]
  const maxRows = Number(blockAttrs.rows) > 0 ? Math.max(1, Math.min(SVG_MAX_ROWS, Number(blockAttrs.rows))) : 40
  let cols = Math.max(2, Math.min(avail, Number(blockAttrs.cols) || Math.min(avail, 48)))
  if (!blockAttrs.cols && blockAttrs.rows) cols = Math.max(2, Math.min(avail, Math.round((maxRows * pxH) / aspect / pxW)))
  // The pixels are near square, so the viewBox's shape gives the row count.
  let rowsN = Math.ceil((cols * pxW * aspect) / pxH)
  if (rowsN > maxRows) {
    rowsN = maxRows
    cols = Math.max(2, Math.min(cols, Math.round((maxRows * pxH) / aspect / pxW)))
  }

  const gw = cols * pxW * S
  const gh = rowsN * pxH * S
  const k = gw / vb[2]
  const ids = new Map<string, El>()
  indexIds(els, ids)
  const scene: Scene = { raster: new Raster(gw, gh), ids, vb, S, labels: [], drawn: 0, visits: 0, work: 0 }
  const base: Ctx = {
    m: [k, 0, 0, k, -vb[0] * k, -vb[1] * k],
    fill: 'black',
    stroke: 'none',
    sw: '1',
    opacity: 1,
    fillOpacity: 1,
    strokeOpacity: 1,
    rule: 'nonzero',
    cap: 'butt',
    fontSize: 16,
    anchor: 'start',
    isBold: false,
    color: HEX_OF.claude!,
  }
  const rootAttrs = { ...root }
  delete rootAttrs.width
  delete rootAttrs.height
  walk(els, inherit(base, rootAttrs), scene)

  const title: Row[] = blockAttrs.title ? [{ runs: [{ bold: true, text: blockAttrs.title }] }] : []
  if (scene.drawn === 0 && scene.labels.length === 0) return title

  // Pixels: the mean of their samples, laid over `bg` when one is given.
  const bg = parseColor(root.bg ?? root.background, base.color)
  const pw = cols * pxW
  const ph = rowsN * pxH
  const px: Px[] = new Array(pw * ph)
  const buf = scene.raster.buf
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * gw + x * S + sx) * 4
          r += buf[i]!
          g += buf[i + 1]!
          b += buf[i + 2]!
          a += buf[i + 3]!
        }
      }
      const n = S * S
      if (bg) {
        const keep = 1 - a / n
        px[y * pw + x] = [r / n + bg[0] * keep, g / n + bg[1] * keep, b / n + bg[2] * keep, 1]
      } else px[y * pw + x] = a / n >= 0.5 ? [r / a, g / a, b / a, 1] : undefined
    }
  }
  const at = (x: number, y: number) => px[y * pw + x]
  const hex = (c: Px) => (c ? rgbToHex(c) : undefined)

  // Labels on the cells they fall in, over whatever is drawn there.
  const glyphs = new Map<number, { ch: string; fg?: string; isBold: boolean }>()
  const cellW = pxW * S
  const cellH = pxH * S
  for (const l of scene.labels) {
    const w = width(l.text)
    // The baseline sits near the bottom of the cell the glyphs fill.
    const row = Math.max(0, Math.floor(l.y / cellH - 0.4))
    if (l.y < 0 || row >= rowsN) continue
    const centre = l.x / cellW
    let col = Math.round(l.anchor === 'middle' ? centre - w / 2 : l.anchor === 'end' ? centre - w : centre)
    col = Math.max(0, Math.min(cols - w, col))
    for (const ch of l.text) {
      const fg = l.rgba ? hex(l.rgba) : undefined
      if (col >= 0 && col < cols) glyphs.set(row * cols + col, { ch, fg, isBold: l.isBold })
      // A wide glyph covers the next cell too: that cell draws nothing.
      if (width(ch) === 2 && col + 1 < cols) glyphs.set(row * cols + col + 1, { ch: '', fg, isBold: l.isBold })
      col += width(ch)
    }
  }

  const rows: Row[] = []
  for (let r = 0; r < rowsN; r++) {
    const runs: Run[] = []
    const push = (run: Run) => {
      const last = runs[runs.length - 1]
      if (last && last.fg === run.fg && last.bg === run.bg && last.bold === run.bold) last.text += run.text
      else runs.push(run)
    }
    for (let c = 0; c < cols; c++) {
      const glyph = glyphs.get(r * cols + c)
      if (isBraille) {
        let bits = 0
        const sum = [0, 0, 0]
        let lit = 0
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const p = at(c * 2 + dx, r * 4 + dy)
            if (!p) continue
            bits |= BRAILLE[dy]![dx]!
            p.slice(0, 3).forEach((v, k) => (sum[k]! += v))
            lit += 1
          }
        }
        if (glyph) push({ fg: glyph.fg, bold: glyph.isBold || undefined, text: glyph.ch })
        else push({ fg: lit ? rgbToHex(sum.map(v => v / lit)) : undefined, text: bits ? String.fromCharCode(0x2800 + bits) : ' ' })
        continue
      }
      const top = at(c, r * 2)
      const bot = at(c, r * 2 + 1)
      if (glyph) {
        const under = top && bot ? rgbToHex(top.map((v, k) => (v + (bot[k] ?? v)) / 2)) : hex(top ?? bot)
        push({ fg: glyph.fg, bg: under, bold: glyph.isBold || undefined, text: glyph.ch })
      } else if (top && bot) {
        const [t, b] = [hex(top), hex(bot)]
        push(t === b ? { fg: t, text: '█' } : { fg: t, bg: b, text: '▀' })
      } else if (top) push({ fg: hex(top), text: '▀' })
      else if (bot) push({ fg: hex(bot), text: '▄' })
      else push({ text: ' ' })
    }
    const tail = runs[runs.length - 1]
    if (tail && !tail.bg && !tail.fg) tail.text = tail.text.trimEnd()
    rows.push({ runs: runs.filter(run => run.text) })
  }

  return [...title, ...rows]
}
