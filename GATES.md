# Gates: terminal onboarding and personal assistance

Scope: Rein 0.13.0 stays in the current terminal, uses practical operator
preferences and optional native workflows, and separates free supervision,
optional local triage, explicitly enabled personal planning, and approved work.

- [x] G1: Source smoke and regression suite passes
  CHECK: npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; output-sha256=1751b9cc6b35271f07b1ad1e78db5519908db67185a5be85636399f746537325; output-bytes=50948

- [x] G2: Distributed CLI runs on Node 18 without development dependencies
  CHECK: npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; output-sha256=314300802bb3163b493ea7326ef542c1e7ece16617c61f4ab01afaba6a7b77dc; output-bytes=27

- [x] G3: Native dependency provenance remains intact
  CHECK: bash -c 'npm run check:posthorse && npm run check:natives'
  EXPECT: Obscura provenance OK
  EVIDENCE: exit=0; output-sha256=1c688ee8a3b32889b92b928cc502c454c30ef9f1652501f95e204677bec350ff; output-bytes=245

- [x] G4: Public field guide builds with its assets
  CHECK: node scripts/build-guide-site.mjs
  EXPECT: Built public guide
  EVIDENCE: exit=0; output-sha256=9c6287c7c3e0a365e3830e013dacb20ecc9fccac0109d2fa75d9e2f762841022; output-bytes=94

- [x] G5: Release package includes updated onboarding and autonomy modules
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.13.0.tgz
  EVIDENCE: exit=0; output-sha256=9ca30a14eb4ffe02370752798485f8fdfb50480255c3199d1e9393a5db2aec0f; output-bytes=14059
