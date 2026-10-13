import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const composeAvailable = spawnSync("docker", ["compose", "version"], {
  stdio: "ignore",
}).status === 0;

describe("PostgreSQL deployment recommendations", () => {
  it("defaults the self-host template and recommended Compose files to PostgreSQL 17", () => {
    expect(readFileSync("deploy/self-host/.env.example", "utf8")).toContain("POSTGRES_IMAGE=postgres:17-alpine\n");
    expect(readFileSync("deploy/self-host/compose.yml", "utf8")).toContain("${POSTGRES_IMAGE:-postgres:17-alpine}");
    expect(readFileSync("docker-compose.yml", "utf8")).toContain("image: postgres:17-alpine");
    for (const directory of [".", "deploy/self-host", ".github/workflows"]) {
      for (const filename of readdirSync(directory).filter(name => /\.ya?ml$/.test(name) && name !== "pnpm-lock.yaml")) {
        const path = join(directory, filename);
        expect(readFileSync(path, "utf8"), path).not.toMatch(/postgres:16(?:\D|$)/);
      }
    }
  });

  it.each([
    "README.md", "README.zh.md", "README.ja.md", "README.ko.md",
    "docs/ARCHITECTURE.md", "docs/ARCHITECTURE.zh.md", "docs/DOCKER.md",
    "docs/SELF_HOST.md", "docs/SELF_HOST.zh.md", "openspec/specs/portable-self-host-guide/spec.md",
  ])("recommends PostgreSQL 17 in %s", path => {
    const content = readFileSync(path, "utf8");
    expect(content).toMatch(/PostgreSQL 17|postgres:17-alpine/);
    expect(content).not.toContain("postgres:16-alpine");
  });

  it.each([
    ["docs/SELF_HOST.md", "cannot open an existing PostgreSQL 16 data volume", "fresh volume", "Never run"],
    ["docs/SELF_HOST.zh.md", "无法打开已有的 PostgreSQL 16 数据卷", "全新卷", "切勿将"],
    ["docs/DOCKER.md", "cannot open a PostgreSQL 16 data volume", "fresh volume", "never run"],
  ])("warns against reusing PG16 volumes or deleting recovery data in %s", (path, warning, freshVolume, prohibition) => {
    const content = readFileSync(path, "utf8");
    expect(content).toContain(warning);
    expect(content).toContain(freshVolume);
    expect(content).toContain("`pg_dump`");
    expect(content).toContain("`pg_restore`");
    expect(content).toContain(`${prohibition} \`docker compose down -v\``);
  });
});

