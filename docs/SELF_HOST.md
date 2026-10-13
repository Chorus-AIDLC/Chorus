# Self-host Chorus on Linux or macOS

[中文](SELF_HOST.zh.md) · [Docker image reference](DOCKER.md) · [Authentication](AUTH.md) · [PG16 → PG17 migration script](POSTGRES_UPGRADE.md)

Run one Chorus app and PostgreSQL 17 on Linux or macOS with Docker Desktop. Start with **local HTTP**: no domain, Cloudflare account, or tunnel token is needed. Optionally publish the same stack over HTTPS through a user-created Cloudflare Named Tunnel. This is a single-instance guide, not a multi-replica or workload-capacity guarantee. Any developer workstation used for validation is only a test fixture, not a deployment prerequisite.

## 1. Prerequisites and boundaries

- A maintained Linux host with Docker Engine, or macOS with Docker Desktop running Linux containers; Docker Compose v2 (`docker compose`), Bash 3.2 or newer, OpenSSL/LibreSSL, curl, and sufficient disk for database growth and backups. The optional scripted login check uses `jq`. Check with `docker version` and `docker compose version`; use a Compose version supporting `up --wait`.
- On macOS, start Docker Desktop first and allow it to share the checkout and private configuration/backup paths. Keep enough free space in both the Docker VM disk and host backup filesystem. Optional HTTPS uses an OpenSSL configuration file rather than requiring `req -addext`, which is unavailable in some versions. Native macOS CI checks host tools with mocked Docker; a full Docker Desktop deployment/upgrade rehearsal is not yet verified. Linux container integration evidence is recorded separately in the acceptance report.
- A checkout or release archive of this repository containing `deploy/self-host/`. Use configuration matching your selected application release. No Node.js toolchain is required on the server for container deployment; agent CLI checks run on a separate client with the Chorus CLI and its selected agent backend already installed.
- Permission to use Docker is effectively host-root access. Protect the host and its Docker socket; do not mount the socket into Chorus. The app image may run as root; do not assume non-root isolation.
- Outbound access to your image registry and, for Tunnel mode, Cloudflare's connector network. Local mode binds the app to `0.0.0.0` for LAN access: allow its published port only from trusted networks, never the public Internet. Docker-published ports can bypass UFW rules; enforce restrictions using Docker-aware firewall rules or an upstream firewall. The tunnel override publishes no host ports. PostgreSQL is always internal at `db:5432`.
- Choose a unique Compose project name. Never point this example at an existing database/volume, use a fixed `container_name`, or run host-wide prune/cleanup commands.

