# Gates: Grok, server discovery and hardware serving

Scope: Rein 0.12.0 official Grok subscription bridge, xAI API setup, bounded
known-peer discovery, and current-machine model-fit/serving recommendations.

- [x] G1: Source smoke and regression suite passes
  CHECK: npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; output-sha256=9e1d3da26d2debf52d73e980bfc46b0085410ff849eb14237f34507d807b277a; output-bytes=44610

- [x] G2: Distributed CLI exposes cloud and hardware features on Node 18
  CHECK: npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; output-sha256=314300802bb3163b493ea7326ef542c1e7ece16617c61f4ab01afaba6a7b77dc; output-bytes=27

- [x] G3: Native dependency provenance remains intact
  CHECK: bash -c 'npm run check:posthorse && npm run check:natives'
  EXPECT: Obscura provenance OK
  EVIDENCE: exit=0; output-sha256=6beab90c4b3109009944da8fc4a5cbfe82ef2ffd867ad56608cfcf64c1dcfed3; output-bytes=245

- [x] G4: Public field guide builds with its assets
  CHECK: node scripts/build-guide-site.mjs
  EXPECT: Built public guide
  EVIDENCE: exit=0; output-sha256=d2ca6ee065737f91e442e3b89a42a3156046d559688dfa3b174a309d5d483f4c; output-bytes=94

- [x] G5: Release package includes cloud, discovery and serving modules
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.12.0.tgz
  EVIDENCE: exit=0; output-sha256=1f9fadf7b780ae4d4c03796eccea246ed3bb1c95180d7448095b9db24f629b71; output-bytes=13749
