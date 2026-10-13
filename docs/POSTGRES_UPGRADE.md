# Migrate an existing PostgreSQL 16 database to 17

[中文](POSTGRES_UPGRADE.zh.md)

New deployments default to PostgreSQL **17**. PostgreSQL 17 **cannot open a
PostgreSQL 16 data directory**, even when the application uses only ordinary SQL.
`prisma migrate deploy` updates the application schema, not the database engine.
Do not run the new root `pnpm docker:db` against an old PG16 volume before migration.
Do not delete that volume or run `docker compose down -v` to resolve startup errors.

The explicit helper below performs an **offline logical migration**, not automatic
deployment or cutover. It never mounts the original volume writable. It copies the
stopped PG16 cluster to a working volume, starts an isolated PG16 helper, saves a
custom-format database dump and globals backup, restores into a **new PG17 volume**,
and compares all public table row counts and sequence values/`is_called` states.
It stops its helpers on exit and keeps all volumes and private artifacts on failure
or success. Row counts are a sanity check, not a complete content/application test.

## Supported scope and prerequisites

- Linux with Docker Engine, or macOS with Docker Desktop running Linux containers;
  Bash 3.2+, GNU/BSD standard utilities, and `sha256sum` or `shasum -a 256`;
  cached `postgres:16-alpine` and
  `postgres:17-alpine` images. Run `docker pull postgres:16-alpine` and
  `docker pull postgres:17-alpine` before scheduling downtime. The helper does not pull.
- A trusted, default-layout official PG16 Alpine **named volume** at
  `/var/lib/postgresql/data`, with default local socket authentication and the
  database superuser available. Not PGlite, remote/managed DBs, bind mounts,
  custom tablespaces or a general-purpose cluster migration tool.
- One application database, normally `chorus`, using the public schema. Other
  databases are **not migrated**. Extra schemas/extensions, foreign tables and RLS
  are rejected. Custom roles, grants and ownership are **not restored**: objects
  become owned by `--db-user` (default `chorus`). `globals.sql` is retained for DBA
  review only, never executed. Use a DBA-assisted procedure if you need these features.
- Enough disk for the original cluster **plus** a full PG16 working copy, logical
  dumps, a fresh PG17 cluster and temporary/WAL overhead; no fixed multiplier is
  sufficient for every database. On Docker Desktop, named volumes occupy the VM
  disk; backups occupy the host filesystem. Share password/backup bind paths with
  Docker Desktop. A dry-run does not check disk space or database compatibility.
- Native macOS CI exercises Bash and host tools with mocked Docker. Linux isolated
  container migration is integration-tested; a full Docker Desktop migration
  rehearsal has not yet been verified. Rehearse with disposable data first.
- Back up the original deployment config and app signing material separately.
  Stop **all** app/CLI/dev-server/external writers and the source database. Disable
  anything that could restart them during migration. The script checks running
  container mounts, but cannot enforce an operator's maintenance window.

## Run the migration explicitly

First identify the source volume from the **correct project's** DB container:

```bash
docker inspect YOUR_DB_CONTAINER --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}'
```

For root development Compose, stop the dev server and run `docker compose stop app db`.
For an installer-managed instance, use its existing Compose command with **all**
private overrides to stop app/db. Do not stop unrelated instances or run the installer
again. A DB that already failed to start after selecting PG17 can be migrated while
stopped; the helper uses a PG16 copy to read it.

Create a password file **outside the checkout** in a mode-0700 private directory,
mode 0600, containing the existing database role password, one line. This is the DB
password, not a Chorus login/admin password. Use the same password as the application
configuration; the root development example uses `chorus`. Never pass it in argv.

Replace the volume names and paths below; the backup directory must **not exist**,
and its parent must exist. Both new volume names (`TARGET` and `TARGET-source16`)
and helper container names (`TARGET-source16`, `TARGET-target17`) must be unused.

