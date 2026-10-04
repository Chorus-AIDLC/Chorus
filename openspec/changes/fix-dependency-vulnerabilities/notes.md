# Exemptions
- GHSA-vfj7-8cjw-p6xm (braces): no patched release; reached only via eslint-config-next > fast-glob > micromatch (dev lint tooling). Recorded in scripts/audit-root.mjs.
- Not upgraded by majors (fixed via overrides instead): vitest 4->5, jsdom 29->30 (undici override to ^7.30.0 suffices); deepmerge-ts@7 overridden to ^8.0.2 (prisma CLI config loading verified by build/prisma generate).
