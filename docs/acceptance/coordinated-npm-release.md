# Coordinated npm release acceptance — v0.17.0

Date: 2026-08-31

This acceptance used the release tag identity `v0.17.0` and did not publish or
create any npm version.

## Automated release invariants

Command:

```bash
node --test scripts/coordinated-npm-release/__tests__/coordinated-npm-release.test.mjs
```

Result: 11 assertions across 9 scenarios passed. The test creates isolated
temporary repositories, uses real `npm pack`, and replaces only registry and
publish calls with a local fake npm executable. Coverage includes:

- exact `vX.Y.Z` parsing and name/version drift before package work;
- no publish handoff when the final package prepare fails;
- all three contract-shaped tarballs and their fixed CLI → OpenClaw → dsh order;
- exact-version already-published recovery;
- fatal registry lookup errors and publish failures stopping later packages;
- `published`, `skipped-already-published`, `failed`, and `not-attempted`
  summary states;
- automatic provenance handling: no provenance-disable publish option and an
  SLSA `dist.attestations` check after every new publish;
- Release-only trigger, minimal OIDC permissions, supported runner/toolchain,
  and absence of npm token configuration.

## Full three-package prepare

Command:

```bash
node scripts/coordinated-npm-release/prepare.mjs v0.17.0
```

Result: passed as one complete prepare gate.

- Chorus CLI: lint and typecheck passed; 345 test files and 5,499 tests passed
  (existing suite skips remained); production Next.js build and prepack passed;
  the packed CLI installed into a fresh prefix and `chorus --version` returned
  `0.17.0`.
- OpenClaw plugin: standalone install, clean, typecheck, 151 tests, build,
  packed manifest, runtime entry, and `chorus-openclaw-plugin` ID checks passed.
- dsh plugin: install, lint, typecheck, 31 tests, dsh contract, build,
  15-skill package validation, package-specific pack check, and packed manifest
  checks passed.

The ordered handoff was written only after all three packages passed:

| Package | Files | Packed size | SHA-256 |
| --- | ---: | ---: | --- |
| `@chorus-aidlc/chorus` | 2,551 | 32,313,024 bytes | `023da7446bb7155e16576b9c2d1013493e23ef06b441bba583a9b43586485160` |
| `@chorus-aidlc/chorus-openclaw-plugin` | 84 | 180,942 bytes | `b75bfd72232556fbe04c763e34122fc749110ddf16ee8d8e0f551f356e2912ff` |
| `@chorus-aidlc/chorus-dsh` | 23 | 94,879 bytes | `f2bcb2f0546eb48d7a648350366b0664a1eaaacd25aee302376162f8e7ffc234` |

Required package identities, versions, executable/runtime entries, plugin
metadata, dsh exports, skill bundle, and forbidden-file rules were checked by
the package-specific prepare contracts.

## npm CLI no-publish dry-runs

Commands:

```bash
npm publish .release-artifacts/npm/chorus-aidlc-chorus-0.17.0.tgz --dry-run --ignore-scripts --access public --json
npm publish .release-artifacts/npm/chorus-aidlc-chorus-openclaw-plugin-0.17.0.tgz --dry-run --ignore-scripts --access public --json
npm publish .release-artifacts/npm/chorus-aidlc-chorus-dsh-0.17.0.tgz --dry-run --ignore-scripts --access public --json
```

All three exited successfully and reported the expected scoped package name,
version `0.17.0`, tarball filename, entry count, integrity, and public access.
`--dry-run` and `--ignore-scripts` ensured that these checks created no registry
version and did not rerun package lifecycle scripts against the accepted bytes.

## Specification and repository checks

```bash
openspec validate automate-coordinated-npm-releases --strict
node --check scripts/coordinated-npm-release/__tests__/coordinated-npm-release.test.mjs
git diff --check
```

All passed.

## External prerequisites not simulated locally

The following require GitHub/npm control-plane state and can only be verified
on an actual GitHub Release run:

- each of the three npm packages must trust the correct GitHub repository and
  exact workflow filename `publish-npm.yml`;
- npm's optional Environment setting must be blank for the current workflow,
  or exactly match a future job `environment`;
- GitHub must issue the OIDC identity to the hosted runner under
  `id-token: write`;
- npm must accept that identity and emit public-package SLSA provenance;
- GitHub's **Re-run jobs** operation must retain the same Release/tag context
  after a partial publication.

The automated suite verifies the local side of each contract, including
tokenless workflow configuration, default automatic provenance handling,
post-publish attestation lookup, idempotent exact-version skips, and auditable
failed/not-attempted recovery summaries. A real publish was intentionally not
executed.