Host hardware/VPS, electricity, connectivity, storage, and an optional domain have their own costs. Cloudflare plan eligibility and limits can change; a tunnel does not make the host or domain free. R2 is optional **encrypted off-host backup storage**, never the live database disk. As documented on [R2 pricing](https://developers.cloudflare.com/r2/pricing/) (consulted October 2026), Standard storage includes monthly free allowances of 10 GB-month, 1 million Class A operations, and 10 million Class B operations. Egress is free, but storage/operation overages are not; other storage classes and services have different charges. Recheck current pricing and set billing alerts before use.

## Installer shortcut: choose pull or build

From a checkout of this repository, `bash install.sh` now offers **AWS** or
**local** before checking any AWS prerequisites or reusing `default_deploy.sh`.
AWS remains the default. `bash install.sh --target local` selects local directly;
on a terminal it asks for `pull` or `build`, the pull image when needed, ordinary
login email/password and separate super admin email/password. Password prompts
and confirmation are hidden. Local mode needs Docker/Compose and OpenSSL, not AWS CLI,
host Node.js or pnpm. By default it starts LAN-accessible HTTP only; selecting
optional self-signed HTTPS adds the proxy to the same Compose startup. Cloudflare
remains the separate, user-provisioned section below.

Choose **one** of these noninteractive examples, replacing the release placeholder
with an existing image and password-file paths with protected local files outside
the checkout (directory mode 0700, files mode 0600). Each file contains one password
line. The installer rejects symlink inputs and files inside the checkout before
reading them, so they cannot enter the image build context through this setup.
Do not put actual passwords in command arguments or run both examples on the same port:

```bash
bash install.sh --target local --image-source pull \
  --image chorusaidlc/chorus-app:vX.Y.Z --project chorus-local \
  --email owner@example.com --admin-email admin@example.com \
  --password-file /absolute/private/path/login-password \
  --admin-password-file /absolute/private/path/admin-password \
  --port 18637 --non-interactive
```

Or compile the current checkout into the default local tag `chorus-local:chorus-local`:

```bash
bash install.sh --target local --image-source build \
  --project chorus-local --email owner@example.com --admin-email admin@example.com \
  --password-file /absolute/private/path/login-password \
  --admin-password-file /absolute/private/path/admin-password \
  --port 18637 --non-interactive
```

The installer defaults to `0.0.0.0:18637`, separate from test port `8637`;
override it with `--port` or `CHORUS_PORT`. The internal container port and
Tunnel origin `http://app:8637` stay unchanged. Later manual setup/health examples
use `8637`; use `18637` instead for installer-managed instances. Restore rehearsals
must use a separate free port, never the running source instance's port.

`--image` can select a different build tag. The build uses this checkout's
`Dockerfile`, **production** target and repository build context; it does not pull
the application image. It still needs access to base images and build dependency
registries, adequate build memory/disk, and pulls `postgres:17-alpine`. Pull mode
pulls the selected explicit app tag/digest and PostgreSQL. Both fresh-install modes
also pull the official **third helper image `httpd:2.4-alpine`** to generate the admin
bcrypt hash with `htpasswd` (cost 12). The password is passed over stdin to an
ephemeral `docker run --rm -i --network none` container, never in its arguments;
hashing needs no host Node.js or pnpm. Neither mode accepts an
implicit tag or `latest`; neither silently falls back to the other source on error.
Both run the existing local Compose files with `up --pull never --wait` after
image preparation. No cloud resource or global daemon configuration is changed.

For a fresh-install preview, add `--dry-run` and omit both password-file options:
provide both emails and the image selection (pull requires an explicit image;
build may use its default tag), but **no passwords are required**. It only prints
a plan: no hashing, Docker calls or filesystem writes. This local behavior differs
from the legacy AWS dry-run, which writes an AWS rerun config. On non-TTY/headless
input the installer never waits for answers; missing required values fail.
Environment equivalents are `CHORUS_INSTALL_TARGET=local`,
`CHORUS_IMAGE_SOURCE=pull|build`, `CHORUS_IMAGE`, `CHORUS_LOCAL_PROJECT`,
`CHORUS_PORT`, `DEFAULT_USER`, `SUPER_ADMIN_EMAIL`, `CHORUS_INSTALL_NONINTERACTIVE=1` and
`CHORUS_INSTALL_DRY_RUN=1`. CLI options override these values.
For a real noninteractive install, supply password files or securely inject
`DEFAULT_PASSWORD` and `SUPER_ADMIN_PASSWORD` through the environment; file options
take precedence. There are no raw-password argv options. Both passwords must be
single-line and at least **8 bytes**; the admin password must be at most **72 bytes**
because of bcrypt (bytes, not characters).

The installer creates a **new** mode-0700
`$HOME/.config/chorus-self-host/<project>/` directory and mode-0600 `env` file,
with a randomly generated database password. The chosen ordinary `DEFAULT_PASSWORD`
is stored as **plaintext**, encoded as a double-quoted Compose env value with
backslashes and double quotes escaped and literal `$` encoded as `$$`. This also
preserves trailing backslashes, which single-quoted dotenv values do not safely
handle. Protect this file as a secret. Only the single-quoted bcrypt `SUPER_ADMIN_PASSWORD_HASH` is saved
for the administrator, never `SUPER_ADMIN_PASSWORD` plaintext. Signing behavior is
unchanged: empty `NEXTAUTH_SECRET` uses the app's persistent automatic signing key.
Passwords are not printed or supplied on command lines. Inherited Compose
credential/image variables cannot override this generated config. An existing
private directory, saved deployment script/config, or Docker project containers/volumes/networks causes a refusal,
not password rotation, overwrite or database reuse.
Exact generated volume/network/container names are also checked independently
of labels, so manually created or differently labelled resources are not reused.
Inventory lookup errors stop installation before image preparation.
A failed startup may leave this new project's containers/config for inspection;
it does not delete them.
Fresh setup also creates a **secret-free, mode-0700 `default_deploy_local.sh`** in the
checkout, or at `CHORUS_DEPLOY_CONFIG` (its parent directory must already exist).
It saves project/private-directory/image-source metadata, not passwords. Existing
scripts are never overwritten or reused as AWS scripts by local setup. The default
wrapper is excluded from local image builds; older AWS wrappers can contain credentials.
AWS keeps `default_deploy.sh`. Its original reuse prompt also accepts legacy AWS
wrappers with the `Auto-generated by install.sh` header and no target marker.
Local markers or `deploy-local.sh` references always prevent AWS reuse, even with
that header; unknown scripts are refused. New wrappers record their target.
Existing local `default_deploy.sh` and custom-path wrappers remain valid: keep
using their saved path, without reinstalling or automatically renaming them.
Before building, review the checkout and `.dockerignore`; keep other unrelated
private files outside the build context too.

After installer success, **skip section 2's manual config generation**. Set `REPO`
to the checkout, `PROJECT` to your selected name, and `ENV_FILE` to the generated
private `env`; use section 3A's `dc` function for subsequent operations. The
installer prints a project-scoped stop command. **For an existing installation,
use its saved wrapper, not setup again** (substitute your `CHORUS_DEPLOY_CONFIG`
path if customized):

```bash
bash ./default_deploy_local.sh --dry-run
bash ./default_deploy_local.sh
```

The wrapper invokes `deploy/self-host/deploy-local.sh`. Build mode rebuilds the
current checkout; pull mode pulls the app image saved as `CHORUS_IMAGE` in the
existing private env. It reads `POSTGRES_IMAGE` from that same file and pulls the
database image **only if missing locally**, not as a database-upgrade step. It
reads only explicit, **unquoted** saved `CHORUS_IMAGE` and `POSTGRES_IMAGE` tag/digest
values for image selection and never sources the env file as shell code (Compose
still consumes the private env for service configuration). It automatically
appends private `https.yml`, `pg17.yml` and `lan-https.yml` when present on **each run**, preserving
existing HTTPS and PostgreSQL overrides. When the optional LAN HTTPS override is
present, it also pulls that proxy's configured image before startup. It applies Compose idempotently with
`up --pull never --wait`: no credential rotation, `down`, or volume removal.
Here **idempotent** means reusing the same project, resources and credentials,
not migration rollback or zero database writes: app startup can apply Prisma
migrations. **Back up the database and signing state before deploying new code**
(section 6), and follow section 7's schema-aware rollback guidance.
Wrapper `--dry-run` reads and validates saved metadata/image references and lists
the selected Compose files; it does not invoke Docker or create/change files.
Other custom overrides (for example `oidc-only.yml`) are not auto-discovered; keep
them in an explicitly maintained Compose invocation for every redeployment.
For older instances without a local wrapper, retain their existing private path
and overrides and arrange a wrapper pointing there; do not rerun setup or reuse
an AWS script. Creating that wrapper and checking only `--dry-run` does not rebuild
or redeploy the current runtime.
Docker port conflicts and health failures return nonzero; resolve
them without deleting existing volumes.

## 2. Prepare private configuration

This is an alternative manual setup, not a follow-up to the installer: it generates a random ordinary login password and leaves admin setup to section 4. The commands below use **Bash**, in one shell. Replace paths, project name, email, and image with your own values. Do not enable shell tracing (`set -x`), paste secrets into chat, or commit private files. Keep this directory outside the checkout and restrict backups similarly.

```bash
bash
set -euo pipefail
set +x
umask 077
REPO=/absolute/path/to/Chorus
PROJECT=chorus-personal
PRIVATE_DIR="$HOME/.config/chorus-self-host/$PROJECT"
mkdir -p "$PRIVATE_DIR"
chmod 700 "$PRIVATE_DIR"
ENV_FILE="$PRIVATE_DIR/env"
test ! -e "$ENV_FILE"
cp "$REPO/deploy/self-host/.env.example" "$ENV_FILE"
chmod 600 "$ENV_FILE"
read -r -p 'Existing Chorus release image or digest: ' CHORUS_IMAGE
read -r -p 'Bootstrap owner email: ' DEFAULT_USER
POSTGRES_PASSWORD="$(openssl rand -hex 32)"
DEFAULT_PASSWORD="$(openssl rand -hex 32)"
{
  printf 'CHORUS_IMAGE=%s\n' "$CHORUS_IMAGE"
  printf 'POSTGRES_IMAGE=postgres:17-alpine\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD"
  printf 'DEFAULT_USER=%s\n' "$DEFAULT_USER"
  printf 'DEFAULT_PASSWORD=%s\n' "$DEFAULT_PASSWORD"
  printf 'CHORUS_PORT=8637\nNEXTAUTH_SECRET=\n'
  printf 'SUPER_ADMIN_EMAIL=\nSUPER_ADMIN_PASSWORD_HASH=\n'
  printf 'CHORUS_PUBLIC_URL=\nCLOUDFLARED_IMAGE=\nCLOUDFLARED_TOKEN_FILE=\n'
} > "$ENV_FILE"
unset POSTGRES_PASSWORD DEFAULT_PASSWORD
```

Select an **existing explicit release tag** such as `chorusaidlc/chorus-app:vX.Y.Z` (replace `X.Y.Z`, not a literal command) or an immutable `chorusaidlc/chorus-app@sha256:…` digest from the registry. Do not assume the repository's current package version has been published; do not use `latest` as a reproducibility claim. A locally built image is also usable when explicitly identified, but is not evidence that a published release was tested. A registry connection failure is not proof a tag is absent.

Use a protected editor or password manager to retrieve the generated bootstrap password for login, without printing the env file to a terminal/log. The tracked `.env.example` is only a template; the actual env and token files belong outside Git. Clear conflicting exported variables with the names in the table before using Compose: shell variables override `--env-file`. Do not `source` untrusted env files. Use `config --quiet`, not unredacted `docker compose config` or container environment dumps, which can reveal passwords.

| Setting | Contract |
| --- | --- |
| `CHORUS_IMAGE` | Required explicit app release/digest; record the resolved image identity. |
| `POSTGRES_IMAGE` | Defaults to `postgres:17-alpine`; pin a tested digest for stronger reproducibility. Do not change major versions without a database upgrade plan. |
| `POSTGRES_PASSWORD` | Required URL-safe random hex; app/database share it. Username/database are both `chorus`. Changing the env value does not change an existing database role's password. |
| `DEFAULT_USER`, `DEFAULT_PASSWORD` | Required ordinary bootstrap email/password at Compose render time. The installer saves double-quoted plaintext with backslashes/double quotes escaped and literal `$` encoded as `$$`; the manual example generates random hex. Development/demo login, not team SSO. |
| `NEXTAUTH_SECRET` | Optional strong override. When empty, the app generates `/app/data/.secret`, persisted in `app-data`. Never delete it during routine upgrades. |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD_HASH` | Separate `/admin` account, required by fresh local installer setup but optional in manual Compose. Store only a bcrypt hash, quoted with single quotes in the env file to preserve `$` literally. |
| `CHORUS_PORT` | Local mode only; installer default `18637`, manual Compose default `8637`; binds `0.0.0.0` for LAN access. |
| `CHORUS_LOCAL_HTTPS`, `CHORUS_HTTPS_HOST` | Installer-only opt-in: `true`/`false` and a DNS hostname or IPv4 address (not a URL). Setting only the host enables HTTPS. Interactive setup asks, defaulting to no; `--https-host` enables, `--no-https` disables. |
| `CHORUS_HTTPS_PORT`, `CHORUS_HTTPS_IMAGE` | Optional proxy host port (default `18638`, distinct from HTTP) and image (template pins a tested Nginx digest). The installer saves the port; image overrides for redeployment belong in the private env. |
| `CHORUS_TLS_CERT_FILE`, `CHORUS_TLS_KEY_FILE` | Required only with the HTTPS add-on: absolute paths to certificate/key outside the checkout. The installer generates and saves these when HTTPS is selected. |
| `CHORUS_PUBLIC_URL` | Tunnel mode only: required actual external `https://` origin, without a trailing slash/path. Sets `NEXTAUTH_URL`. |
| `CLOUDFLARED_IMAGE` | Tunnel mode only: required pinned version/digest supporting token files, version **2025.4.0 or newer**. |
| `CLOUDFLARED_TOKEN_FILE` | Tunnel mode only: required absolute private host file path, not the token value. |

Services are `app`, `db`, and optionally `cloudflared`; named volumes are `app-data` and `db-data`, namespaced by project. All services use `restart: unless-stopped`. `REDIS_URL` is deliberately empty: in-memory realtime delivery is single-instance only.

The example constructs `DATABASE_URL` with `sslmode=disable` only for PostgreSQL on this private same-host Compose network. It deliberately does **not** set `DB_HOST`: Chorus treats that variable as a TLS database connection, while the stock local PostgreSQL container does not enable TLS. Do not copy this no-TLS setting to a remote/untrusted database connection; configure verified database TLS separately there.

## 3. Choose exactly one exposure mode

The base `compose.yml` has **no published ports**. Choose either the local or tunnel primary override; do not combine those two. The optional LAN HTTPS add-on below can be layered separately without changing the primary origin. Keep the selected `dc` function for subsequent operations so every command uses the same project, private env file, and mode.

### A. Local HTTP (recommended first)

```bash
dc() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
    -f "$REPO/deploy/self-host/compose.yml" \
    -f "$REPO/deploy/self-host/compose.local.yml" "$@"
}
dc config --quiet
dc pull
dc up -d --wait
dc ps
```

Open `http://localhost:8637` on the host or `http://<host-LAN-IP>:8637` from another LAN device (use `18637` for the installer default, or your chosen `CHORUS_PORT`). The listener binds `0.0.0.0`; use the host's actual LAN IP in the browser, not `0.0.0.0`. This override sets `NEXTAUTH_URL=http://localhost:${CHORUS_PORT:-8637}` and `COOKIE_SECURE=false`, allowing password-login cookies over LAN HTTP. For OIDC, configure the actual origin and matching provider callback URLs as described in [Authentication](AUTH.md). HTTP does not encrypt credentials or sessions: restrict access to trusted networks and use HTTPS for untrusted networks. Do not expose this HTTP listener publicly.

Existing installs pick up the new binding when rerunning their saved deployment wrapper; accounts and volumes are retained. If a private `https.yml` override sets `COOKIE_SECURE=true`, LAN HTTP login needs that setting changed to `false`. This also removes the Secure flag from cookies issued through the HTTPS endpoint; prefer HTTPS-only access if that trade-off is unacceptable.

#### Optional self-signed LAN HTTPS trial

LAN HTTP password login does not establish OIDC compatibility: the unmodified OIDC client needs Web Crypto for PKCE, which browsers withhold from insecure LAN HTTP origins. **HTTPS is optional**, not a prerequisite for password-login deployment. Interactive `bash install.sh --target local` asks **Also enable self-signed LAN HTTPS? [y/N]** after the account prompts. Select yes and enter the hostname or IPv4 address clients will use. Leaving it at no creates no proxy, certificate or HTTPS listener.

Alternatively, enable it with an argument (replace the documentation-only IP with the host's actual LAN IP, and use a new project for fresh setup):

```bash
bash install.sh --target local --image-source build --https-host 192.0.2.10
```

Use `--https-port` to change the default `18638`; it must differ from the HTTP port. `--https` enables the host prompt, while noninteractive usage requires `--https-host` or `CHORUS_HTTPS_HOST`. `--no-https` overrides environment selection. Host input supports DNS names and IPv4, not URL paths, wildcard names or IPv6 literals. Normal noninteractive account/password inputs still apply.

The selected hostname must already resolve to this machine from client devices; setup does not change DNS, router rules or firewall policy. Restrict both published ports to trusted networks.

When selected, setup generates a 30-day RSA self-signed certificate with the selected host in its SAN under the protected private `lan-tls/` directory. It saves the certificate/key paths and HTTPS port in the private env, copies `deploy/self-host/compose.lan-https.yml` to private `lan-https.yml`, and includes it in the **same Compose up** as the app/database. This opt-in proxy uses `deploy/self-host/nginx.lan-https.conf` and a pinned Nginx image. Existing `https.yml` and `pg17.yml` overrides are retained on repeat deployments, which do not regenerate the certificate or credentials.

The HTTPS endpoint forwards to `http://app:8637` on the same Compose network. The existing HTTP listener remains available and the Cloudflare origin stays internal HTTP; the connector never sees the self-signed certificate. The proxy adds Secure to HTTPS response cookies without changing application-wide cookie settings, preserves forwarding/WebSocket headers and disables buffering for SSE. Its image is pulled only when the HTTPS option is installed. Certificate/key mounts are read-only and missing source files fail startup rather than becoming empty directories.

The certificate must include the actual LAN IP or hostname in its SAN, and its private key must stay outside the checkout with restricted permissions. In the verified Chromium trial, clicking **Advanced → Proceed** on the certificate warning enabled `isSecureContext` and `crypto.subtle`; no browser flags, installed CA, or OIDC dependency patch were needed. Other browsers and managed-device policies may differ. This is a temporary exception, not trusted server authentication or a production recommendation. Mark cookies issued through the HTTPS proxy Secure, and keep forwarding headers, WebSocket upgrades and unbuffered streaming intact.

Register the **exact** new callback (for example `https://<host-LAN-IP>:18638/login/callback`) in the identity provider while retaining existing public callbacks. A successful PKCE redirect can still fail with `redirect_uri_mismatch` until this is done. Use HTTPS consistently once logged in: cookies are host-scoped, not port-scoped, so the HTTP/HTTPS listeners on one host are not independent sessions. See the dated [acceptance record](acceptance/self-host-guide.md) for the local trial and its remaining provider-side prerequisite.

This is a trial certificate, not automatic certificate management. Before its 30-day expiry (or a host/IP change), back up the protected TLS files, renew the certificate with the matching SAN and key, and recreate **only** `lan-https` using the same Compose arguments with `up -d --no-deps --force-recreate lan-https`. Replacing file-mounted certificates requires recreation, not just restarting Nginx. Browsers may ask for a new exception. For lasting deployments use a trusted certificate or install a local CA on client devices.

To disable the add-on, use the complete Compose command printed by installation with `stop lan-https`, then `rm -f lan-https`; only after removing that service, move private `lan-https.yml` out of the active configuration. Keep certificates for rollback and leave app/database/Tunnel resources untouched. The saved wrapper no longer enables the proxy when that override is absent. Existing installs must not rerun the fresh installer: operators can instead generate private certificates with OpenSSL, set the TLS paths/port in their private env, copy the add-on template to `lan-https.yml`, and apply it with their existing Compose file list or saved wrapper (which also redeploys the app).

If explicitly using a pre-existing local app image in an offline fixture, do not claim `dc pull` succeeded: document the pull failure/local image identity and fetch the database image separately as needed.

### B. Optional Named Tunnel HTTPS

You supply the Cloudflare account, controlled domain/DNS, and a remotely managed Named Tunnel; this guide does not provision them. Follow the [official dashboard instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/) to create a tunnel and add a published application hostname (for example `chorus.your-domain.example`). Set the origin service to **HTTP `http://app:8637`**, not `localhost` (inside the connector that means the connector itself). Associate the hostname/DNS with this tunnel as instructed by Cloudflare.

Save the connector token from the dashboard to a private file, without putting it in shell arguments/history. For example, in the same Bash shell:

```bash
TOKEN_FILE="$PRIVATE_DIR/tunnel-token"
test ! -e "$TOKEN_FILE"
read -r -s -p 'Tunnel token (hidden): ' TUNNEL_TOKEN
printf '\n'
printf '%s' "$TUNNEL_TOKEN" > "$TOKEN_FILE"
unset TUNNEL_TOKEN
chmod 444 "$TOKEN_FILE"
```

The enclosing directory must remain `0700`. Compose file-based secrets are **host bind files**, not an encrypted secret store. The mount must be readable by the selected image's UID; `0444` inside this private directory is a practical option for a non-root connector. Do not use a world-accessible parent directory or assume Compose `uid`/`mode` remaps bind-file permissions. Check ownership/readability for rootless Docker/user namespaces rather than loosening the directory globally. See [Docker secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

In the protected env file set `CHORUS_PUBLIC_URL=https://chorus.your-domain.example`, an existing pinned `CLOUDFLARED_IMAGE=cloudflare/cloudflared:<version>`, and `CLOUDFLARED_TOKEN_FILE` to the absolute path in `TOKEN_FILE`. The connector command is `tunnel --no-autoupdate run --token-file /run/secrets/tunnel_token`; [Cloudflare documents `--token-file` as requiring 2025.4.0 or newer](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file). Never replace this with an inline `--token` argument.

If switching an existing local stack, run `dc down` using the **old local function** first; this preserves volumes and removes the LAN-published container. Then select Tunnel mode:

```bash
dc() {
  docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" \
    -f "$REPO/deploy/self-host/compose.yml" \
    -f "$REPO/deploy/self-host/compose.tunnel.yml" "$@"
}
dc config --quiet
dc pull
dc up -d --wait
dc ps
```

TLS terminates at Cloudflare; the private Compose origin stays HTTP. This override sets `COOKIE_SECURE=true` and `NEXTAUTH_URL` to the external URL. Verify HTTPS and Secure cookies from a real browser, not just connector health. If switching back, use the old tunnel invocation to `down` first, then local `up`; never use `down -v`. Keep a tunnel token secret like a password, rotate/revoke it in Cloudflare if disclosed, replace the private file, and recreate the connector.

### Cache, streaming, and Access policy

- Prefer cache bypass for the entire Chorus hostname. At minimum **never cache authenticated pages, login/auth routes, `/api/*`, `/api/mcp`, `/api/events`, or `/api/events/notifications`**. Do not apply Cache Everything or a Worker that caches responses there. Configure and inspect [Cloudflare Cache Rules](https://developers.cloudflare.com/cache/how-to/cache-rules/); validate that responses are not served as cache HITs across users.
- Chorus SSE endpoints currently send `Content-Type: text/event-stream` and `Cache-Control: no-cache`. Check that events/heartbeats arrive incrementally, not in a batch after disconnect. An additional reverse proxy must disable buffering for streams; NGINX documents [`proxy_buffering` and `X-Accel-Buffering`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering). Inspect `X-Accel-Buffering: no` where that proxy uses it; Chorus does not currently emit that header, and it is **not** a Cloudflare SSE guarantee. No specific official Cloudflare SSE buffering guarantee was established for this guide: test the complete path.
- [Cloudflare supports WebSockets](https://developers.cloudflare.com/network/websockets/), but network/server restarts can end connections; clients need reconnect behavior. Chorus browser/daemon checks here use SSE, not an invented WebSocket endpoint. If you add a WebSocket consumer, test its upgrade and reconnection separately.
- Interactive Cloudflare Access login/challenges can turn API/MCP/daemon requests into HTML/redirects and break non-browser clients. Chorus API keys do not automatically satisfy Access. Either keep these routes behind Chorus authentication without interactive Access, or explicitly integrate an Access machine-client flow end to end; [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) require additional headers/client support. Do not claim the shipped CLI automatically supplies those headers. Never disable Chorus authentication as a workaround.

## 4. Login and team identity

For the first local smoke test, use your chosen installer ordinary email/password (`DEFAULT_USER` and `DEFAULT_PASSWORD`), or the generated password from manual setup. `/api/auth/default-login` accepts `{email, password}` and sets an HttpOnly `user_session` cookie. Current default-auth sessions last **365 days**. This existing development/demo path auto-provisions a user/company; asking for credentials during installation does not make it full team SSO or a team account system. Never share the bootstrap login or reuse it for all team members.

The **`/admin` account is separate** from ordinary login. The local installer already configures its email and bcrypt hash; sign in at `/admin` with the chosen admin password. For manual setup, follow [Authentication](AUTH.md) to configure `SUPER_ADMIN_EMAIL` and bcrypt `SUPER_ADMIN_PASSWORD_HASH`, then recreate the app. For a team, configure the company's OIDC issuer, client ID, and enabled status in the admin UI. **OIDC settings are stored per company in the database, not `OIDC_*` environment variables.** Use an Authorization Code + PKCE client; register `${CHORUS_PUBLIC_URL}/login/callback` as the provider callback and `${CHORUS_PUBLIC_URL}/login` as the logout redirect (substitute the actual local origin for local tests). Check the provider's allowed origins, token/refresh policy, and company membership with separate users. Do not assume bootstrap and OIDC identities automatically merge.

You may retain a strong private bootstrap login temporarily while testing OIDC, but treat it as a privileged fallback, never a shared team password. For OIDC-only operation **after verifying the admin and OIDC logins**, use a small private override:

```yaml
services:
  app:
    environment:
      DEFAULT_USER: ""
      DEFAULT_PASSWORD: ""
```

Save as `$PRIVATE_DIR/oidc-only.yml` and append `-f "$PRIVATE_DIR/oidc-only.yml"` **after** the chosen mode file in `dc`, before `"$@"`. Keep non-empty bootstrap values in the private env file: Compose interpolates the base's `${DEFAULT_USER:?...}` and `${DEFAULT_PASSWORD:?...}` before merging, so merely emptying them there fails rendering. Run `dc config --quiet` then `dc up -d --wait --force-recreate app`. Disabling password login does not itself revoke already-issued long-lived sessions; plan session revocation/signing-key rotation if necessary, knowing rotation logs all users out. Preserve any extra override with backups and subsequent upgrade commands.

## 5. Acceptance checks (run on your own deployment)

These are instructions, **not a claim that your deployment passed**. Record the exact image tag/digest/ID, date, selected mode, and result for each check. Repository fixture results and limitations are tracked separately in [validation evidence](acceptance/self-host-guide.md); a local image test is not validation of a published tag. Public DNS/TLS, Tunnel, external cookies, streaming through Cloudflare, and Access compatibility remain **pending without a supplied domain/token**. R2 upload/restore is also unverified unless explicitly exercised.

### Health, login, and REST

Set `BASE_URL=http://localhost:8637` or your actual HTTPS origin. `curl --fail --silent --show-error "$BASE_URL/api/health"` should return `status: ok` and `database: connected`. A healthy container alone does not prove browser login or the public path.

Log in in a browser, inspect cookie flags (Secure in HTTPS mode, HttpOnly, SameSite=Lax), create a disposable project/idea, reload it, and confirm it persists. Optional scripted checks in Bash avoid placing passwords in curl arguments or printing cookies:

```bash
BASE_URL=http://localhost:8637
COOKIE_JAR="$PRIVATE_DIR/check.cookies"
read -r -p 'Bootstrap email: ' CHECK_EMAIL
read -r -s -p 'Bootstrap password (hidden): ' CHECK_PASSWORD
printf '\n'
export CHECK_EMAIL CHECK_PASSWORD
jq -n '{email: env.CHECK_EMAIL, password: env.CHECK_PASSWORD}' |
  curl --fail --silent --show-error -c "$COOKIE_JAR" \
    -H 'Content-Type: application/json' --data-binary @- \
    "$BASE_URL/api/auth/default-login" -o /dev/null
unset CHECK_EMAIL CHECK_PASSWORD
chmod 600 "$COOKIE_JAR"
curl --fail --silent --show-error -b "$COOKIE_JAR" \
  "$BASE_URL/api/auth/me" -o /dev/null
curl --fail --silent --show-error -b "$COOKIE_JAR" \
  "$BASE_URL/api/projects" -o /dev/null
```

Use browser OIDC checks instead if bootstrap auth was disabled. Do not publish cookie jars, request headers, keys, env files, or unredacted diagnostic logs.

### MCP, realtime, and daemon

In the UI create a dedicated test agent and API key with only the permissions needed. Use an already installed, compatible Chorus CLI on the client; no daemon service installation or global profile rewrite is needed. In a private Bash subshell:

```bash
(
  set +x
  umask 077
  export CHORUS_URL="$BASE_URL"
  read -r -s -p 'Test agent API key (hidden): ' CHORUS_API_KEY
  printf '\n'
  export CHORUS_API_KEY
  unset CHORUS_AGENT_PROFILE
  export CHORUS_DAEMON_CONFIG_PATH="$PRIVATE_DIR/check-daemon.json"
  export CHORUS_CLAUDE_SETTINGS_PATH="$PRIVATE_DIR/check-claude-settings.json"
  chorus mcp whoami
  chorus mcp call chorus_get_my_assignments '{}'
)
```

The MCP endpoint is `/api/mcp`; verify tool responses, not just HTTP 200 or a Cloudflare HTML page. Secrets stay out of command arguments/history, but process environments remain readable to privileged host users.

Open two browser tabs on a disposable project; create/update an idea in one and observe an incremental update in the other. For a bounded SSE observation using the protected cookie jar:

```bash
curl --fail --silent --show-error --no-buffer --max-time 35 \
  -b "$COOKIE_JAR" "$BASE_URL/api/events" || test "$?" -eq 28
```

Expect events/heartbeats before the timeout, not only at connection close. Exit 28 is expected for a deliberately bounded live stream; it is **not** proof that any event arrived. Remove the cookie jar afterwards with `rm -f "$COOKIE_JAR"`.

For a daemon check, reuse the private subshell/key setup above and run `chorus daemon --chorus-only --cwd /absolute/path/to/disposable-repo --browse-root /absolute/path/to/disposable-repo` in the foreground. There is no `--foreground` flag. Use a dedicated client account/HOME if you need full isolation, and keep existing global daemons/profiles untouched. A working local agent backend is required to validate actual wake execution; `--chorus-only` restricts the default Claude backend to Chorus tools, but is not an OS sandbox. The normal daemon defaults to broader autonomy, so do not omit safeguards casually.

Confirm the agent appears online in the UI (or authenticated `GET /api/agent-connections`, response `data.connections`), dispatch only a disposable task, and check its wake/report if backend credentials are available. Stop with Ctrl-C, restart, and verify reconnection/status recovery; `/api/events/notifications` is the daemon's SSE stream. Mark wake execution pending with a reason if no backend is available. Repeat after a controlled connector restart in Tunnel mode, without claiming zero event loss or seamless connections.

Finally run `dc restart app`, wait for health, and confirm your disposable data and existing login remain usable. `dc up -d --force-recreate app` checks volume-backed secret persistence across replacement more meaningfully than restart alone. Expect a brief outage, not high availability. On the public path additionally verify DNS ownership/routing, valid HTTPS, no host app/database listener, cache bypass, OIDC redirects, browser and CLI auth, incremental SSE, and reconnect after connector interruption.

## 6. Back up and restore safely

The database lives in `db-data`; `/app/data` (including the generated signing key) lives in `app-data`. `dc down` preserves these volumes; **`dc down -v` destroys them**. Restart policy does not recover data from disk loss. Schedule backups, monitor failures/storage, and practice restoration. A local copy on the same disk is not disaster recovery.

### Protected logical backup

Use the existing `dc` function (including any private overrides). Schedule a maintenance window and stop the app to quiesce writes; do not copy a running PostgreSQL data directory. Choose a new backup directory outside the checkout:

```bash
BACKUP_DIR="$HOME/chorus-backups/$PROJECT/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
dc stop app
dc exec -T db pg_dump -U chorus -d chorus -Fc > "$BACKUP_DIR/database.dump"
dc run --rm --no-deps -T --entrypoint tar app \
  -C /app/data -czf - . > "$BACKUP_DIR/app-data.tar.gz"
cp "$ENV_FILE" "$BACKUP_DIR/env"
cp "$REPO/deploy/self-host/compose.yml" "$BACKUP_DIR/compose.yml"
dc images > "$BACKUP_DIR/images.txt"
chmod 600 "$BACKUP_DIR"/*
dc start app
```

If a command fails under `set -e`, the app may remain stopped: investigate the backup error, then deliberately `dc start app`. Do not label a partial dump successful. Also preserve the selected mode file, any private OIDC override, the exact source revision/release, and immutable image digests in the protected backup set. Back up the tunnel token separately if needed, or document how to issue a replacement. Preserve an explicit `NEXTAUTH_SECRET` in the protected env backup; when auto-generated, it is in the app-data archive. Never print `.secret`. Restoring without the matching key invalidates sessions. Preserve/restore archive ownership; an arbitrary non-root image UID change can make data unreadable.

Encrypt the complete backup set with your established backup tool before sending it off-host (optionally to R2). Keep recovery keys separately, restrict bucket credentials, define retention, and test download/decryption as well as database restore. This guide does not execute or certify an R2 backup workflow.

### Restore rehearsal into an alternate project

Never restore over the original project. Choose a **new unused** project name and unused host port restricted to trusted networks; verify no containers or volumes already exist under that project. Use the matching pre-backup app image and PostgreSQL major version; do not start the app before importing the database and signing key. The commands assume the same configuration checkout and a complete backup above:

```bash
RESTORE_PROJECT=chorus-restore-rehearsal
RESTORE_ENV="$PRIVATE_DIR/restore.env"
test ! -e "$RESTORE_ENV"
cp "$BACKUP_DIR/env" "$RESTORE_ENV"
chmod 600 "$RESTORE_ENV"
sed -i 's/^CHORUS_PORT=.*/CHORUS_PORT=18637/' "$RESTORE_ENV"
restore_dc() {
  docker compose --project-name "$RESTORE_PROJECT" --env-file "$RESTORE_ENV" \
    -f "$REPO/deploy/self-host/compose.yml" \
    -f "$REPO/deploy/self-host/compose.local.yml" "$@"
}
restore_dc config --quiet
restore_dc up -d --wait db
restore_dc exec -T db pg_restore -U chorus -d chorus --exit-on-error \
  < "$BACKUP_DIR/database.dump"
restore_dc run --rm --no-deps -T --entrypoint tar app \
  -C /app/data -xzf - < "$BACKUP_DIR/app-data.tar.gz"
restore_dc up -d --wait app
```

Keep the restore isolated: do not start cloudflared, attach live daemons, or point public DNS at it. If production uses the OIDC-only override, append it to `restore_dc` too; restored IdP redirects may need a separately approved local callback. Otherwise the copied strong bootstrap credential enables a local check. Set a different env-file path/project name for every rehearsal; never reuse an old restore database with these import commands.

Check `http://localhost:18637/api/health`, login, known disposable records/counts, and the app-secret checksum **without exposing its contents**; verify consistency with the original backup. Restored sessions use the preserved signing key, but provider expiry/revocation still applies. Use a separate browser profile or clear localhost cookies because cookies are not isolated by port. Stop the rehearsal with `restore_dc down`; keep or deliberately remove only its own disposable volumes after checking the exact project, never production volumes.

## 7. Upgrade, rollback, and troubleshooting

**PostgreSQL 16 → 17 requires logical backup/restore, not an image-only upgrade.** PostgreSQL 17 cannot open an existing PostgreSQL 16 data volume. Keep the source on PostgreSQL 16 and take a logical backup with `pg_dump` as described above. For this major-version migration only, adapt the isolated restore rehearsal to set `POSTGRES_IMAGE=postgres:17-alpine` in the new project's private env file and restore with `pg_restore` into a fresh volume. Preserve the original volume, app signing material, and private configuration; validate the restored data and app before a controlled cutover, and quiesce source writes for the final backup. Never run `docker compose down -v` as an upgrade step. Ordinary recovery rehearsals still use the matching pre-backup PostgreSQL major version.

1. Review release notes and migrations. Record current image digests, configuration revision, and backup location. Take and rehearse a pre-upgrade backup including the signing key.
2. In the private env file change only `CHORUS_IMAGE` to the selected release/digest. Use `dc config --quiet`, `dc pull app`, and `dc up -d --wait app`. Startup runs migrations; allow maintenance time and inspect restricted logs with `dc logs --tail 100 app db` (sanitize before sharing).
3. Repeat health, login, REST/MCP, realtime/reconnect, and persistence checks. Monitor disk usage and logs. Upgrade PostgreSQL or cloudflared separately rather than mixing unrelated changes.
4. An older image **does not undo schema migrations**. Roll back the image directly only if compatibility is established. Otherwise restore the matching pre-upgrade dump, app secret/config, and old image into an isolated alternate project first, validate it, then plan a controlled cutover. Writes since the backup need a recovery/reconciliation decision; never silently discard them or blindly run older code against a migrated database.

| Symptom | Check |
| --- | --- |
| Compose rejects missing variables | Use the private absolute `--env-file`; keep required bootstrap values non-empty even with an OIDC-only override; select one mode only. |
| Database auth fails after env edit | Existing PostgreSQL volumes retain the old role password; coordinate a proper role-password change with app configuration, not volume deletion. |
| Tunnel healthy but hostname returns errors | Published hostname/DNS and `http://app:8637` origin, app health, connector logs/token file readability, outbound firewall. |
| HTTP login immediately fails | Use the local override (`COOKIE_SECURE=false`); HTTPS must use the tunnel override and actual external URL. |
| Users log out on recreate | Missing/mismatched app-data secret or explicit `NEXTAUTH_SECRET`; check mounts privately, never paste the secret. |
| Browser works, CLI receives HTML | Interactive Access challenge, redirect, cache/Worker rule, or wrong `/api/mcp` endpoint. |
| Realtime batches or stalls | Response content type/no-cache, intervening proxy buffering, incremental heartbeat test, connector/client reconnect and backend availability. |

Do not publish secrets while troubleshooting, run global Docker cleanup, modify unrelated installations, or open PostgreSQL to the Internet. Public-path acceptance remains pending until you actually complete the checks with your own cloud resources.
