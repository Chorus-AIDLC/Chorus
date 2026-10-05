# Exemptions
- GHSA-vfj7-8cjw-p6xm (braces): no patched release. Reached via three root devDependency chains: eslint-config-next > @next/eslint-plugin-next > fast-glob > micromatch, shadcn > fast-glob > micromatch, and shadcn > ts-morph > @ts-morph/common > fast-glob > micromatch (dev tooling over trusted repo-local globs). Recorded in scripts/audit-root.mjs and scoped by `via: ["eslint-config-next", "shadcn"]`, so a root path through any other direct dependency, or through a runtime dependency, still fails the gate.
- Not upgraded by majors (fixed via overrides instead): vitest 4->5, jsdom 29->30 (undici override to ^7.30.0 suffices); deepmerge-ts@7 overridden to ^8.0.2 (verified by build/prisma generate and by `prisma migrate deploy` against a fresh PGlite DB).

# Override scoping
- Every override added by this change uses a `pkg@major` selector, so a future incompatible major is not forced back down. The dead `linkify-it` override was dropped (no longer in the tree).
- No `vite@8` override: the root declares `vite ^8.3.2` directly. Overriding vite@8 also rewrote the vite peer ranges of vitefu, vitest and @vitest/mocker to `^8.3.2`, which produced an unmet-peer warning for astro's vite 7 in packages/landing.
- Workspace caveat: pnpm overrides cannot be scoped to one importer, so the remaining overrides also apply wherever packages/* resolve the same majors.

# Audit gate hardening
- scripts/audit-root.mjs exits 2 instead of passing when the result can't be trusted: the spawn failed, was killed by a signal, or exited with a status other than 0/1, or the JSON is missing advisories/metadata, is inconsistent with the metadata counts, or a high/critical advisory has missing or unrecognized paths. Regression tests: scripts/__tests__/audit-root.test.mjs (run in CI before the gate).
