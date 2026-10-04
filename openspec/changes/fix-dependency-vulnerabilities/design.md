## Approach

1. Baseline: `pnpm audit --registry=https://registry.npmjs.org --json`, filtered to root paths (`. >`) and severity high/critical.
2. For each vulnerable chain, prefer in order: (a) bump the direct dependency (`@modelcontextprotocol/sdk`, `next-intl`, `@tiptap/*`, `remark-docx`, `vitest`/`jsdom`, `@vitejs/plugin-react`, `eslint`/`eslint-config-next`, `prisma`) to a release that pulls patched transitives; (b) `pnpm.overrides` to the patched version (range-scoped, e.g. `"minimatch@3": "^3.1.5"`) when the parent has no fix; (c) replace/remove the dependency; (d) documented exemption (`braces`, `http-cache-semantics` have no patched release).
3. Regenerate lockfile with `pnpm install`; keep cross-platform rule (no native-binding deps).
4. CI gate: add a step to `.github/workflows/test.yml`: `pnpm audit --audit-level high --registry=https://registry.npmjs.org` restricted to the root project; exemptions via `pnpm.auditConfig.ignoreGhsas` in package.json, each justified in a comment in the change notes.
5. Verify with test/tsc/lint/build, then browser smoke via the e2e-verification skill in both themes.

## Risks

Major upgrades (e.g. vitest, eslint-config-next, prisma, MCP SDK) may change APIs; the fix tasks adapt code and rerun the full suite. Overrides that cross majors are avoided; if a transitive requires a major jump, upgrade the parent instead.
