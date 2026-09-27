# Dedicated daemon operation rollout

Apply database migrations before starting this server build:

```sh
pnpm exec prisma migrate deploy
pnpm exec prisma generate
```

Migration `20260927073000_add_daemon_operation_payload` only adds nullable JSONB
`DaemonSessionTurn.operationPayload`. Existing triggers and rows remain unchanged.
Deploy the server before upgrading CLI clients. Restart server processes after
applying the migration and generating the client.

The default server writes `idea_creation_requested` and `research_requested`.
`operationProtocol=1` on pending-turns returns these triggers and their versioned
payload. Without it (including unknown protocol values), the server projects the
same UUID as `human_instruction` using its saved compatibility prompt.

For turn-advance, `operationProtocol=1` isolates both operations and historical
Research, including when `researchProtocol` is absent. `researchProtocol=1` alone
isolates canonical and historical Research while creation uses ordinary FIFO.
Clients declaring neither retain origin-scoped FIFO/coalesced acknowledgement.

For an emergency rollback, set `CHORUS_DEDICATED_OPERATION_WRITES=false` and restart
the server. This switches **new writes only** to historical `human_instruction`;
existing canonical turns remain readable, eligible for admission and confirmable
through all supported client projections. Roll back CLI independently if needed.
Keep a compatible server deployed until canonical pending/running turns have
drained. Do not roll back to a server that cannot read these triggers, remove the
payload column, or rewrite executed history.

Verify rollout using pending reads with no capability, `researchProtocol=1`,
`operationProtocol=1` alone and both flags. Each must retain the same turn UUID,
session and cwd. Invalid canonical payloads return a visible 409 on admission and
remain pending. Repeated running admission is refused; terminal retries retain
existing backend identity and usage semantics.

The real database suite requires an isolated test database on port 5435:

```sh
RESEARCH_DATABASE_URL='postgresql://postgres:postgres@localhost:5435/postgres?sslmode=disable' \
  pnpm exec vitest run src/services/__tests__/research.database.integration.test.ts
```

Do not point this test variable at the application database.

The final integration suite also crosses the real CLI/HTTP/DB boundary:

```sh
env -u REDIS_URL -u REDIS_HOST \
  RESEARCH_DATABASE_URL='postgresql://postgres:postgres@localhost:5435/postgres?sslmode=disable' \
  pnpm exec vitest run src/services/__tests__/daemon-operation-http.database.integration.test.ts
```

It requires the migrated isolated database, opens only an ephemeral loopback HTTP
listener, and removes its own tenant fixtures. It does not launch agents.
Four capability combinations and an old-server flag-ignore adapter exercise
creation, Research, terminal acknowledgement and reconnect; legacy merged rows
do not replay. This verifies the compatibility contract rather than installing a
historical server or CLI binary. The actual-server smoke, exact results and
remaining execution boundaries are recorded in
[the verification record](../verification/daemon-operation-events.md#t4-integration-acceptance).
