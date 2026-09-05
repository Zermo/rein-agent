# Gates: Obscura web replacement

Scope: replace TinyFish search and scraping with native Obscura.

- [x] G1: source smoke and regression suites pass on Node 22.19
  CHECK: npm exec --yes --package=node@22.19.0 -- npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=cb638a4eaf9d3f2f631938a5ccfb6094d979133a9b415c268299cb62cdebb2c6; output-bytes=65013

- [x] G2: built CLI and embedded assets work on Node 18
  CHECK: bash -c 'npm run bundle && npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs'
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=ccb6b7765e900dfff690ba75f356242597723affb44ed233454affec95d9909b; output-bytes=123

- [x] G3: upstream source and release provenance remain intact
  CHECK: bash -c 'npm run check:posthorse && npm run check:natives'
  EXPECT: Obscura provenance OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=64f91f73e5061877b3c12f9d6554ac5a38b7182a4d4c892d4b3934723f744a38; output-bytes=243

- [x] G4: real Obscura extracts a JavaScript page through the packaged CLI
  CHECK: node test/obscura-live-smoke.mjs
  EXPECT: Obscura live smoke OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=5c7cfbdb9690fa08d256e21bb0beec73272eff5e0349d61a0820486e641ce3ca; output-bytes=46

- [x] G5: release package includes native integration assets
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.9.0.tgz
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=77aa62cfd9b43f226eb72f2a929635a1561c74f8ca59858ccaae0aa6dcc1a5d6; output-bytes=11222
