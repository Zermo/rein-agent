# Gates: reply identities and native desktop setup

Scope: Rein 0.10.0 interactive labels, input isolation, NodeTerm installation,
registration, default routing, and activity-view compatibility.

- [x] G1: Source smoke and regression suite passes
  CHECK: npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; output-sha256=f338116f4c7486ea92768ca31ce3e9afee6f449de410c4d1d3e6375f1bcaf382; output-bytes=34675

- [x] G2: Built CLI works on Node 18
  CHECK: npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; output-sha256=314300802bb3163b493ea7326ef542c1e7ece16617c61f4ab01afaba6a7b77dc; output-bytes=27

- [x] G3: Native dependency provenance is intact
  CHECK: bash -c 'npm run check:posthorse && npm run check:natives'
  EXPECT: Obscura provenance OK
  EVIDENCE: exit=0; output-sha256=82fdff32288bc5ef211538d1384beeb320921b578039000ab44285a539e9e9ff; output-bytes=245

- [x] G4: Desktop installer and registration contracts pass offline tests
  CHECK: node --test test/desktop-install.test.ts test/desktop-surface.test.ts
  EXPECT: fail 0
  EVIDENCE: exit=0; output-sha256=f06a05645f23aa4d6b4b28c33b4ee252765b0d22af48f666cea0705f8f0e4e26; output-bytes=1323

- [x] G5: Release package includes the new desktop integration
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.10.0.tgz
  EVIDENCE: exit=0; output-sha256=168de0838f4ba792f055e6645cf8ca500d9f8735b36762991b55583b45d42cf9; output-bytes=12851

Source suite: 334 tests on Node 26.3.0. The native macOS download was also
installed into an isolated temporary directory: official checksum, signature,
Gatekeeper, staging, and cleanup passed. No installed app was replaced by that
check.
