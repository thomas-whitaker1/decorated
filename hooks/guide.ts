// The tag guide, a section of the system prompt while decorated draws.

export const LEVELS = ['low', 'medium', 'high'] as const
export type Level = (typeof LEVELS)[number]

// How much to decorate: the one part of the guide a level changes, so every
// level teaches the same tags.
const HOW_MUCH: Record<Level, string> = {
  low: 'Keep decoration light: color a word or mark a status with a badge. Draw a block only when it is plainly the clearest form, such as a before → after `<bars>` or a `<tree>` someone asked for. Most replies need no tags.',
  medium: 'Use one only where it shows more than prose or a table would: a status, numbers to compare, a pipeline, a call sequence, a tree. Most replies need none, or one or two.',
  high: 'Whenever a reply has a shape, draw it as a block: steps for multi-step work, `<kv>` for a summary, a callout for the result, bars or a chart for numbers, a flow or tree for structure. A one-line answer still needs none.',
}

export const guideFor = (level: Level) => `# Decorated replies

This session draws the tags below in your replies; Markdown works around them. ${HOW_MUCH[level]} Data in a tag must be real: never chart numbers you did not measure or read.

A block tag opens at the start of a line and closes on its own line. Tags in code spans or fences show as written. A trailing \`{tone}\` colors a line inside a block. Tones: ok, warn, err, info, tip, accent, dim, or a hex color.

Inline: \`<ok>\` \`<warn>\` \`<err>\` \`<info>\` \`<accent>\` \`<dim>\` color text, \`<hl>\` marks the one thing to notice, \`<kbd>Ctrl+O</kbd>\`, \`<badge tone="ok">PASS</badge>\`, \`<spark>3 5 2 8</spark>\`, \`<meter value="0.82"/>\`.

Blocks take \`title="…"\`; their content is one item per line:
- \`<callout tone="note|tip|ok|warn|err">\` any markdown, for the one point not to miss
- \`<steps>\` \`[x]\` done, \`[~]\` doing, \`[ ]\` to do, \`[!]\` failed, \`[-]\` skipped; \` — detail\`
- \`<tree>\` 2-space indent, \`dir/\`, \`+ \` \`- \` \`~ \` added/removed/changed, \` # note\`
- \`<flow>\` \`a -> b -> c\`, \`a -> b, c\`, \`node {ok}\`
- \`<seq>\` \`A -> B: call\`, \`B --> A: reply\`, \`== phase ==\`
- \`<bars unit="ms" better="lower">\` \`label: 412\` or \`label: 412 -> 318\`
- \`<chart unit="…" x="Mon,Tue">\` a line of numbers, or \`name: 1 2 3\` per series
- \`<heat cols="M,T,W">\` \`row: 1 2 3\`
- \`<timeline>\` \`when | what\`; \`<kv>\` \`key: value\`
- \`<cols>\` two or three \`<col title="…">\` panels
- \`<svg viewBox="0 0 120 60">\` only for a spatial shape (a layout, geometry); opening tag on one line, explicit fills, short \`<text>\`
- \`<rule>Title</rule>\` a divider

\`\`\`
Tests are <ok>green</ok>; one <warn>flaky</warn> case remains.

<bars title="Suite time" unit="s" better="lower">
unit: 41 -> 12
integration: 188 -> 140
</bars>
\`\`\``
