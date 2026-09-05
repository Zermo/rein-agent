# Gates: Fold components, native workflows, and export regressions

Scope: Fold stop/truncation policies, Matt Pocock workflows, offline export diagnostics,
notes/history/recovery and cancellation fixes, source and installed CLI compatibility.

- [x] G1: offline smoke and regression suites pass on Node 22.19
  CHECK: npm exec --yes --package=node@22.19.0 -- npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=b3af00f3066cbd8a7dfd3b3175ba46de0ee7e171d6667575826f651405b23181; output-bytes=48057

- [x] G2: CLI bundles and the saved rollover works on Node 18
  CHECK: bash -c 'npm run bundle && npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs'
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=1f9f95dd8875695976b92dfa363f15ebef1b1bf8f717439ca9b12e4b42daa950; output-bytes=99

- [x] G3: upstream Posthorse source and license match the pinned revision
  CHECK: node scripts/check-posthorse.mjs
  EXPECT: Posthorse provenance OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=ebe55509b7f1f33944828cb0adef11015a2c9d4e5d83aaaf40af059c044d5b8c; output-bytes=24

- [x] G4: package can be packed with the shipped bundle and vendor files
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.7.0.tgz
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=fceec59470eac853eb6ee97c350ef0588d66b23dc90b2e6adee5076769055469; output-bytes=6695

- [x] G5: Fold and Matt Pocock sources and licenses match their pinned revisions
  CHECK: node scripts/check-natives.mjs
  EXPECT: Native Fold and Matt Pocock provenance OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=3875c237a9392593d2d6e94041e24e9f99db86779209eecfc01c0549dcfa1b37; output-bytes=42
