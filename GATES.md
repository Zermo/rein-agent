# Gates: task limits and resumable pauses

Scope: Rein 0.14.0 adds configurable foreground turn and iteration limits,
readable private settings, and saved budget pauses with context recovery.

- [x] G1: Source smoke and regression suite passes
  CHECK: npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; output-sha256=f210fb568a79eb11cce1395dbb1658cb5de2da6ca97c38d8ec2a84b96d3d155d; output-bytes=57395

- [x] G2: Distributed CLI and offline budget wizard run on Node 18
  CHECK: npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; output-sha256=314300802bb3163b493ea7326ef542c1e7ece16617c61f4ab01afaba6a7b77dc; output-bytes=27

- [x] G3: Pinned Posthorse provenance remains intact
  CHECK: npm run check:posthorse
  EXPECT: Posthorse provenance OK
  EVIDENCE: exit=0; output-sha256=403699d59b807ebdf15c946c8d1effdfab22076a38ac01b605f921da3b72d84d; output-bytes=97

- [x] G4: Native dependency provenance remains intact
  CHECK: npm run check:natives
  EXPECT: Obscura provenance OK
  EVIDENCE: exit=0; output-sha256=4292ec727e89242551555018c706b1c475e77375733536a382d83ae2437283c7; output-bytes=148

- [x] G5: Public field guide builds with its assets
  CHECK: node scripts/build-guide-site.mjs
  EXPECT: Built public guide
  EVIDENCE: exit=0; output-sha256=5fd728597a83fc710efe4b6a3920127a190c004142b1684fcbc56c5cbfd2168f; output-bytes=94

- [x] G6: Release package includes task limits and resume modules
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.14.0.tgz
  EVIDENCE: exit=0; output-sha256=892d487fad0c39ad3e8bc336d2669bc604ddb12cadecdd659627c0446ca148e0; output-bytes=14498
