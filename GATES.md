# Gates: Fold components, native workflows, and export regressions

Scope: Fold stop/truncation policies, Matt Pocock workflows, offline export diagnostics,
notes/history/recovery and cancellation fixes, source and installed CLI compatibility.

- [ ] G1: offline smoke and regression suites pass on Node 22.19
  CHECK: npm exec --yes --package=node@22.19.0 -- npm test
  EXPECT: smoke test OK

- [ ] G2: CLI bundles and the saved rollover works on Node 18
  CHECK: bash -c 'npm run bundle && npm exec --yes --package=node@18.20.8 -- node test/bundle-smoke.mjs'
  EXPECT: bundle smoke OK

- [ ] G3: upstream Posthorse source and license match the pinned revision
  CHECK: node scripts/check-posthorse.mjs
  EXPECT: Posthorse provenance OK

- [ ] G4: package can be packed with the shipped bundle and vendor files
  CHECK: npm pack --dry-run
  EXPECT: rein-agent-0.7.0.tgz

- [ ] G5: Fold and Matt Pocock sources and licenses match their pinned revisions
  CHECK: node scripts/check-natives.mjs
  EXPECT: Native Fold and Matt Pocock provenance OK
