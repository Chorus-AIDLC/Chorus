# Tasks

Chorus task drafts are the source of truth; this file mirrors them for OpenSpec tooling.

- [x] 1. Entrypoint secret bootstrap (`docker/ensure-secret.sh`, entrypoint wiring, Dockerfile COPY, sh-level Vitest suite)
- [x] 2. App-layer placeholder detection + startup warning (`src/lib/secret-check.ts`, `src/instrumentation.ts`, Vitest incl. sh/TS list parity)
- [x] 3. Compose files, `.env.example`, docs (DOCKER / ARCHITECTURE en+zh), CHANGELOG 0.18.1 migration entry
