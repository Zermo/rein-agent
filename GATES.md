# Gates: silent compatibility diagnostics

Scope: silent Node compatibility flags in doctor results and heartbeat logs,
with packaged runtime and existing native integration coverage.

- [x] G1: source smoke and regression suites pass on Node 26.8.1
  CHECK: npm exec --yes --package=node@26.8.1 -- npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=ac9da0288d0fb8733b19cfae4eaf285c1a57d630d4b7174a8205b248bec0d043; output-bytes=29956

- [x] G2: built CLI and embedded assets work on Node 18
  CHECK: bash -c 'npm run bundle && npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs'
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=f482f2af17569fc5d1f3a4f7b725de921720fb0b24d5107e32530077adf68e71; output-bytes=123

- [x] G3: upstream source and release provenance remain intact
  CHECK: bash -c 'npm run check:posthorse && npm run check:natives'
  EXPECT: Obscura provenance OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=64f91f73e5061877b3c12f9d6554ac5a38b7182a4d4c892d4b3934723f744a38; output-bytes=243

- [x] G4: real Obscura extracts a JavaScript page through the packaged CLI
  CHECK: npm exec --yes --package=node@18.20.8 -- node test/obscura-live-smoke.mjs
  EXPECT: Obscura live smoke OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=c22d9946edd1d8facba5346b134bf42bd6e33bee925022f39f683087b09bbdf3; output-bytes=47

- [x] G5: release package includes native integration assets
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.9.1.tgz
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=30e83e92741b7f579ab5b12115da238f3ee5828d893747ac2abc99429c5836a0; output-bytes=11274
