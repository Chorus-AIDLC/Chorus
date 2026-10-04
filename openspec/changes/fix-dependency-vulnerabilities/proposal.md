## Why

`pnpm audit` (npmjs registry) reports critical/high vulnerabilities in the root project's dependency tree, almost all transitive (minimatch, brace-expansion, hono/@hono/node-server/express-rate-limit/path-to-regexp/fast-uri via `@modelcontextprotocol/sdk`, vite, undici via jsdom, @xmldom/xmldom + image-size + fast-xml-builder via `remark-docx`, @tiptap/core/linkify-it, lodash/mysql2/deepmerge-ts via prisma, flatted, js-yaml, picomatch, browserslist).

## What Changes

- Scope: ROOT project only (`packages/*` out of scope), severity critical + high only.
- Upgrade direct dependencies (major upgrades allowed; adapt code if needed) and add `pnpm.overrides` for transitive packages that parents have not yet bumped.
- Packages with no patched version (e.g. `braces`) are replaced/removed from the chain where possible; otherwise recorded as an explicit exemption.
- Add a CI step running `pnpm audit` against the root project that fails on high/critical, honoring the documented exemptions.

## Impact

- `package.json`, `pnpm-lock.yaml`, `.github/workflows/test.yml`, possibly small code adaptations after major upgrades.
- No functional/behaviour change intended; acceptance = `pnpm test`, `npx tsc --noEmit`, `pnpm lint`, `pnpm build` pass + browser e2e smoke (login, board, proposal, light/dark theme).
