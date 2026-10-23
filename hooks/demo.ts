// What `/decorated` prints: one of everything, drawn by the same hook.

export const DEMO = `<banner sub="markup in replies, drawn by a mod">decorated</banner>

Inline: build is <ok>green</ok>, <err>2 flaky</err>, <warn>1 skipped</warn>, <info>see notes</info>, <dim>an aside</dim>, <hl>look here</hl>, <accent>accent</accent>, <kbd>Ctrl+O</kbd>, <badge tone="ok">PASS</badge> <badge tone="err">FAIL</badge>, <grad>a gradient run</grad>, coverage <meter value="0.82"/>, latency <spark>3 5 4 8 6 9 12 7 5 4</spark>.

<callout tone="tip" title="Callouts">
Hold any **markdown**, and other markup: <ok>like this</ok>.
</callout>

<flow title="flow: a layered graph">
parse -> typecheck -> emit
parse -> lint {warn}
lint -> report
emit -> report {ok}
</flow>

<seq title="seq: a sequence diagram">
Browser -> API: POST /login
API -> Auth: verify(token)
Auth --> API: ok
API -> API: mint session
API --> Browser: 200 + cookie {ok}
</seq>

<bars title="bars: before → after" unit="kB" better="lower">
main.js: 412 -> 318
vendor.js: 1204 -> 1190
styles.css: 88 -> 97
</bars>

<chart title="chart: braille lines" unit="ms" height="6" x="Mon,Tue,Wed,Thu,Fri">
api: 120 130 125 180 160 140 135 128 122 119
web: 80 85 82 90 140 110 95 90 85 82
</chart>

<heat title="heat: a heat map" cols="M,T,W,T,F,S,S">
wk1: 3 5 2 8 1 0 0
wk2: 4 6 7 9 3 1 0
wk3: 2 2 5 4 12 0 2
</heat>

<cols>
<col title="tree">
<tree>
src/
  parse.ts  # tag scanner
  widgets/
    + flow.ts
    ~ bars.ts
  - old.ts
</tree>
</col>
<col title="steps">
<steps>
[x] Bump version
[~] Build — 3 of 5 targets
[!] Sign binary — cert expired
[ ] Publish
</steps>
</col>
</cols>

<timeline>
2026-09-01 | Kickoff
2026-10-01 | Beta {warn}
2026-10-22 | GA {ok}
</timeline>

<kv>
Branch: main
Commit: \`7e11040\`
Status: <ok>clean</ok>
</kv>

<svg title="svg: half-block pixels, real-glyph labels, SMIL" viewBox="0 0 120 60" cols="48">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22305a"/><stop offset="1" stop-color="#e98b4a"/></linearGradient></defs>
<rect width="120" height="60" rx="6" fill="url(#sky)"/>
<circle cx="88" cy="26" r="14" fill="#ffd36b"><animate attributeName="cy" from="26" to="46" dur="4s" fill="freeze"/></circle>
<path d="M0 60 L28 30 L46 46 L70 22 L104 60 Z" fill="#2f5d8a"/>
<path d="M0 60 Q30 46 60 54 T120 52 V60 Z" fill="#48968c"/>
<text x="10" y="14" fill="#f5f5f5" font-weight="bold">dusk</text>
</svg>

<svg title="svg mode=braille: line art" viewBox="0 0 200 60" mode="braille" cols="48">
<path d="M4 50 C40 0 80 60 120 30 S180 0 196 40" fill="none" stroke="accent" stroke-width="2"/>
<circle r="4" fill="none" stroke="ok" stroke-width="2"><animateMotion path="M4 50 C40 0 80 60 120 30 S180 0 196 40" dur="3s" repeatCount="indefinite"/></circle>
</svg>

<rule tone="accent">end of demo</rule>`
