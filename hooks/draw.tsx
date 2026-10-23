// Turns parsed blocks into the surface's elements: markdown goes to the
// engine's own Markdown, everything decorated is rows of Text.

import type { Elements, RenderNode } from 'claude-code'

import { type Attrs, type Block, parseBlocks, rich, richRows } from './parse'
import { nativeSvg, svg } from './svg'
import { type Row, type Run, tone } from './text'
import { WIDGETS, bannerParts } from './widgets'

// A surface that draws SVG itself (desktop, the editor, mobile) carries `Svg`.
export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Markdown'> & {
  Svg?: Elements['desktop']['Svg']
  isTerminal?: true
  // Theme keys the surface draws in no color, and what stands in for each.
  recolor?: Readonly<Record<string, string>>
}

// Seconds into an animated drawing's play, or undefined for its still.
export type Clock = (body: string, attrs: Attrs) => number | undefined

// The kit a surface draws with: `Svg` only off the terminal, whose table may
// answer a name it does not draw.
export function kitFor(T: Kit, surface: string): Kit {
  if (surface === 'terminal') return { Box: T.Box, Text: T.Text, Markdown: T.Markdown, isTerminal: true }

  return surface === 'vscode' ? { ...T, recolor: VSCODE_RECOLOR } : T
}

// The VS Code panel draws `warning` in its menu's text color. Its `yellow`,
// the terminal's ANSI yellow, follows the editor's theme as the key would.
const VSCODE_RECOLOR = { warning: 'yellow' }

const paint = (T: Kit, color: string | undefined) => (color && T.recolor?.[color]) ?? color

// Off the terminal rows are set in a browser's monospace face, where an
// arrowhead comes from a fallback font a fraction of a cell wide (so the
// lines it meets step aside) and ░ draws as a solid block: one-cell ASCII
// stands in for them.
const OFF_TERMINAL: Record<string, string> = { '►': '>', '◄': '<', '▼': 'v', '░': '·' }
const offTerminal = (run: Run): Run => ({ ...run, text: run.text.replace(/[►◄▼░]/g, ch => OFF_TERMINAL[ch]!) })

// The longest source a surface's `Svg` takes; past it the cells are drawn.
const SVG_SOURCE_MAX = 131072

const CALLOUT: Record<string, { icon: string; color: string; label: string }> = {
  note: { icon: '✎', color: 'suggestion', label: 'Note' },
  info: { icon: '›', color: 'suggestion', label: 'Info' },
  tip: { icon: '★', color: 'autoAccept', label: 'Tip' },
  ok: { icon: '✓', color: 'success', label: 'Done' },
  warn: { icon: '▲', color: 'warning', label: 'Warning' },
  err: { icon: '✘', color: 'error', label: 'Error' },
}
const CALLOUT_ALIAS: Record<string, string> = { success: 'ok', warning: 'warn', error: 'err', danger: 'err', caution: 'warn', important: 'warn' }

function textOf(T: Kit, run: Run): RenderNode {
  const { Text } = T

  return (
    <Text
      color={paint(T, run.fg)}
      backgroundColor={paint(T, run.bg)}
      bold={run.bold}
      italic={run.italic}
      underline={run.underline}
      strikethrough={run.strike}
      dimColor={run.dim}
      inverse={run.inverse}
    >
      {run.text}
    </Text>
  )
}

function rowOf(T: Kit, row: Row): RenderNode {
  const { Box, Text } = T
  const runs = row.runs.length > 0 ? row.runs.map(r => textOf(T, r)) : ' '
  if (!row.lead) {
    return (
      <Text mono wrap={row.wrap ? 'wrap' : 'truncate-end'}>
        {runs}
      </Text>
    )
  }

  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text mono>{row.lead.map(r => textOf(T, r))}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text mono wrap="wrap">
          {runs}
        </Text>
      </Box>
    </Box>
  )
}

function rowsOf(T: Kit, rows: readonly Row[]): RenderNode {
  const { Box } = T
  const set = T.isTerminal ? rows : rows.map(r => ({ ...r, lead: r.lead?.map(offTerminal), runs: r.runs.map(offTerminal) }))

  return <Box flexDirection="column">{set.map(r => rowOf(T, r))}</Box>
}

// Callouts and columns drawn inside one another at most this deep; deeper,
// a body shows as its markdown. Each level is a few boxes for the surface
// to lay out, so a reply nesting thousands would ask for a tree thousands
// of boxes deep.
const MAX_NESTING = 8

export function drawBlocks(T: Kit, blocks: readonly Block[], avail: number, clock?: Clock, depth = 0): RenderNode[] {
  return blocks.map(b => drawBlock(T, b, avail, clock, depth))
}

