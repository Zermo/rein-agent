# Gates: Posthorse, compatibility, and proactive autonomy

Scope: native no-summary windows, durable notes/history, session persistence,
proactive user services and terminal controls, and fixes from parallel review.

- [x] G1: offline smoke and regression suites pass on Node 22.19
  CHECK: npm exec --yes --package=node@22.19.0 -- npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/Documents/GitHub/rein-agent; path=3bda20417fca/23 entries; EXPECT=matched; output-sha256=08fa7fa38ef8642e2a05f9d1c727fa24358939e2f848ef23bf023360c75ecf73; output-bytes=43421

- [x] G2: CLI bundles and the saved rollover works on Node 18
  CHECK: bash -c 'npm run bundle && npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs'
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/Documents/GitHub/rein-agent; path=3bda20417fca/23 entries; EXPECT=matched; output-sha256=07de5350107a9eaff72e350514d7f758b1ff7b756b17c79895c92c8b783bd665; output-bytes=99

- [x] G3: upstream Posthorse source and license match the pinned revision
  CHECK: node scripts/check-posthorse.mjs
  EXPECT: Posthorse provenance OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/Documents/GitHub/rein-agent; path=3bda20417fca/23 entries; EXPECT=matched; output-sha256=ebe55509b7f1f33944828cb0adef11015a2c9d4e5d83aaaf40af059c044d5b8c; output-bytes=24

- [x] G4: package can be packed with the shipped bundle and vendor files
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.6.0.tgz
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/portal/Documents/GitHub/rein-agent; path=3bda20417fca/23 entries; EXPECT=matched; output-sha256=b77065695a4a825e6f943c8a4725c3d8b3cbbae55e83f5c05824409a4d97882f; output-bytes=5186
