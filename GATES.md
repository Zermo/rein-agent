# Gates: Posthorse integration and harness compatibility

Scope: native no-summary windows, durable notes/history, session persistence,
and fixes from parallel harness review.

- [x] G1: offline smoke and regression suites pass on Node 22.19
  CHECK: npm exec --yes --package=node@22.19.0 -- npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; cwd=/Users/portal/Documents/GitHub/rein-agent; command=npm exec --yes --package=node@22.19.0 -- npm test; EXPECT=matched; output-sha256=07bf88b5a2dc2ea87eafe613f1d66d4ccc9b9724c8c67750fd2f12041ce3b1e7; output-bytes=18490

- [x] G2: CLI bundles and the saved rollover works on Node 18
  CHECK: bash -c 'npm run bundle && npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs'
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; cwd=/Users/portal/Documents/GitHub/rein-agent; command=bash -c 'npm run bundle && npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs'; EXPECT=matched; output-sha256=3e1756d46aa9eee17930cf4adde80762ae3a6a9dbceb7fffcb896cb779a13728; output-bytes=99

- [x] G3: upstream Posthorse source and license match the pinned revision
  CHECK: node scripts/check-posthorse.mjs
  EXPECT: Posthorse provenance OK
  EVIDENCE: exit=0; cwd=/Users/portal/Documents/GitHub/rein-agent; command=node scripts/check-posthorse.mjs; EXPECT=matched; output-sha256=ebe55509b7f1f33944828cb0adef11015a2c9d4e5d83aaaf40af059c044d5b8c; output-bytes=24

- [x] G4: package can be packed with the shipped bundle and vendor files
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.3.0.tgz
  EVIDENCE: exit=0; cwd=/Users/portal/Documents/GitHub/rein-agent; command=npm pack --dry-run; EXPECT=matched; output-sha256=6d7daaf7b1b796f2d1cda8b9df6d65cfe6cbb76f884233ef05510fe8b41b3a97; output-bytes=3968
