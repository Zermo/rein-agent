# Gates: guided operator setup and terminal activity labels

Scope: Rein 0.11.0 work-style questions, optional packs, private profile files,
first-run connection and proactivity setup, curl terminal input, and labeled
messages, tool calls, reply purposes, and provider-reported reasoning usage.

- [x] G1: Source smoke and regression suite passes
  CHECK: npm test
  EXPECT: smoke test OK
  EVIDENCE: exit=0; output-sha256=99a49b0aa6d61d2c94dabc776fc3d21e75126735d9f819a7761cf315a13dc9c1; output-bytes=39390

- [x] G2: Built CLI, including offline profile and pack controls, works on Node 18
  CHECK: npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs
  EXPECT: bundle smoke OK
  EVIDENCE: exit=0; output-sha256=314300802bb3163b493ea7326ef542c1e7ece16617c61f4ab01afaba6a7b77dc; output-bytes=27

- [x] G3: Native dependency provenance is intact
  CHECK: bash -c 'npm run check:posthorse && npm run check:natives'
  EXPECT: Obscura provenance OK
  EVIDENCE: exit=0; output-sha256=7f0a8bf8a8e3c7e0b53f4082b940cccd09e45f8617730a77343efd5d7ce18192; output-bytes=245

- [x] G4: Updated public field guide builds with its required assets
  CHECK: node scripts/build-guide-site.mjs
  EXPECT: Built public guide
  EVIDENCE: exit=0; output-sha256=4e34d85dda4298757e13a0ba6f3bc7fe5369097662c1de6acaf8a3063ccbeca1; output-bytes=94

- [x] G5: Release package includes the operator wizard and current bundle
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.11.0.tgz
  EVIDENCE: exit=0; output-sha256=da3ec7bf985f7df93ace5270e427124b32e60574fd4c89fe3845cf33d612a94a; output-bytes=13333
