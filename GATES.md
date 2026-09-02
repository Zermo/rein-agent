# Gates: tinyfish web + unlazy gates integration

Scope: TinyFish web_search/web_fetch and the unlazy gates tool wired into the rein harness

- [x] G1: full smoke suite passes with the new web + gates + nodeterm tests
  CHECK: node --experimental-strip-types test/smoke.ts
  EXPECT: smoke test OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/dev/rein; path=9aed8e6f2fa7/18 entries; EXPECT=matched; output-sha256=4e6837bb2301d307620d1b2764baebf86a6bce0a4806ca300c46e249d97e5a02; output-bytes=2168

- [x] G2: web_search, web_fetch, and gates are registered harness tools
  CHECK: node --experimental-strip-types -e "import('./src/harness/tools/index.ts').then(m => { const names = m.TOOLS.map(t => t.name); const need = ['web_search', 'web_fetch', 'gates']; const missing = need.filter(n => !names.includes(n)); if (missing.length) { console.error('missing: ' + missing); process.exit(1); } console.log('tool registration passed'); })"
  EXPECT: tool registration passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/dev/rein; path=9aed8e6f2fa7/18 entries; EXPECT=matched; output-sha256=5fc0ca11c88db8b3e0a5ebca8a7bd1c1fa4c066c0b2b50405d0b12f3f62ba00c; output-bytes=25

- [x] G3: unlazy is vendored with its checker, skill, and MIT license intact
  CHECK: test -f vendor/unlazy/SKILL.md && test -f vendor/unlazy/scripts/gate-check.mjs && test -f vendor/unlazy/scripts/lib/gates.mjs && grep -q "MIT License" vendor/unlazy/LICENSE && echo "vendoring passed"
  EXPECT: vendoring passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/dev/rein; path=9aed8e6f2fa7/18 entries; EXPECT=matched; output-sha256=e5e2abd175fbeedc0482597cd06ee19fe6ab0054e22c3baf5ad4dd9c7219d6a1; output-bytes=17

- [x] G4: system prompt carries the TinyFish web and unlazy gates sections
  CHECK: grep -q "TinyFish" src/harness/system-prompt.ts && grep -q "unlazy" src/harness/system-prompt.ts && echo "prompt sections passed"
  EXPECT: prompt sections passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/dev/rein; path=9aed8e6f2fa7/18 entries; EXPECT=matched; output-sha256=51a31346ee689e7815dfafc5388982831e951dfdaf2c25d787aebcec469bb086; output-bytes=23

- [x] G5: rein gates CLI mode dispatches to the gates tool
  CHECK: grep -q 'gatesTool.execute' src/cli.ts && echo "cli wiring passed"
  EXPECT: cli wiring passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/dev/rein; path=9aed8e6f2fa7/18 entries; EXPECT=matched; output-sha256=27b881314798f23cc80ddaa0eb813b10d82977d966e032c8dd770d4fed30bf97; output-bytes=18
