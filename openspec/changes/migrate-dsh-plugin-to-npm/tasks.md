## 1. Publishable dsh Bundle

- [x] 1.1 Reshape `packages/chorus-dsh` into the public `@chorus-aidlc/chorus-dsh` bundle with `dsh.bundle.patch`, the four declared dsh peer dependencies, package-local skills, inline persona/instructions, config-over-environment credential resolution, self-contained runtime output, public metadata, and version synchronization; remove the build-time copy and generated `public/chorus-dsh.mjs`.
- [x] 1.2 Add packed-tarball, bundle-composition, credential-redaction, lifecycle, and pinned dsh contract tests proving interactive `dsh plugin add` activation without any Chorus write to `$DSH_HOME`.

## 2. Daemon Managed Composition

- [x] 2.1 Add Chorus-owned daemon installation of the bundle plus all four named peer plugins, colocated generated config, package-name resolution, absolute bundle-entry fallback, explicit config override preservation, and environment credential injection.
- [x] 2.2 Add focused idempotency, last-known-good rollback, clean-login, peer-resolution, full-composition validation, and spawner selection tests.

## 3. Product Migration and Integrated Acceptance

- [x] 3.1 Remove the remaining hosted installer and copied `public/dsh-plugin` artifacts plus obsolete tests; update onboarding, all four locales, connection docs, supported-harness references, and workspace/release wiring to npm-only distribution with dsh and pnpm prerequisites.
- [x] 3.2 Run pinned real dsh acceptance for interactive and daemon surfaces, including the enumerated 14-skill catalog, inline persona, all four daemon peers, check-in, transcript, per-Idea usage, interruption, zero `$DSH_HOME` writes, and secret-free files/argv/logs; record the evidence for verification.
