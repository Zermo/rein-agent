# Gates: chat completions, tmux, visual activity, and embedded Meat

Scope: explicit Chat Completions connections, owned persistent tmux shells,
interactive terminal activity and diff review, and the pinned Meat engine.

- [x] G1: source smoke and regression suites pass on Node 22.19
  CHECK: npm exec --yes --package=node@22.19.0 -- npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=862f71d67cf00225801cd8535d85fff14f1ed3ed496fa3b86f184227d0bda904; output-bytes=57935

- [x] G2: built CLI and embedded native assets work on Node 18
  CHECK: bash -c 'npm run bundle && npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs'
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=e44292be5ff61baeaa052a87e72140a7f21043fbac8c328f8199818f528ec082; output-bytes=123

- [x] G3: upstream source provenance remains intact
  CHECK: bash -c 'npm run check:posthorse && npm run check:natives'
  EXPECT: embedded Meat provenance OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=63a3b0ca6d76d549c4d084b6c16af9a2c94baaa84df14027d4c41ead6207fabc; output-bytes=221

- [x] G4: release package includes runtime assets
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.8.0.tgz
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=77c8862adde5fdb900cfb3e91006238af3c99c196f4adf505d696c2256e01224; output-bytes=10599

- [x] G5: upstream Meat tests and reproducible WASM build pass
  CHECK: bash -c 'npm run test:meat-upstream && npm run check:meat'
  EXPECT: Embedded Meat engine OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/path/to/user/Documents/GitHub/rein-agent; path=923f685e6221/23 entries; EXPECT=matched; output-sha256=4c479c70bcf1c6d9e6c8bd5d8b41659a0dd45f4badae42fee9795115c8447426; output-bytes=278
