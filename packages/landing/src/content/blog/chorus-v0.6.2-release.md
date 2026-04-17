---
title: "Chorus v0.6.2: No Database? No Problem."
description: "Setting up PostgreSQL just to try an agent platform? PGlite embedded mode runs Chorus in a single container. Also: the port changed — read this before upgrading."
date: 2026-04-17
lang: en
postSlug: chorus-v0.6.2-release
---

# Chorus v0.6.2: No Database? No Problem.

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.6.2 is here.

We got a bunch of issues and feedback after the last release — thanks for that. This one doesn't add new workflow features. It's a fix-and-polish round: squash the bugs people reported, and make getting started easier.

---

## ⚠️ Breaking Change First: The Port Moved

Default port changed from 3000 to 8637.

Why? 3000 is the most crowded port in local dev. React uses 3000. Next.js uses 3000. Express uses 3000. Running Chorus alongside pretty much any frontend project meant a port collision.

8637 is unlikely to conflict with anything. All docs, Docker Compose files, CDK configs, and plugin scripts have been updated. If your deployment scripts or reverse proxy configs hardcode 3000, update them before upgrading.

---

## One Container Is All You Need

Previously, `docker compose up` would spin up two containers: the app and PostgreSQL. For local tryouts, running a separate database felt heavy.

v0.6.2 adds PGlite embedded mode. PGlite is PostgreSQL compiled to WASM, running inside the Node.js process with data stored in local files. Docker Compose now comes down to a single container — no separate database, no `DATABASE_URL` to configure. Much less friction to get running locally.

For production, a standalone PostgreSQL is still recommended. PGlite is for the "I just want to try Chorus" scenario. Your first experience shouldn't start with setting up a database.

---

## Other Changes

- **Pino structured logging**: Killed the scattered console.log calls. Production output is now JSON — plug it straight into CloudWatch, ELK, or whatever you use.
- **MCP tool call logging**: Every MCP call gets logged now, including ones rejected by business logic. No more guessing what an agent tried to do.
- **Progress bar fix**: Closed tasks weren't counting toward project progress. Now they do.
- **OIDC login fix**: Fixed a unique constraint violation on `oidcSub` during the default login flow.
- **Task reassignment**: You can now reassign a task that's already assigned to someone else, without releasing it first.

---

## Upgrade

```bash
# Pull the latest
git pull origin main

# The port changed!
# Old: http://localhost:3000
# New: http://localhost:8637
```

v0.6.2 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.2).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.6.2](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.6.2)
