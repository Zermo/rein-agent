# Gates: installer updates

Scope: curl-based CLI updates, installer failure handling and state preservation,
with packaged runtime and existing native integration coverage.

- [x] G1: source smoke and regression suites pass on Node 26.8.1
  CHECK: npm exec --yes --package=node@26.8.1 -- npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=2f24cf19b4e1a4f9c96359123bd31ef0ec54f356cb21800050b555902725127f; output-bytes=31058

- [x] G2: built CLI and embedded assets work on Node 18
  CHECK: bash -c 'npm run bundle && npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs'
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=2eabe0a8516528733a1f4209bcd120e7dc8717bea74cfdfedd692402c44730b2; output-bytes=123

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
  EXPECT: rein-agent-0.9.2.tgz
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=6ad49a7c4224dc4c8a00a66d21359f43fe04a85ca6f60f46d7543e91314e2320; output-bytes=11351