```bash
bash deploy/self-host/migrate-pg16-to-17.sh \
  --source-volume YOUR_OLD_PG16_VOLUME --target-volume chorus-pg17-migrated \
  --backup-dir /absolute/private/path/pg17-backup \
  --password-file /absolute/private/path/db-password --writers-stopped --dry-run
```

Remove only `--dry-run` to execute. No terminal prompts are used. `--database` and
`--db-user` override `chorus`; lowercase SQL identifiers only. Repeating a real run
with the same backup/target **fails closed**, not overwrite or resume. On failure,
inspect the protected logs before choosing fresh names for another attempt.
The backup contains credentials, globals/password hashes and application data:
keep it private and encrypt any off-host copy. It is not safe to commit or upload.

## Validate and switch Compose

Keep writers stopped. Verify exit status, inspect `SHA256SUMS`, compare the two
`*-counts-sequences.txt` files, and validate representative data, migration history,
login and application behavior against the target before permitting normal traffic.
The helper does **not** launch Chorus or test your identity provider. Prefer validating
the same app version first; starting newer app code can apply separate schema migrations.

Once the helper has exited successfully, remove only its stopped containers to avoid
accidental future startup against an active target (the volumes remain):

```bash
docker rm chorus-pg17-migrated-source16 chorus-pg17-migrated-target17
```

The helper also leaves `TARGET-source16`, a **complete PG16 working-copy volume**
roughly the size of the source cluster, not a small temporary log. All volumes
remain after the container removal. To inspect this copy's usage without host
Docker-data paths (also works with Docker Desktop), use the cached image read-only:

```bash
docker run --rm --network none --mount type=volume,src=chorus-pg17-migrated-source16,dst=/copy,readonly postgres:16-alpine du -sh /copy
```

After successful application validation/cutover, with recovery backups retained
and both helpers removed, you may explicitly delete **only the working copy**:

```bash
docker volume rm chorus-pg17-migrated-source16
```

Substitute your actual target name. This is optional operator cleanup, never
automatic. Do not delete the original source, active PG17 target or private backups.

### Root development Compose

Create a private override outside Git, for example `/absolute/private/path/pg17.yml`:

```yaml
volumes:
  chorus-data:
    external: true
    name: chorus-pg17-migrated
```

```bash
docker compose -f docker-compose.yml -f /absolute/private/path/pg17.yml up -d db redis
```

Use this exact file combination for later Compose operations **instead of bare
`pnpm docker:db`**. That shortcut does not read the private override. The app-data
and Redis volumes stay unchanged. Restart the dev server only after validating the DB.

### Installer-managed local deployment

Create/update the existing private `pg17.yml` (back it up first) instead:

```yaml
volumes:
  db-data:
    external: true
    name: chorus-pg17-migrated
```

Update private `env` to `POSTGRES_IMAGE=postgres:17-alpine`. Keep the DB password,
all app/login credentials, app-data volume, signing secret and HTTPS override unchanged.
Use your saved Compose command including base/local, HTTPS if present, and this PG17
override to start `db` and then the **same app image** for validation. Afterwards,
`bash default_deploy_local.sh` (or the original wrapper path for an older install)
automatically includes private `pg17.yml` on every deployment.
It can build/pull new application code, so do not use it as a same-version DB-only test.

## Failure and rollback

The original volume is never changed by this script. Keep it and the backups until
verification and your retention window finish. Before any new writes on PG17, rollback
means stop the target app/db, select the original volume **and a PG16 image** in your
private Compose override, and restore the old app image/config/signing material.
Merely removing the new-volume override is insufficient: the root YAML now defaults
to PG17. Once PG17 accepts new writes, switching back loses those writes; plan data
reconciliation or restore separately. The helper never silently performs that switch.

For broader upgrade strategies see the [PostgreSQL 17 upgrade documentation](https://www.postgresql.org/docs/17/upgrading.html).
