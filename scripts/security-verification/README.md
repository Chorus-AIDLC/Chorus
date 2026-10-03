# Security issue verification

These scripts exercise the locally built production images for #590 / #591.
They are development verification tools, not application startup dependencies.
The public results and limitations are in the change's `verification.md`; raw
logs and private fixture files are retained in
`/tmp/chorus-security-590-591-evidence`.

## Image metadata and native image processing

From the repository root:

```sh
docker build --platform linux/amd64 --target production -t chorus-security:patched-amd64 .
docker build --platform linux/arm64 --target production -t chorus-security:patched-arm64 .
docker run --rm --platform linux/amd64 \
  -v "$PWD/scripts/security-verification/image-smoke.mjs:/tmp/image-smoke.mjs:ro" \
  --entrypoint node chorus-security:patched-amd64 /tmp/image-smoke.mjs
docker run --rm --platform linux/arm64 \
  -v "$PWD/scripts/security-verification/image-smoke.mjs:/tmp/image-smoke.mjs:ro" \
  --entrypoint node chorus-security:patched-arm64 /tmp/image-smoke.mjs
docker run --rm -e DATABASE_URL='postgresql://x:x@localhost/x?sslmode=disable' \
  --entrypoint prisma chorus-security:patched-amd64 --version
```

The smoke reads traced and global installed metadata, confirms the Prisma pins
and installed CLI/client, then actually encodes and reads resized PNG, WebP and
AVIF images. The adapter is bundled into Next's server chunks; its installed
version is validated by the Docker builder's helper, and database API requests
exercise the resulting adapter. Metadata without a version is not treated as a
separately installed package.

## Database startup, historical upgrade and restart

`runtime-matrix.py` uses Python's standard library and Docker. It expects the
dedicated PostgreSQL containers, databases and PGlite volumes described in the
verification record. Set `CHORUS_SECURITY_EVIDENCE_DIR` to a private fixture
directory, or use the recorded default above. That directory contains:

- `runtime-private.json`: `network`, `pg_container`, `pg_password`,
  `default_user`, `default_password`, `nextauth_secret`. Use generated disposable
  credentials and mode 0600. This file is never tracked.
- `baseline-markers.json`: `pg-amd64`, `pg-arm64`, `pglite-amd64`, `pglite-arm64`
  entries with seeded `company` / `project` UUIDs and migration count 42.

The PostgreSQL service alias is `chorus-security-pg`; it requires TLS for remote
connections. Fresh databases are `security_pg_<arch>_fresh`; historical
databases are `security_pg_<arch>_upgrade`. The PGlite volume names are
`chorus-security-pglite-<arch>-<fresh|upgrade>`. Seed the historical fixtures by
running the baseline 7.3 CLI with migrations exported from `a994ef48`
(`git archive a994ef48 prisma/migrations`), then insert the marker company and
project. The baseline image is built from `b2e9b2e0`; its current application
migrations are overridden with that historical 42-migration directory for
fixture preparation. The retained `prepare-baseline-data.py`, SQL output and
marker file record the exact fixture preparation used for this run.

Start with unused dedicated container names and fresh fixture data:

```sh
python3 scripts/security-verification/runtime-matrix.py
```

The runner executes all eight architecture / database / data combinations,
checks migration count 45, seed retention, TLS, authentication, twelve concurrent
project requests and restart idempotence, and writes per-step logs plus
`runtime-matrix.json`. It does not inject `CHORUS_USE_PGLITE` into the fixtures;
embedded mode uses the image's actual default startup path. arm64 runs on the
host's configured QEMU emulation. The `--arm64-only` continuation reuses passed
amd64 results after a separate arm64 build; the initial run's premature launch
attempt is retained separately. Two native upgrade containers remain available
for browser inspection until explicit cleanup.

## Browser and theme checks

Install Playwright and Chromium in a separate tools directory, keeping the
application lockfile unchanged. The credentials JSON needs `default_user` and
`default_password`. Supply that protected file as the third argument:

```sh
CHORUS_SECURITY_PLAYWRIGHT_MODULE=/tmp/chorus-security-590-591-tools/playwright/node_modules/playwright \
  node scripts/security-verification/browser-check.mjs \
  http://127.0.0.1:55461 .playwright-mcp/security-590-591/postgresql \
  /tmp/chorus-security-590-591-evidence/runtime-private.json
```

For the PGlite upgrade container, use port 55463 and the `pglite` output directory.
The script checks login CSS in both themes, signs in, follows onboarding's
“Skip for now” action, opens the seeded project group and verifies the historical
project is visible, waiting for opacity and clipping animations to settle before
capture. It retains screenshots and browser results without logging
passwords, cookies or tokens. These local HTTP fixtures explicitly use
`COOKIE_SECURE=false`.

## Audit and image scans

```sh
pnpm audit --json > final-audit.json
syft docker:chorus-security:patched-amd64 -o syft-json=patched-amd64.sbom.json
GRYPE_DB_AUTO_UPDATE=false grype sbom:patched-amd64.sbom.json -o json --file patched-amd64.grype.json
```

Use Syft 1.54.0 and Grype 0.119.0 with the same frozen Grype database for baseline
and both patched images; set `GRYPE_DB_CACHE_DIR` to the recorded cache.
`pnpm audit` exits 1 when residual findings exist: that exit is retained and does
not mean the output is missing. The final record separates patched target
packages, globally installed tools and OS findings. Repeat the final full
`pnpm test:coverage` with the dedicated `RESEARCH_DATABASE_URL` on port 5435
after heavy image compilation completes; the retained final-check script
creates a separate test database, runs schema synchronization, lint and the
full coverage suite, then closes its owned port forward.
