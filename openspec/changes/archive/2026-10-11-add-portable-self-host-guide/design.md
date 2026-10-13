## Context

The human explicitly clarified that the primary deliverable is a generic local-deployment guide and this machine is only its validation fixture. Human elaboration selected PostgreSQL 16, user-created Cloudflare resources, a persistent isolated test instance, fresh test data, and local backup/restore with R2 documentation only. YOLO authorizes lifecycle automation, not previously excluded cloud operations or production-data access.

## Goals / Non-Goals

Goals: portable documented commands, minimal deployment configuration, safe defaults, verifiable operations and an honest evidence matrix. Non-goals: application refactoring, multi-replica support, Windows/macOS guarantees, cloud provisioning, migration of existing data, a general installer or production operations service.

## Decisions

1. Add standalone `deploy/self-host/compose.yml`, an explicitly selected local HTTP override, an explicitly selected Tunnel override, and `.env.example`. Base services publish no ports; the local override binds only `127.0.0.1`. A project name chosen by the reader namespaces resources; never use fixed `container_name`, external existing volumes or host-wide cleanup.
2. Single app + PostgreSQL 16; `REDIS_URL` is empty. PostgreSQL credentials and bootstrap credentials are required, generated privately, and not published in examples. Use the image's existing auto-generated JWT secret on a persistent app-data volume, documenting backup and explicit multi-instance limitations. Choose release images or digests explicitly, not mutable latest defaults. PostgreSQL is healthy before app starts; services restart unless stopped.
3. Local mode uses HTTP and `COOKIE_SECURE=false`; Tunnel mode uses the real external HTTPS URL and `COOKIE_SECURE=true`. Named Tunnel connects to `http://app:8637` on the Compose network, with a mounted token secret. Never place token values in shell arguments or guide text. Verify supported cloudflared flags against official docs before finalizing. Default-user login is for isolated verification; actual team identity uses existing OIDC instructions.
4. Guide commands use a single consistent Compose invocation, placeholders and replaceable paths. Describe DNS/Tunnel creation by the reader, cache bypass for authenticated/API/MCP/SSE routes, SSE buffering and WebSocket/reconnection checks, avoiding interactive Access challenges for agent protocols.
5. Backup uses a logical PostgreSQL dump plus protected app secret/config preservation. Restore into a separate empty project/database; do not overwrite existing instances. Never assume downgrading an image reverses migrations. Rollback after schema change requires tested matching image + pre-upgrade backup in isolation. R2 is optional encrypted off-host storage, not a live database disk; local backup is not disaster recovery.
6. Validate on a unique project using fresh random credentials, loopback port, and fresh volumes. Record health, login, API/MCP, SSE/daemon where runnable, restart persistence and logical restore. Preserve the pre-existing container. No host reboot or global daemon/profile rewrites. Document exact tested image identity; a locally built image is not proof of a published tag. Cloud checks need user-created resources; list them as pending with exact reader acceptance steps, not fabricated passes.

## Risks / Trade-offs

Documentation cannot guarantee Cloudflare free tiers or hardware capacity; date pricing facts and separate them from assumptions. Lack of a supplied domain/token limits public-path evidence but does not prevent shipping a reproducible guide with explicit limitations, as requested by the Idea's evidence-and-unfinished-items requirement. If a critical local step fails, fix the guide/config or leave the corresponding task unverified; do not hide failures.

## Validation and Handoff

Configuration contract tests check safe topology and modes. `docker compose config --quiet` and an isolated runtime validate the rendered configuration. Guide and config are independently reviewed, followed by integrated evidence review. The completion report must name every unexecuted external check. No PR push/merge without separate human approval.
