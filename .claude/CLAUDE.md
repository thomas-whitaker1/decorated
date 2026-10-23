# decorated

A Claude Code mod: a hooks module that teaches Claude a tag language through the
system prompt and draws the tags in its replies. Human contributors read
[CONTRIBUTING.md](../CONTRIBUTING.md); this file is the same ground for agents.

## Layout

- `hooks/register.tsx` — the hooks: `/decorated`, the guide added at
  `prompt.compose`, drawing at `ui.render`, SVG animation, stepping aside for
  another reply mod, the minimum Claude Code version.
- `hooks/guide.ts` — the guide text, per level. It rides on every request.
- `hooks/parse.ts` — splits a reply into Markdown and tags; `BLOCK_TAGS` and
  `INLINE_TAGS` are the only names it reads as tags.
- `hooks/widgets.ts` — one widget per block tag (`WIDGETS`), each answering rows
  of styled runs for a width, or a plainer form when it can't fit.
- `hooks/svg.ts` — `<svg>` rasterised to cells, and the cleaned markup for
  surfaces that draw SVG themselves.
- `hooks/draw.tsx` — parsed blocks to the surface's elements. `hooks/text.ts`
  holds the styled-run helpers.
- `hooks/demo.ts` — the `/decorated` gallery: one of everything.
- `hooks/*.test.ts(x)` — tests on the `claude-code/testing` kit.
- `types/index.d.ts` — the state the mod declares.
- `.claude-plugin/` — the plugin and marketplace manifests and the icon.
  `.claude-plugin/types/` holds the mod API's declarations, written by the engine
  and ignored by git. Read `claude-code/index.d.ts` there for any API question.

## Verify

```
claude plugin test .
npx -p typescript tsc -p .
claude plugin validate .
```

All three must pass. If `.claude-plugin/types/` is missing, the typecheck can't
run: ask the person to start one interactive `claude --plugin-dir .` session in
the repo, which writes it (headless `-p` runs don't).

Tests can't show a drawing. When a change alters how something looks, say so
and ask the person to check `/decorated` in a real terminal.

## Rules

- Write code that reads like its neighbours: comments are sentences saying what
  and why, long files split under `// ── name ──` rules, no runtime
  dependencies.
- The guide stays under its 2,000-character test budget. Every token in it is
  paid on every request, so cut before you add.
- Parsing stays linear in the reply, and the SVG, flow, tree and nesting bounds
  stay. A reply is untrusted input.
- Markup handed to a surface's own SVG element carries no scripts, event
  handlers, `<style>`, `<image>`, `<foreignObject>` or outside links.
- The module uses no network, files, processes or model calls. A new engine call
  shows up in `claude plugin validate`: name it in the README's Security section.
- The README's Compatibility table and Known issues list say what was checked
  where. Update them when a change moves either.
- Commit subjects read `decorated: <what is now true> (#N)`, one change per
  commit.