function drawBlock(T: Kit, b: Block, avail: number, clock?: Clock, depth = 0): RenderNode {
  const { Box, Markdown, Text } = T
  if (b.kind === 'md') return <Markdown text={b.text} />
  if (b.kind === 'rich') return rowsOf(T, richRows(b.text, avail))
  if ((b.name === 'callout' || b.name === 'col' || b.name === 'cols') && depth >= MAX_NESTING) return <Markdown text={b.body} />

  if (b.name === 'callout' || b.name === 'col') {
    const kind = CALLOUT_ALIAS[b.attrs.tone ?? ''] ?? b.attrs.tone ?? (b.name === 'col' ? '' : 'note')
    const preset = CALLOUT[kind]
    const color = preset?.color ?? tone(b.attrs.tone) ?? 'inactive'
    const heading = b.attrs.title ?? (b.name === 'callout' ? preset?.label : undefined)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={paint(T, color)} paddingX={1} flexGrow={b.name === 'col' ? 1 : 0}>
        {heading !== undefined && (
          <Text bold color={paint(T, color)}>
            {preset && b.name === 'callout' ? `${preset.icon} ` : ''}
            {rich(heading, { bold: true, fg: color }).map(r => textOf(T, r))}
          </Text>
        )}
        <Box flexDirection="column" gap={1}>
          {drawBlocks(T, parseBlocks(b.body), avail - 4, clock, depth + 1)}
        </Box>
      </Box>
    )
  }

  if (b.name === 'cols') {
    const inner = parseBlocks(b.body)
    const cols = inner.filter(x => x.kind === 'tag' && x.name === 'col')
    const n = Math.max(1, cols.length)
    const isSideBySide = avail >= n * 28
    const each = isSideBySide ? Math.floor((avail - (n - 1)) / n) : avail

    return (
      <Box flexDirection={isSideBySide ? 'row' : 'column'} gap={1}>
        {(cols.length > 0 ? cols : inner).map(c => (
          <Box flexDirection="column" flexGrow={1} flexShrink={1} width={isSideBySide ? each : undefined}>
            {drawBlock(T, c, each, clock, depth + 1)}
          </Box>
        ))}
      </Box>
    )
  }

  if (b.name === 'svg') return drawSvg(T, b, avail, clock)
  // Off the terminal a row is taller than its box-drawing glyphs, so a drawn
  // border breaks into dashes: the surface's own border is whole.
  if (b.name === 'banner' && !T.isTerminal && b.isClosed) return drawBanner(T, b)

  const widget = WIDGETS[b.name]
  if (!widget) return <Markdown text={b.body} />
  const rows = widget(b.body, b.attrs, avail)
  if (!b.isClosed && rows.length === 0) return <Text dimColor>drawing {b.name}…</Text>

  return rowsOf(T, rows)
}

function drawBanner(T: Kit, b: Extract<Block, { kind: 'tag' }>): RenderNode {
  const { Box, Text } = T
  const { letters, sub, border } = bannerParts(b.body, b.attrs)

  return (
    <Box flexDirection="column" alignSelf="flex-start" alignItems="center" borderStyle="round" borderColor={paint(T, border.fg)} paddingX={3}>
      <Text mono>{letters.map(r => textOf(T, r))}</Text>
      {sub !== undefined && (
        <Text mono dimColor italic>
          {sub}
        </Text>
      )}
    </Box>
  )
}

// Handed whole to a surface that draws SVG, where SMIL plays by itself;
// in cells elsewhere, at the moment `clock` gives.
function drawSvg(T: Kit, b: Extract<Block, { kind: 'tag' }>, avail: number, clock?: Clock): RenderNode {
  const { Box, Text, Svg } = T
  const native = Svg && b.isClosed ? nativeSvg(b.body, b.attrs) : undefined
  if (Svg && native && native.source.length <= SVG_SOURCE_MAX) {
    return (
      <Box flexDirection="column">
        {b.attrs.title !== undefined && <Text bold>{rich(b.attrs.title, { bold: true }).map(r => textOf(T, r))}</Text>}
        <Svg source={native.source} alt={native.alt} width={native.width} isInteractive={native.isAnimated} />
      </Box>
    )
  }
  const rows = Svg && !b.isClosed ? [] : svg(b.body, b.attrs, avail, b.isClosed ? clock?.(b.body, b.attrs) : undefined)
  if (!b.isClosed && rows.length === 0) return <Text dimColor>drawing svg…</Text>

  return rowsOf(T, rows)
}
