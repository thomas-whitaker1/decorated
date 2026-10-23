// Styled text as plain data: everything the widgets draw is rows of runs,
// which register.tsx turns into Text elements.

export type Style = {
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  dim?: boolean
  inverse?: boolean
}

export type Run = Style & { text: string }

// `lead` is a fixed-width gutter (a bullet, a key) the wrapped `runs` hang from.
export type Row = { lead?: Run[]; runs: Run[]; wrap?: boolean }

// Tone names the model writes, mapped to the person's theme keys.
const TONES: Record<string, string> = {
  ok: 'success',
  success: 'success',
  done: 'success',
  pass: 'success',
  warn: 'warning',
  warning: 'warning',
  err: 'error',
  error: 'error',
  fail: 'error',
  info: 'suggestion',
  note: 'suggestion',
  tip: 'autoAccept',
  accent: 'claude',
  claude: 'claude',
  plan: 'planMode',
  dim: 'inactive',
  muted: 'inactive',
}

export const SERIES = ['claude', 'suggestion', 'success', 'autoAccept', 'warning', 'planMode']

const NAMED = /^(black|red|green|yellow|blue|magenta|cyan|white|gray|grey)(Bright)?$/i
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export function tone(name: string | undefined): string | undefined {
  if (!name) return undefined
  const key = name.trim()
  if (TONES[key.toLowerCase()]) return TONES[key.toLowerCase()]
  if (HEX.test(key) || NAMED.test(key)) return key
  if (/^[a-zA-Z]+$/.test(key)) return key // a theme key the person's theme holds

  return undefined
}

export function isTone(name: string): boolean {
  return Boolean(TONES[name.toLowerCase()])
}

function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  )
}

// Terminal cells a string takes: wide CJK and emoji count two, joiners none.
export function width(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c === 0x200d || (c >= 0x300 && c <= 0x36f) || (c >= 0xfe00 && c <= 0xfe0f)) continue
    w += isWide(c) ? 2 : 1
  }

  return w
}

export function runsWidth(runs: readonly Run[]): number {
  return runs.reduce((n, r) => n + width(r.text), 0)
}

export function clip(s: string, cells: number): string {
  if (width(s) <= cells) return s
  let out = ''
  for (const ch of s) {
    if (width(out + ch) > cells - 1) break
    out += ch
  }

  return out + '…'
}

export function pad(s: string, cells: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const gap = Math.max(0, cells - width(s))
  if (align === 'right') return ' '.repeat(gap) + s
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(Math.ceil(gap / 2))

  return s + ' '.repeat(gap)
}

// The first number in a cell ("120ms", "1,204", "-3.5%"), or undefined.
export function num(s: string): number | undefined {
  const m = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/.exec(s)
  if (!m) return undefined
  const n = Number(m[0].replace(/,/g, ''))

  return Number.isFinite(n) ? n : undefined
}

export function nums(s: string): number[] {
  return s
    .split(/[\s,;]+/)
    .map(t => num(t))
    .filter((n): n is number => n !== undefined)
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// A horizontal bar of `cells` at most, to the nearest eighth of a cell.
export function bar(frac: number, cells: number): string {
  const total = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * cells
  const full = Math.floor(total)
  const rest = Math.round((total - full) * 8)
  if (rest === 8) return '█'.repeat(full + 1)

  return '█'.repeat(full) + EIGHTHS[rest]
}

const TICKS = '▁▂▃▄▅▆▇█'

export function spark(values: readonly number[]): string {
  if (values.length === 0) return ''
  const lo = Math.min(...values)
  const hi = Math.max(...values)

  return values
    .map(v => (hi === lo ? TICKS[3] : TICKS[Math.round(((v - lo) / (hi - lo)) * (TICKS.length - 1))]))
    .join('')
}

// Trailing `{tone}` on a line: `build {ok}` → ['build', 'success'].
export function splitTone(s: string): [string, string | undefined] {
  const m = /\s*\{([\w#-]+)\}\s*$/.exec(s)
  if (!m) return [s.trim(), undefined]

  return [s.slice(0, m.index).trim(), tone(m[1])]
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = [...h].map(c => c + c).join('')
  const n = parseInt(h, 16)

  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex(rgb: readonly number[]): string {
  return '#' + rgb.slice(0, 3).map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
}

export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a)
  const y = hexToRgb(b)

  return rgbToHex(x.map((v, i) => v + ((y[i] ?? v) - v) * t))
}

// A ramp through several stops, `t` in 0..1.
export function ramp(stops: readonly string[], t: number): string {
  const c = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(c))

  return mix(stops[i] ?? '#000000', stops[i + 1] ?? stops[i] ?? '#000000', c - i)
}

// Theme keys have no hex value a mod can read, so gradients use these.
export const HEX_OF: Record<string, string> = {
  claude: '#d77757',
  success: '#4eba65',
  warning: '#ffc107',
  error: '#ff6b80',
  suggestion: '#b1b9f9',
  autoAccept: '#af87ff',
  planMode: '#48968c',
  inactive: '#999999',
}

export function hexOf(color: string | undefined, fallback: string): string {
  if (!color) return fallback
  if (HEX.test(color)) return color

  return HEX_OF[tone(color) ?? color] ?? fallback
}

export const HEAT = ['#22305a', '#2f5d8a', '#2f8f9d', '#5fb88a', '#d8c25a', '#e98b4a', '#d9534f']

// Relative luminance, 0 (black) to 1 (white), to pick text over a fill.
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const c = v / 255

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