describe.skipIf(!composeAvailable)("portable self-host Compose contract", () => {
  let fixture: string;
  const configDirectory = resolve("deploy/self-host");
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
  };
  const values: Record<string, string> = {
    CHORUS_IMAGE: "chorusaidlc/chorus-app:fixture",
    POSTGRES_PASSWORD: "private-fixture-db-value",
    DEFAULT_USER: "fixture@example.invalid",
    DEFAULT_PASSWORD: "private-fixture-login-value",
    CHORUS_PORT: "18637",
    CHORUS_PUBLIC_URL: "https://chorus.example.invalid",
    CLOUDFLARED_IMAGE: "cloudflare/cloudflared:2025.4.0",
  };

  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), "chorus-compose-contract-"));
    writeFileSync(join(fixture, "token"), "not-a-real-tunnel-token", { mode: 0o600 });
    values.CLOUDFLARED_TOKEN_FILE = join(fixture, "token");
    values.CHORUS_TLS_CERT_FILE = join(fixture, "server.crt");
    values.CHORUS_TLS_KEY_FILE = join(fixture, "server.key");
    writeFileSync(values.CHORUS_TLS_CERT_FILE, "fixture-certificate", { mode: 0o600 });
    writeFileSync(values.CHORUS_TLS_KEY_FILE, "fixture-private-key", { mode: 0o600 });
  });

  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  function render(mode?: "local" | "tunnel", overrides: Record<string, string> = {}, lanHttps = false) {
    const envFile = join(fixture, "fixture.env");
    writeFileSync(envFile, Object.entries({ ...values, ...overrides })
      .map(([name, value]) => `${name}=${value}`).join("\n"), { mode: 0o600 });
    const args = ["compose", "--project-name", "chorus-contract", "--env-file", envFile,
      "-f", join(configDirectory, "compose.yml")];
    if (mode) args.push("-f", join(configDirectory, `compose.${mode}.yml`));
    if (lanHttps) args.push("-f", join(configDirectory, "compose.lan-https.yml"));
    return JSON.parse(execFileSync("docker", [...args, "config", "--format", "json"], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString());
  }

  it("keeps the base topology private, persistent and single-instance", () => {
    const config = render();
    expect(Object.keys(config.services).sort()).toEqual(["app", "db"]);
    for (const service of Object.values(config.services) as Record<string, unknown>[]) {
      expect(service.ports).toBeUndefined();
      expect(service.container_name).toBeUndefined();
      expect(service.restart).toBe("unless-stopped");
    }
    expect(config.services.app.environment.REDIS_URL).toBe("");
    expect(config.services.app.environment.DB_HOST).toBeUndefined();
    expect(config.services.app.environment.DATABASE_URL).toBe(
      `postgresql://chorus:${values.POSTGRES_PASSWORD}@db:5432/chorus?sslmode=disable`,
    );
    expect(config.services.db.image).toBe("postgres:17-alpine");
    expect(config.services.app.depends_on.db.condition).toBe("service_healthy");
    expect(config.services.app.healthcheck.test.join(" ")).toContain("/api/health");
    expect(config.services.app.volumes[0].target).toBe("/app/data");
    expect(config.services.db.volumes[0].target).toBe("/var/lib/postgresql/data");
    expect(config.volumes["app-data"].name).toBe("chorus-contract_app-data");
    expect(config.volumes["db-data"].name).toBe("chorus-contract_db-data");
  });

  it("exposes a configurable LAN HTTP port on all IPv4 interfaces in local mode", () => {
    const config = render("local");
    expect(config.services.app.ports).toHaveLength(1);
    expect(config.services.app.ports[0]).toMatchObject({
      host_ip: "0.0.0.0", published: "18637", target: 8637,
    });
    expect(config.services.db.ports).toBeUndefined();
    expect(config.services.app.environment.COOKIE_SECURE).toBe("false");
    expect(config.services.app.environment.NEXTAUTH_URL).toBe("http://localhost:18637");
  });

  it("retains port 8637 for manual Compose rather than the installer default", () => {
    const config = render("local", { CHORUS_PORT: "" });
    expect(config.services.app.ports).toEqual([
      expect.objectContaining({ host_ip: "0.0.0.0", published: "8637", target: 8637 }),
    ]);
    expect(config.services.app.environment.NEXTAUTH_URL).toBe("http://localhost:8637");
  });

  it("allows an explicit tested PostgreSQL image override", () => {
    expect(render("local", { POSTGRES_IMAGE: "postgres:17.6-alpine" }).services.db.image).toBe("postgres:17.6-alpine");
  });

  it.each(["local", "tunnel"] as const)("adds HTTPS without changing the %s origin or database", mode => {
    const original = render(mode);
    const config = render(mode, {}, true);
    expect(config.services.app).toEqual(original.services.app);
    expect(config.services.db).toEqual(original.services.db);
    if (mode === "tunnel") expect(config.services.cloudflared).toEqual(original.services.cloudflared);
    const proxy = config.services["lan-https"];
    expect(proxy.image).toMatch(/^nginx@sha256:[a-f0-9]{64}$/);
    expect(proxy.ports).toEqual([
      expect.objectContaining({ host_ip: "0.0.0.0", published: "18638", target: 8443 }),
    ]);
    expect(proxy.read_only).toBe(true);
    expect(proxy.depends_on.app.condition).toBe("service_healthy");
    expect(proxy.tmpfs).toEqual(["/var/cache/nginx", "/var/run"]);
    expect(proxy.volumes.map((volume: { source: string }) => volume.source)).toEqual([
      join(configDirectory, "nginx.lan-https.conf"), values.CHORUS_TLS_CERT_FILE, values.CHORUS_TLS_KEY_FILE,
    ]);
    for (const mount of proxy.volumes) {
      expect(mount).toMatchObject({ type: "bind", read_only: true });
      expect(mount.bind?.create_host_path).not.toBe(true);
    }
    expect(proxy.healthcheck.test.join(" ")).toContain("https://127.0.0.1:8443/api/health");
  });

  it("allows explicit HTTPS port and image selection", () => {
    const config = render("local", { CHORUS_HTTPS_PORT: "28638", CHORUS_HTTPS_IMAGE: "nginx:test-fixture" }, true);
    expect(config.services["lan-https"].ports[0].published).toBe("28638");
    expect(config.services["lan-https"].image).toBe("nginx:test-fixture");
  });

  it.each(["CHORUS_TLS_CERT_FILE", "CHORUS_TLS_KEY_FILE"])("rejects HTTPS without %s", name => {
    expect(() => render("local", { [name]: "" }, true)).toThrow();
  });

  it("preserves secure cookies, streaming, WebSocket headers and Docker DNS in the proxy", () => {
    const config = readFileSync(join(configDirectory, "nginx.lan-https.conf"), "utf8");
    for (const directive of [
      "listen 8443 ssl;", "ssl_protocols TLSv1.2 TLSv1.3;", "set $chorus_origin http://app:8637;",
      "resolver 127.0.0.11 valid=10s ipv6=off;", "proxy_pass $chorus_origin;", "proxy_cookie_flags ~ secure;",
      "proxy_set_header Host $http_host;", "proxy_set_header X-Forwarded-Proto https;", "proxy_http_version 1.1;",
      "proxy_set_header Upgrade $http_upgrade;", "proxy_set_header Connection $connection_upgrade;",
      "proxy_buffering off;", "proxy_read_timeout 3600s;",
    ]) expect(config).toContain(directive);
  });

  it("keeps Tunnel mode private and supplies the token through a file", () => {
    const config = render("tunnel");
    expect(Object.keys(config.services).sort()).toEqual(["app", "cloudflared", "db"]);
    for (const service of Object.values(config.services) as Record<string, unknown>[]) {
      expect(service.ports).toBeUndefined();
    }
    expect(config.services.app.environment.COOKIE_SECURE).toBe("true");
    expect(config.services.app.environment.NEXTAUTH_URL).toBe(values.CHORUS_PUBLIC_URL);
    expect(config.services.cloudflared.command).toEqual([
      "tunnel", "--no-autoupdate", "run", "--token-file", "/run/secrets/tunnel_token",
    ]);
    expect(config.services.cloudflared.secrets[0].source).toBe("tunnel_token");
    expect(config.secrets.tunnel_token.file).toBe(values.CLOUDFLARED_TOKEN_FILE);
    expect(JSON.stringify(config)).not.toContain("not-a-real-tunnel-token");
  });

  it.each(["CHORUS_IMAGE", "POSTGRES_PASSWORD", "DEFAULT_USER", "DEFAULT_PASSWORD"])(
    "rejects missing required local value %s", (name) => {
      expect(() => render("local", { [name]: "" })).toThrow();
    },
  );

  it.each(["CHORUS_PUBLIC_URL", "CLOUDFLARED_IMAGE", "CLOUDFLARED_TOKEN_FILE"])(
    "rejects missing required Tunnel value %s", (name) => {
      expect(() => render("tunnel", { [name]: "" })).toThrow();
    },
  );
});
