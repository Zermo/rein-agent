# Gates: reasoning-model setup and installation guide

Scope: reasoning-aware setup probes and the retro installation guide,
with packaged runtime and existing native integration coverage.

- [x] G1: source smoke and regression suites pass on Node 26.8.1
  CHECK: npm exec --yes --package=node@26.8.1 -- npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=[local checkout path redacted]; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=603e1d84650a89f04a9513cad01f155c6976baba5376dcd8d4b4807d1ad4fd5a; output-bytes=31959

- [x] G2: built CLI and embedded assets work on Node 18
  CHECK: bash -c 'npm run bundle && npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs'
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=[local checkout path redacted]; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=8c7930c56fef2758fd48c2d0ec667fce90ce8ccc1c77eec23bd25b15bd46e3b1; output-bytes=123

- [x] G3: upstream source and release provenance remain intact
  CHECK: bash -c 'npm run check:posthorse && npm run check:natives'
  EXPECT: Obscura provenance OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=[local checkout path redacted]; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=bbb86a09c7c798e191a6703afc7d5c5de78b30458d4371b611e2a4e9d9fd6ff1; output-bytes=243

- [x] G4: real Obscura extracts a JavaScript page through the packaged CLI
  CHECK: npm exec --yes --package=node@18.20.8 -- node test/obscura-live-smoke.mjs
  EXPECT: Obscura live smoke OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=[local checkout path redacted]; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=c22d9946edd1d8facba5346b134bf42bd6e33bee925022f39f683087b09bbdf3; output-bytes=47

- [x] G5: release package includes native integration assets
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.9.3.tgz
  EVIDENCE: exit=0; shell=/bin/sh; cwd=[local checkout path redacted]; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=3de2f6c98a48ddfb4d395d2c2600430ab2ab4d751b05acc1c1f22a78aee1f804; output-bytes=11490
