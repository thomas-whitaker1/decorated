// Splits a reply into plain markdown and decorated parts, and turns inline
// markup into styled runs. Only the tag names below are markup: anything
// else in angle brackets (`Array<string>`, `<div>`) stays text, and nothing
// inside a code span or a fence is ever read as a tag.

import { bar, clip, hexOf, mix, nums, pad, runsWidth, spark, tone, type Row, type Run, type Style, width } from './text'

export const BLOCK_TAGS = new Set([
  'callout',
  'cols',
  'col',
  'bars',
  'chart',
  'heat',
  'flow',
  'seq',
  'tree',
  'steps',
  'timeline',
  'kv',
  'rule',
  'banner',
  'svg',
])

export const INLINE_TAGS = new Set([
  'ok',
  'warn',
  'err',
  'info',
  'dim',
  'accent',
  'hl',
  'c',
  'kbd',
  'badge',
  'grad',
  'spark',
  'meter',
])

export type Attrs = Record<string, string>

export type Block =
  | { kind: 'md'; text: string }
  | { kind: 'rich'; text: string }
  | { kind: 'tag'; name: string; attrs: Attrs; body: string; isClosed: boolean }

const ATTR = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g

export function parseAttrs(s: string): Attrs {
  const attrs: Attrs = {}
  for (const m of s.matchAll(ATTR)) attrs[(m[1] ?? '').toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''

  return attrs
}

const FENCE = /^\s*(`{3,}|~{3,})/

// Code spans and fences blanked to spaces, so tag searches skip them, and
// the offsets of the lines that start outside a fence.
function masking(text: string): { mask: string; clean: Set<number> } {
  let inFence: string | undefined
  const clean = new Set<number>()
  let at = 0
  const lines = text.split('\n').map(line => {
    if (!inFence) clean.add(at)
    at += line.length + 1
    const fence = FENCE.exec(line)?.[1]
    if (inFence) {
      if (fence && fence[0] === inFence[0] && fence.length >= inFence.length) inFence = undefined

      return ' '.repeat(line.length)
    }
    if (fence) {
      inFence = fence

      return ' '.repeat(line.length)
    }

    return line.replace(/(`+)[^`]*?\1/g, m => ' '.repeat(m.length))
  })

  return { mask: lines.join('\n'), clean }
}

function masked(text: string): string {
  return masking(text).mask
}

const INLINE_RE = new RegExp(`</?(?:${[...INLINE_TAGS].join('|')})(?=[\\s>/])`)

export function hasInline(text: string): boolean {
  return INLINE_RE.test(masked(text))
}

export function hasMarkup(text: string): boolean {
  const m = masked(text)

  return INLINE_RE.test(m) || new RegExp(`(^|\\n)\\s*<(?:${[...BLOCK_TAGS].join('|')})(?=[\\s>/])`).test(m)
}

// A tag's insides up to its `>`: a quoted value may hold `>` or `/>` (a title
// with inline markup), and an unterminated quote falls back to a plain char.
// Each piece is taken whole (a lookahead and its backreference), so a match
// that fails never retries a quoted value as plain chars: hostile quotes
// cost linear time, not exponential.
const INSIDE = String.raw`(?:(?=(?<piece>"[^"]*"|'[^']*'|[^>]))\k<piece>)`
// Groups: name, attributes, INSIDE's piece, self-close, the text after `>`.
const OPEN_LINE = new RegExp(String.raw`^\s*<([a-z]+)((?:\s+${INSIDE}*?)?)\s*(\/?)>(.*)$`)
// The most pieces a tag inside a body may hold before its `>`, so a body
// full of unfinished tags is searched in linear time.
const TAG_PIECES = 1024

// Where `</name>` closes the tag opened before `from`, counting nested ones
// of the same name, in text whose code spans and fences are masked.
function findClose(m: string, name: string, from: number): { at: number; end: number } | undefined {
  const re = new RegExp(`<(/?)${name}(?=[\\s>/])(${INSIDE}{0,${TAG_PIECES}}?)>`, 'g')
  re.lastIndex = from
  let depth = 1
  for (let hit = re.exec(m); hit; hit = re.exec(m)) {
    if (hit[1]) depth -= 1
    else if (!(hit[2] ?? '').trimEnd().endsWith('/')) depth += 1
    if (depth === 0) return { at: hit.index, end: hit.index + hit[0].length }
  }

  return undefined
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let md: string[] = []
  const flush = () => {
    if (md.length > 0) blocks.push(...splitRich(md.join('\n')))
    md = []
  }

  // The reply is masked once, and each block's close searched in it from the
  // block's start, so a reply of many blocks parses in one pass. A body that
  // starts where that mask would differ from the body's own is masked apart.
  const { mask, clean } = masking(text)
  let at = 0
  let inFence: string | undefined
  while (at < text.length) {
    const nl = text.indexOf('\n', at)
    const end = nl === -1 ? text.length : nl
    const next = nl === -1 ? text.length : nl + 1
    const line = text.slice(at, end)
    const fence = FENCE.exec(line)?.[1]
    if (inFence) {
      if (fence && fence[0] === inFence[0] && fence.length >= inFence.length) inFence = undefined
      md.push(line)
      at = next
      continue
    }
    if (fence) {
      inFence = fence
      md.push(line)
      at = next
      continue
    }

    const open = OPEN_LINE.exec(line)
    if (!open || !BLOCK_TAGS.has(open[1] ?? '')) {
      md.push(line)
      at = next
      continue
    }

    flush()
    const [, name = '', rawAttrs = '', , selfClose, tail = ''] = open
    const attrs = parseAttrs(rawAttrs)
    // The body starts right after `>`: on the same line when the tag holds
    // text there, else on the next line.
    const from = tail.trim() ? end - tail.length : next
    if (selfClose) {
      blocks.push({ kind: 'tag', name, attrs, body: '', isClosed: true })
      at = from
      continue
    }

    const isMasked = from === next ? clean.has(next) : clean.has(at) && !/[`~]/.test(line)
    const close = isMasked ? findClose(mask, name, from) : shift(findClose(masked(text.slice(from)), name, 0), from)
    if (!close) {
      // Unclosed: a reply still streaming, or a forgotten close. Draw what is there.
      blocks.push({ kind: 'tag', name, attrs, body: trimBody(text.slice(from)), isClosed: false })
      break
    }
    blocks.push({ kind: 'tag', name, attrs, body: trimBody(text.slice(from, close.at)), isClosed: true })
    const left = text.slice(close.end)
    at = left.startsWith('\n') ? close.end + 1 : left.trim() ? close.end : close.end + /^[^\n]*\n?/.exec(left)![0].length
  }
  flush()

  return blocks
}

function shift(span: { at: number; end: number } | undefined, by: number): { at: number; end: number } | undefined {
  return span && { at: span.at + by, end: span.end + by }
}

function trimBody(s: string): string {
  return s.replace(/^\s*\n/, '').replace(/\n\s*$/, '')
}

// Plain markdown stays one block for the engine's own renderer; only the
// paragraphs holding inline markup are drawn by hand.
function splitRich(text: string): Block[] {
  if (!hasInline(text)) return text.trim() ? [{ kind: 'md', text }] : []

  const groups: string[][] = [[]]
  let inFence: string | undefined
  for (const line of text.split('\n')) {
    const fence = FENCE.exec(line)?.[1]
    if (inFence) {
      if (fence && fence[0] === inFence[0] && fence.length >= inFence.length) inFence = undefined
    } else if (fence) {
      inFence = fence
    } else if (!line.trim()) {
      groups.push([])
      continue
    }
    groups[groups.length - 1]?.push(line)
  }

  const out: Block[] = []
  for (const group of groups.filter(g => g.length > 0)) {
    const chunk = group.join('\n')
    const kind = hasInline(chunk) ? 'rich' : 'md'
    const last = out[out.length - 1]
    if (kind === 'md' && last?.kind === 'md') last.text += '\n\n' + chunk
    else out.push({ kind, text: chunk })
  }

  return out
}

// ── inline ──────────────────────────────────────────────────────────────

export type Inline =
  | { t: 'text'; s: string }
  | { t: 'code'; s: string }
  | { t: 'tag'; name: string; attrs: Attrs; kids: Inline[] }

const TAG_AT = /^<(\/?)([a-z]+)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>/]+))?)*)\s*(\/?)>/

export function parseInline(s: string): Inline[] {
  const root: Inline[] = []
  const stack: Array<{ name: string; kids: Inline[] }> = [{ name: '', kids: root }]
  let text = ''
  const top = () => stack[stack.length - 1]?.kids ?? root
  const flush = () => {
    if (text) top().push({ t: 'text', s: text })
    text = ''
  }

  for (let i = 0; i < s.length; ) {
    const ch = s[i]
    if (ch === '`') {
      const run = /^`+/.exec(s.slice(i))![0]
      const end = s.indexOf(run, i + run.length)
      if (end !== -1) {
        flush()
        top().push({ t: 'code', s: s.slice(i + run.length, end).replace(/^ (.*) $/, '$1') })
        i = end + run.length
        continue
      }
    }
    if (ch === '\\' && s[i + 1] === '<') {
      text += '<'
      i += 2
      continue
    }
    if (ch === '<') {
      const m = TAG_AT.exec(s.slice(i))
      if (m && INLINE_TAGS.has(m[2] ?? '')) {
        const [whole, closing, name = '', rawAttrs = '', selfClose] = m
        flush()
        if (closing) {
          const at = stack.map(f => f.name).lastIndexOf(name)
          if (at > 0) stack.length = at // closes it and anything left open inside
        } else {
          const kids: Inline[] = []
          top().push({ t: 'tag', name, attrs: parseAttrs(rawAttrs), kids })
          if (!selfClose) stack.push({ name, kids })
        }
        i += whole.length
        continue
      }
    }
    text += ch
    i += 1
  }
  flush()

  return root
}

function plain(nodes: readonly Inline[]): string {
  return nodes.map(n => (n.t === 'tag' ? plain(n.kids) : n.s)).join('')
}

// A span holds at most 500 characters and a link's target 2048: unbounded,
// each opener with no closer scans to the end of the line, and a long line
// of them costs quadratic time.
const EMPHASIS =
  /(\*\*|__)(?=\S)(.{1,500}?)(?<=\S)\1|(?<![\w*])\*(?=\S)(.{1,500}?)(?<=\S)\*(?!\*)|(?<![\w_])_(?=\S)(.{1,500}?)(?<=\S)_(?![\w_])|~~(.{1,500}?)~~|\[([^\]]{1,500})\]\(([^)\s]{1,2048})\)/dg

const BOLD = 1
const ITALIC = 2
const STRIKE = 4
const LINK = 8
const FLAG_OF: Record<number, number> = { 2: BOLD, 3: ITALIC, 4: ITALIC, 5: STRIKE, 6: LINK }

// A styled piece; `isRaw` ones (code, keys, badges, gauges) hold no markdown.
type Piece = Run & { isRaw?: boolean }

// Markdown's inline emphasis and links over a whole line of pieces, so
// `**bold <ok>tag</ok>**` spans the tag: the delimiters are found in the
// joined text, cut out, and their styles laid over what they enclose.
function emphasis(pieces: readonly Piece[]): Run[] {
  const scan = pieces.map(p => (p.isRaw ? '￼'.repeat(p.text.length) : p.text)).join('')
  const cut = new Uint8Array(scan.length)
  const flags = new Uint8Array(scan.length)
  const walk = (from: number, to: number) => {
    for (const m of scan.slice(from, to).matchAll(EMPHASIS)) {
      const group = [2, 3, 4, 5, 6].find(k => m[k] !== undefined)!
      const [s, e] = m.indices![group]!
      cut.fill(1, from + m.index, from + s)
      cut.fill(1, from + e, from + m.index + m[0].length)
      for (let i = from + s; i < from + e; i++) flags[i]! |= FLAG_OF[group]!
      walk(from + s, from + e)
    }
  }
  walk(0, scan.length)

  const runs: Run[] = []
  let at = 0
  for (const { isRaw: _, ...p } of pieces) {
    const end = at + p.text.length
    for (let k = at; k < end; ) {
      let j = k + 1
      while (j < end && cut[j] === cut[k] && flags[j] === flags[k]) j++
      if (!cut[k]) runs.push({ ...p, ...flagStyle(flags[k]!, p), text: p.text.slice(k - at, j - at) })
      k = j
    }
    at = end
  }

  return runs
}

function flagStyle(f: number, p: Style): Style {
  return {
    ...(f & BOLD ? { bold: true } : {}),
    ...(f & ITALIC ? { italic: true } : {}),
    ...(f & STRIKE ? { strike: true } : {}),
    ...(f & LINK ? { underline: true, fg: p.fg ?? 'suggestion' } : {}),
  }
}

const TAG_TONE: Record<string, string> = {
  ok: 'success',
  warn: 'warning',
  err: 'error',
  info: 'suggestion',
  accent: 'claude',
}

export function inlineRuns(nodes: readonly Inline[], base: Style = {}): Run[] {
  return emphasis(pieces(nodes, base))
}

function pieces(nodes: readonly Inline[], base: Style): Piece[] {
  const out: Piece[] = []
  for (const node of nodes) {
    if (node.t === 'text') out.push({ ...base, text: node.s })
    else if (node.t === 'code') out.push({ ...base, fg: 'permission', text: node.s, isRaw: true })
    else out.push(...tagRuns(node, base))
  }

  return out
}

function tagRuns(node: Extract<Inline, { t: 'tag' }>, base: Style): Piece[] {
  const { name, attrs, kids } = node
  const tag = tone(attrs.tone)
  const raw = (runs: Run[]): Piece[] => runs.map(r => ({ ...r, isRaw: true }))
  switch (name) {
    case 'ok':
    case 'warn':
    case 'err':
    case 'info':
    case 'accent':
      return pieces(kids, { ...base, fg: TAG_TONE[name], bold: base.bold || 'bold' in attrs })
    case 'dim':
      return pieces(kids, { ...base, fg: 'inactive' })
    case 'hl':
      return pieces(kids, { ...base, fg: tag ?? 'warning', inverse: true })
    case 'c':
      return pieces(kids, {
        ...base,
        fg: tone(attrs.fg ?? attrs.color ?? attrs.tone) ?? base.fg,
        bg: tone(attrs.bg) ?? base.bg,
        bold: base.bold || 'bold' in attrs,
        italic: base.italic || 'italic' in attrs,
        underline: base.underline || 'underline' in attrs,
      })
    case 'kbd':
      return raw([{ ...base, inverse: true, bold: true, text: ` ${plain(kids).trim()} ` }])
    case 'badge':
      return raw([{ ...base, fg: tag ?? 'claude', inverse: true, bold: true, text: ` ${plain(kids).trim()} ` }])
    case 'grad':
      return raw(gradient(plain(kids), attrs, base))
    case 'spark': {
      const values = nums(attrs.values ?? plain(kids))

      return raw([{ ...base, fg: tag ?? base.fg ?? 'claude', text: spark(values) }])
    }
    case 'meter': {
      const value = Number(attrs.value ?? (plain(kids) || 0))
      const max = Number(attrs.max ?? (value > 1 ? 100 : 1))
      const cells = Math.max(3, Math.min(40, Number(attrs.width ?? 10)))
      const frac = max > 0 ? value / max : 0
      const fill = bar(frac, cells)
      const color = tag ?? (frac >= 0.8 ? 'success' : frac >= 0.5 ? 'warning' : 'error')
      const label = attrs.label ?? `${Math.round(frac * 100)}%`

      return raw([
        { ...base, fg: color, text: fill },
        { ...base, fg: 'inactive', text: '·'.repeat(Math.max(0, cells - width(fill))) },
        ...(label === 'none' ? [] : [{ ...base, text: ' ' + label }]),
      ])
    }
    default:
      return pieces(kids, base)
  }
}

function gradient(s: string, attrs: Attrs, base: Style): Run[] {
  const from = hexOf(attrs.from, '#d77757')
  const to = hexOf(attrs.to, '#af87ff')
  const chars = [...s]

  return chars.map((ch, i) => ({
    ...base,
    bold: base.bold || 'bold' in attrs,
    fg: mix(from, to, chars.length > 1 ? i / (chars.length - 1) : 0),
    text: ch,
  }))
}

// Inline markup and markdown emphasis in one line of text.
export function rich(s: string, base: Style = {}): Run[] {
  return inlineRuns(parseInline(s), base)
}

// A paragraph holding inline markup, drawn by hand: list items, headings,
// quotes and tables keep their shape; soft line breaks join as markdown joins them.
export function richRows(text: string, avail = 80): Row[] {
  const rows: Row[] = []
  let open: { lead?: Run[]; text: string; base: Style } | undefined
  const close = () => {
    if (open) rows.push({ lead: open.lead, runs: rich(open.text, open.base), wrap: true })
    open = undefined
  }
  const all = text.split('\n')
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!
    if (line.includes('|') && isTableRule(all[i + 1])) {
      close()
      const rule = all[++i]!
      const body: string[] = []
      while (i + 1 < all.length && all[i + 1]!.includes('|')) body.push(all[++i]!)
      rows.push(...table(line, rule, body, avail))
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line) as [string, string, string, string] | null
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line) as [string, string, string] | null
    const quote = /^\s*>\s?(.*)$/.exec(line) as [string, string] | null
    if (item) {
      close()
      const bullet = /\d/.test(item[2]) ? item[2] : '•'
      open = { lead: [{ text: item[1] + bullet + ' ' }], text: item[3], base: {} }
    } else if (heading) {
      close()
      open = { text: heading[2], base: { bold: true, underline: heading[1].length === 1 } }
      close()
    } else if (quote) {
      close()
      open = { lead: [{ fg: 'inactive', text: '▎ ' }], text: quote[1], base: { italic: true } }
    } else if (open) open.text += ' ' + line.trim()
    else open = { text: line.trim(), base: {} }
  }
  close()

  return rows
}

// ── tables ──────────────────────────────────────────────────────────────

function isTableRule(line: string | undefined): boolean {
  return line !== undefined && /^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|')
}

// A table row's cells: `|` splits outside code spans, `\|` stays a pipe.
function cells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let tick = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '`') {
      const run = /^`+/.exec(line.slice(i))![0]
      if (!tick) tick = run
      else if (run === tick) tick = ''
      cur += run
      i += run.length - 1
    } else if (ch === '\\' && line[i + 1] === '|') {
      cur += '\\|'
      i += 1
    } else if (ch === '|' && !tick) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  const trimmed = out.map(c => c.trim().replace(/\\\|/g, '|'))
  if (line.trim().startsWith('|') && trimmed[0] === '') trimmed.shift()
  if (line.trim().endsWith('|') && trimmed[trimmed.length - 1] === '') trimmed.pop()

  return trimmed
}

// A markdown table whose cells hold inline markup, drawn boxed; too wide for
// the room, each row becomes a block of `header  value` lines.
function table(head: string, rule: string, body: string[], avail: number): Row[] {
  const header = cells(head)
  const n = header.length
  const aligns = cells(rule).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'))
  const grid = [header, ...body.map(cells)].map(r => Array.from({ length: n }, (_, k) => r[k] ?? ''))
  const runs = grid.map((r, ri) => r.map(c => rich(c, ri === 0 ? { bold: true } : {})))
  const widths = header.map((_, k) => Math.max(3, ...runs.map(r => runsWidth(r[k]!))))
  const dim: Style = { fg: 'inactive' }

  if (widths.reduce((s, w) => s + w, 0) + 3 * n + 1 > avail) {
    const keyW = Math.min(24, Math.max(...header.map(h => width(h))))
    const out: Row[] = []
    runs.slice(1).forEach((r, ri) => {
      if (ri > 0) out.push({ runs: [] })
      r.forEach((c, k) => out.push({ lead: [{ ...dim, text: pad(clip(plain(parseInline(header[k]!)), keyW), keyW) + '  ' }], runs: c, wrap: true }))
    })

    return out
  }

  const line = (l: string, m: string, r: string): Row => ({ runs: [{ ...dim, text: l + widths.map(w => '─'.repeat(w + 2)).join(m) + r }] })
  const row = (r: Run[][]): Row => {
    const out: Run[] = [{ ...dim, text: '│' }]
    r.forEach((c, k) => {
      const gap = widths[k]! - runsWidth(c)
      const a = aligns[k] ?? 'left'
      const left = a === 'right' ? gap : a === 'center' ? Math.floor(gap / 2) : 0
      out.push({ text: ' '.repeat(left + 1) }, ...c, { text: ' '.repeat(gap - left + 1) }, { ...dim, text: '│' })
    })

    return { runs: out }
  }

  return [line('┌', '┬', '┐'), row(runs[0]!), line('├', '┼', '┤'), ...runs.slice(1).map(row), line('└', '┴', '┘')]
}
