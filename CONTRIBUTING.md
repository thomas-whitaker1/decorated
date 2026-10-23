# Contributing to decorated

decorated is experimental, and reports from real terminals and real replies are
what move it forward. Issues and pull requests both go to
[GitHub](https://github.com/thomas-whitaker1/decorated).

## Reporting a problem

[Open an issue](https://github.com/thomas-whitaker1/decorated/issues). These make
one quick to act on:

- `claude --version`, and where you ran it: terminal (fullscreen or main
  screen), Claude Desktop, the VS Code panel;
- the terminal and OS, and whether it runs under tmux or screen;
- a screenshot of the drawing;
- the reply's tags as Claude wrote them, if you can copy them: a drawing comes
  from its text, so the text reproduces it;
- your `/decorated` level, and any `CLAUDE.md` lines about decoration.

"Claude decorated too much (or too little)" is a useful report too. Say what
the reply was about and what you expected.

## Developing

You need Claude Code 2.1.299 or later; there's nothing else to install.

```
git clone https://github.com/thomas-whitaker1/decorated
cd decorated
claude --plugin-dir .
```

`--plugin-dir` loads the clone for that session only. If you also have
decorated installed, disable it while you work (`claude plugin disable
decorated@decorated`), so only one copy teaches and draws. Re-enable it after.

That first interactive session also writes the mod API's TypeScript
declarations to `.claude-plugin/types/` (ignored by git), which the typecheck
reads. A headless `claude -p` run doesn't write them.

In a session, `/decorated` draws one of every tag. It is the quickest way to
see a change: edit, start a new session, run `/decorated`. Then try a narrow
window, and a light and a dark theme.

## Checks

Run all three before sending a change; CI doesn't run them for you yet.

```
claude plugin test .              # every *.test.ts(x) under hooks/
npx -p typescript tsc -p .        # typecheck (TypeScript 5.4 or newer)
claude plugin validate .          # what the engine would accept or refuse
```

`claude plugin validate` also lists every engine call the module makes. A
change that adds one should say why, and update the README's Security
section.

Some tests hold the mod to budgets: the guide stays under 2,000 characters,
since it rides on every request, and the SVG, flow and tree bounds keep a
reply from asking for unbounded work. If you have to move one, say why in the
pull request.

## Code

- Match the code around you. Comments are sentences that say what the code
  does and why; a long file is split into sections under a `// ── name ──`
  rule.
- No runtime dependencies. The module imports only from `claude-code` and
  its own files.
- A new tag needs its name in `BLOCK_TAGS` or `INLINE_TAGS` (`hooks/parse.ts`),
  a widget in `WIDGETS` (`hooks/widgets.ts`) or an inline style, a line in the
  guide (`hooks/guide.ts`) if Claude should use it, a gallery entry
  (`hooks/demo.ts`), and tests.
- Every drawing has a narrow form: a widget that can't fit answers a plainer
  list instead of a broken drawing.

## Pull requests

Keep each pull request to one change. Write the commit subject as what is now
true, prefixed with the mod's name and ending in the issue it addresses:

```
decorated: callouts and columns nest 8 deep; a scrolled-away loop rests (#5)
```

Say in the description which surfaces and terminals you tried it on.
