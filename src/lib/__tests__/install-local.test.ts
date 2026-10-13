import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");
const installer = join(root, "install.sh");
const image = "example.invalid/chorus:v1.2.3";
const password = "ordinary-fixture-password";
const adminPassword = "admin-fixture-password";
const adminEmail = "admin@example.invalid";
const adminHash = "$2y$12$abcdefghijklmnopqrstuuk.hPtT1QPadQsMqXb3xN9ZOvCjr.GTS";
const deployHelper = join(root, "deploy/self-host/deploy-local.sh");
const realDocker = spawnSync("bash", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();
const canRender = !!realDocker && spawnSync(realDocker, ["compose", "version"], { stdio: "ignore" }).status === 0;
const canUsePty = spawnSync("python3", ["-c", "import pty, termios"], { stdio: "ignore" }).status === 0;

describe("install.sh local deployment routing", () => {
  let fixture: string;
  let home: string;
  let bin: string;
  let log: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "chorus-install-contract-"));
    home = join(fixture, "home");
    bin = join(fixture, "bin");
    log = join(fixture, "calls.jsonl");
    mkdirSync(home);
    mkdirSync(bin);
    const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ command, args, secretOverride: process.env.NEXTAUTH_SECRET ? true : undefined, passwordOverride: process.env.DEFAULT_PASSWORD ? true : undefined, imageOverride: process.env.CHORUS_IMAGE ? true : undefined, adminOverride: process.env.SUPER_ADMIN_PASSWORD ? true : undefined }) + '\\n');
if (process.env.STUB_FAILURE && (command + ' ' + args.join(' ')).includes(process.env.STUB_FAILURE)) process.exit(17);
if (command === 'docker' && args[0] === 'image' && args[1] === 'inspect' && process.env.STUB_IMAGE_MISSING) process.exit(1);
if (command === 'docker' && args[0] === 'run' && args.includes('htpasswd')) {
  const input = fs.readFileSync(0, 'utf8');
  if (input !== (process.env.STUB_EXPECTED_ADMIN_PASSWORD || ${JSON.stringify(adminPassword)}) + '\\n') process.exit(18);
  console.log(':' + (process.env.STUB_HASH ?? ${JSON.stringify(adminHash)}));
}
if (command === 'docker' && process.env.STUB_RENDERER && args[0] === 'compose' && args.includes('config')) {
  const result = require('node:child_process').spawnSync(process.env.STUB_RENDERER, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
if (command === 'docker' && process.env.STUB_RESOURCES && args[0] === process.env.STUB_RESOURCES) console.log('existing-resource');
if (command === 'docker' && args.includes('--format') && args[0] === process.env.STUB_NAMED_KIND) console.log(process.env.STUB_NAMED_RESOURCE);
if (command === 'aws') console.log(args[0] === 'configure' ? 'us-east-1' : '000000000000');
`;
    for (const command of ["docker", "aws", "pnpm"]) {
      writeFileSync(join(bin, command), stub, { mode: 0o700 });
    }
  });

  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  function environment(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
    return {
      NODE_ENV: "test",
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      HOME: home,
      STUB_LOG: log,
      CHORUS_INSTALL_NONINTERACTIVE: "1",
      CHORUS_LOCAL_HTTPS: "false",
      CHORUS_DEPLOY_CONFIG: join(fixture, "default_deploy.sh"),
      DEFAULT_USER: "owner@example.invalid",
      DEFAULT_PASSWORD: password,
      SUPER_ADMIN_EMAIL: adminEmail,
      SUPER_ADMIN_PASSWORD: adminPassword,
      ...overrides,
    };
  }

  function run(args: string[] = [], overrides: Partial<NodeJS.ProcessEnv> = {}, script = installer) {
    return spawnSync("bash", [script, ...args], {
      cwd: fixture, encoding: "utf8", timeout: 15000, env: environment(overrides),
    });
  }

  function runInteractive(inputs: string[], overrides: Partial<NodeJS.ProcessEnv> = {}) {
    const driver = `
import json, os, pty, re, select, subprocess, sys, termios, time
inputs = json.load(sys.stdin)
master, slave = pty.openpty()
process = subprocess.Popen(["bash"] + sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
output = ""
pending = ""
hidden = []
deadline = time.monotonic() + 12
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            chunk = os.read(master, 65536).decode("utf8", errors="replace")
            output += chunk
            pending += chunk
            if re.search(r"(?:password|confirm|Also enable|HTTPS certificate)[^\\r\\n]*: *$", pending, re.I):
                if len(hidden) >= len(inputs):
                    raise RuntimeError("Unexpected extra credential prompt")
                hidden.append(not bool(termios.tcgetattr(slave)[3] & termios.ECHO))
                os.write(master, (inputs[len(hidden) - 1] + "\\n").encode())
                pending = ""
        elif process.poll() is not None:
            break
    if process.poll() is None:
        raise RuntimeError("Interactive installer timed out")
    print(json.dumps({"status": process.returncode, "output": output, "hidden": hidden}))
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
    os.close(slave)
`;
    const result = spawnSync("python3", ["-c", driver, installer, ...localArgs(), "--image", image], {
      cwd: fixture, encoding: "utf8", timeout: 15000, input: JSON.stringify(inputs),
      env: environment({ DEFAULT_PASSWORD: undefined, SUPER_ADMIN_PASSWORD: undefined, CHORUS_INSTALL_NONINTERACTIVE: undefined, ...overrides }),
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { status: number; output: string; hidden: boolean[] };
  }

  function calls(): { command: string; args: string[]; secretOverride?: boolean; passwordOverride?: boolean; imageOverride?: boolean; adminOverride?: boolean }[] {
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  }

  function localArgs(source = "pull") {
    return ["--target", "local", "--image-source", source, "--email", "owner@example.invalid", "--project", "fixture", "--port", "18638"];
  }

  function envPath() { return join(home, ".config/chorus-self-host/fixture/env"); }

  function addLanHttps() {
    const privateDir = join(home, ".config/chorus-self-host/fixture");
    const override = join(privateDir, "lan-https.yml");
    writeFileSync(override, readFileSync(join(root, "deploy/self-host/compose.lan-https.yml")));
    writeFileSync(join(privateDir, "server.crt"), "fixture-certificate", { mode: 0o600 });
    writeFileSync(join(privateDir, "server.key"), "fixture-key", { mode: 0o600 });
    writeFileSync(envPath(), readFileSync(envPath(), "utf8") +
      `CHORUS_TLS_CERT_FILE=${join(privateDir, "server.crt")}\nCHORUS_TLS_KEY_FILE=${join(privateDir, "server.key")}\nCHORUS_HTTPS_PORT=28638\n`);
    return override;
  }

  it.each(["--password-file", "--admin-password-file"])("rejects %s inside the Docker build context before reading it", option => {
    const result = run([...localArgs(), "--image", image, option, join(root, "package.json")]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside the source checkout");
    expect(calls()).toEqual([]);
    expect(existsSync(envPath())).toBe(false);
  });
  function wrapperPath() { return join(fixture, "default_deploy.sh"); }

  function renderConfig(extraFiles: string[] = [], args = ["--format", "json"]) {
    return spawnSync(realDocker, [
      "compose", "--project-name", "fixture", "--env-file", envPath(),
      "-f", join(root, "deploy/self-host/compose.yml"),
      "-f", join(root, "deploy/self-host/compose.local.yml"),
      ...extraFiles.flatMap(file => ["-f", file]), "config", ...args,
    ], { encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: home } });
  }

  it("passes shell syntax checks and excludes AWS generated secrets from image builds", () => {
    expect(spawnSync("bash", ["-n", installer]).status).toBe(0);
    expect(spawnSync("bash", ["-n", join(root, "deploy/self-host/install-local.sh")]).status).toBe(0);
    expect(spawnSync("bash", ["-n", deployHelper]).status).toBe(0);
    expect(readFileSync(join(root, ".dockerignore"), "utf8").split("\n")).toContain("default_deploy.sh");
  });

  it("pulls the selected app and PostgreSQL, then waits for LAN Compose without AWS", () => {
    const result = run([...localArgs(), "--image", image]);
    expect(result.status, result.stderr).toBe(0);
    expect(calls().every(call => call.command === "docker")).toBe(true);
    expect(calls().filter(call => call.args[0] === "pull").map(call => call.args)).toEqual([
      ["pull", image], ["pull", "postgres:17-alpine"], ["pull", "httpd:2.4-alpine"],
    ]);
    expect(calls().some(call => call.args[0] === "build")).toBe(false);
    const start = calls().find(call => call.args.includes("up"))!;
    expect(start.args).toContain(join(root, "deploy/self-host/compose.local.yml"));
    expect(start.args.slice(-7)).toEqual(["up", "-d", "--pull", "never", "--wait", "--wait-timeout", "180"]);
    expect(result.stdout).toContain("http://localhost:18638");
    expect(result.stdout).toContain("listen=0.0.0.0:18638");
    expect(result.stdout).toContain("http://<host-LAN-IP>:18638");
    expect(result.stdout).toContain("restrict this port to trusted networks");
    expect(existsSync(wrapperPath())).toBe(true);
  });

  it.each(["pull", "build"])("defaults %s deployments to host port 18637", source => {
    const result = run([...localArgs(source).slice(0, -2), "--image", image]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(envPath(), "utf8")).toContain("CHORUS_PORT=18637\n");
    expect(result.stdout).toContain("http://localhost:18637");
  });

  it("prefers an explicit port over the environment override", () => {
    const result = run([...localArgs(), "--image", image], { CHORUS_PORT: "18639" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(envPath(), "utf8")).toContain("CHORUS_PORT=18638\n");
  });

  it("keeps HTTPS disabled unless selected", () => {
    const result = run([...localArgs(), "--image", image], { CHORUS_LOCAL_HTTPS: undefined });
    expect(result.status, result.stderr).toBe(0);
    const privateDir = join(home, ".config/chorus-self-host/fixture");
    expect(existsSync(join(privateDir, "lan-https.yml"))).toBe(false);
    expect(existsSync(join(privateDir, "lan-tls"))).toBe(false);
    expect(calls().some(call => call.args.includes("lan-https"))).toBe(false);
  });

  it.each(["192.0.2.10", "chorus.example.invalid", `${"a".repeat(63)}.example.invalid`])("sets up optional HTTPS with a private certificate for %s", host => {
    const result = run([...localArgs().slice(0, -2), "--image", image, "--https-host", host]);
    expect(result.status, result.stderr).toBe(0);
    const privateDir = join(home, ".config/chorus-self-host/fixture");
    const certificate = join(privateDir, "lan-tls/server.crt");
    const key = join(privateDir, "lan-tls/server.key");
    const override = join(privateDir, "lan-https.yml");
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(statSync(certificate).mode & 0o777).toBe(0o600);
    expect(statSync(join(privateDir, "lan-tls")).mode & 0o777).toBe(0o700);
    expect(statSync(override).mode & 0o777).toBe(0o600);
    const certInfo = spawnSync("openssl", ["x509", "-in", certificate, "-noout", "-text"], { encoding: "utf8" });
    expect(certInfo.status, certInfo.stderr).toBe(0);
    expect(certInfo.stdout).toContain(host.includes("192.") ? `IP Address:${host}` : `DNS:${host}`);
    expect(result.stdout).toContain(`https://${host}:18638/login/callback`);
    expect(result.stdout).toContain("30-day self-signed certificate");
    expect(result.stdout).toContain(override);
    const start = calls().find(call => call.args.includes("up"))!;
    expect(start.args).toContain(override);
    expect(calls().some(call => call.args.slice(-2).join(" ") === "pull lan-https")).toBe(true);
    if (canRender) {
      const rendered = renderConfig([override]);
      expect(rendered.status, rendered.stderr).toBe(0);
      const config = JSON.parse(rendered.stdout);
      expect(config.services["lan-https"].ports[0].published).toBe("18638");
      expect(config.services["lan-https"].volumes[2].source).toBe(key);
      expect(config.services.app.ports[0].published).toBe("18637");
    }
    const savedKey = readFileSync(key, "utf8");
    const savedCertificate = readFileSync(certificate, "utf8");
    expect(run([], {}, wrapperPath()).status).toBe(0);
    expect(readFileSync(key, "utf8")).toBe(savedKey);
    expect(readFileSync(certificate, "utf8")).toBe(savedCertificate);
    expect(readFileSync(wrapperPath(), "utf8")).not.toContain("PRIVATE KEY");
  });

  it("previews environment-enabled HTTPS without generating keys or running Docker", () => {
    const result = run([...localArgs(), "--image", image, "--dry-run"], {
      CHORUS_LOCAL_HTTPS: undefined, CHORUS_HTTPS_HOST: "192.0.2.10", CHORUS_HTTPS_PORT: "28638",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("https://192.0.2.10:28638");
    expect(result.stdout).toContain("add lan-https.yml to Compose");
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(calls()).toEqual([]);
  });

  it("lets --no-https override environment HTTPS selection", () => {
    const result = run([...localArgs(), "--image", image, "--no-https", "--dry-run"], {
      CHORUS_LOCAL_HTTPS: "true", CHORUS_HTTPS_HOST: "192.0.2.10",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Optional HTTPS:");
  });

  it("does not start services when the initial HTTPS proxy pull fails", () => {
    const result = run([...localArgs().slice(0, -2), "--image", image, "--https-host", "192.0.2.10"], {
      STUB_FAILURE: "pull lan-https",
    });
    expect(result.status).not.toBe(0);
    expect(calls().some(call => call.args.includes("up"))).toBe(false);
    expect(existsSync(wrapperPath())).toBe(true);
    expect(existsSync(join(home, ".config/chorus-self-host/fixture/lan-tls/server.key"))).toBe(true);
    expect(run([], {}, wrapperPath()).status).toBe(0);
  });

  it.each([
    ["--https"], ["--https-host", "https://host.invalid"], ["--https-host", "192.0.2.999"],
    ["--https-host", "192.0.2.010"], ["--https-host", "host..invalid"], ["--https-host", "bad/host"],
    ["--https-host", "host.invalid,DNS:other.invalid"], ["--https-host", "host\n.invalid"],
    ["--https-host", `${"a".repeat(64)}.invalid`],
    ["--https-host", "::1"], ["--https-host", "-bad.invalid"], ["--https-host", "host.invalid", "--https-port", "0"],
    ["--https-host", "host.invalid", "--https-port", "65536"], ["--https-host", "host.invalid", "--https-port", "18638"],
  ])("rejects invalid or conflicting HTTPS input %j", (...args) => {
    const result = run([...localArgs(), "--image", image, "--https-port", "28638", ...args]);
    expect(result.status).not.toBe(0);
    expect(calls()).toEqual([]);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  it.skipIf(!canRender)("maps default host port 18637 to unchanged internal port 8637", () => {
    const result = run([...localArgs().slice(0, -2), "--image", image]);
    expect(result.status, result.stderr).toBe(0);
    const rendered = spawnSync(realDocker, [
      "compose", "--project-name", "fixture", "--env-file", envPath(),
      "-f", join(root, "deploy/self-host/compose.yml"),
      "-f", join(root, "deploy/self-host/compose.local.yml"), "config", "--format", "json",
    ], { encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: home } });
    expect(rendered.status, rendered.stderr).toBe(0);
    const config = JSON.parse(rendered.stdout);
    expect(config.services.app.ports).toEqual([
      expect.objectContaining({ host_ip: "0.0.0.0", published: "18637", target: 8637 }),
    ]);
    expect(config.services.app.environment.NEXTAUTH_URL).toBe("http://localhost:18637");
  });

  it("builds the current checkout production stage, never pulls its app tag", () => {
    const result = run(localArgs("build"));
    expect(result.status, result.stderr).toBe(0);
    expect(calls().find(call => call.args[0] === "build")?.args).toEqual([
      "build", "--target", "production", "--file", join(root, "Dockerfile"), "--tag", "chorus-local:fixture", root,
    ]);
    expect(calls().filter(call => call.args[0] === "pull").map(call => call.args)).toEqual([
      ["pull", "postgres:17-alpine"], ["pull", "httpd:2.4-alpine"],
    ]);
  });

  it("accepts the ordinary password, keeps admin plaintext private and excludes inherited overrides from Compose", () => {
    const result = run([...localArgs(), "--image", image], {
      DEFAULT_PASSWORD: "intended-password-canary", NEXTAUTH_SECRET: "ignored-secret-canary", CHORUS_IMAGE: "ignored:canary",
    });
    expect(result.status, result.stderr).toBe(0);
    const values = Object.fromEntries(readFileSync(envPath(), "utf8").trim().split("\n").map(line => line.split("=")));
    expect(values.POSTGRES_IMAGE).toBe("postgres:17-alpine");
    expect(values.POSTGRES_PASSWORD).toMatch(/^[a-f0-9]{64}$/);
    expect(values.DEFAULT_PASSWORD).toBe('"intended-password-canary"');
    expect(values.NEXTAUTH_SECRET).not.toBe("ignored-secret-canary");
    expect(values.SUPER_ADMIN_EMAIL).toBe(adminEmail);
    expect(values.SUPER_ADMIN_PASSWORD_HASH).toBe(`'${adminHash}'`);
    expect(readFileSync(envPath(), "utf8")).not.toContain(adminPassword);
    expect(values.POSTGRES_PASSWORD).not.toBe(values.DEFAULT_PASSWORD);
    expect(statSync(envPath()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".config/chorus-self-host/fixture")).mode & 0o777).toBe(0o700);
    const output = result.stdout + result.stderr + JSON.stringify(calls().map(call => call.args));
    expect(output).not.toContain(values.DEFAULT_PASSWORD);
    expect(output).not.toContain(values.POSTGRES_PASSWORD);
    expect(output).not.toContain("intended-password-canary");
    expect(output).not.toContain(adminPassword);
    expect(readFileSync(log, "utf8")).not.toContain(adminPassword);
    for (const call of calls().filter(call => call.args.includes("--env-file"))) {
      expect(call.passwordOverride).toBeUndefined();
      expect(call.secretOverride).toBeUndefined();
      expect(call.imageOverride).toBeUndefined();
      expect(call.adminOverride).toBeUndefined();
    }
  });

  it.skipIf(!canRender)("renders the generated private config with real Compose without starting containers", () => {
    const result = run([...localArgs(), "--image", image], { STUB_RENDERER: realDocker });
    expect(result.status, result.stderr).toBe(0);
    expect(calls().some(call => call.args.includes("config"))).toBe(true);
  });

  it("hashes admin credentials through isolated htpasswd stdin after preparing images", () => {
    const result = run([...localArgs(), "--image", image]);
    expect(result.status, result.stderr).toBe(0);
    const recorded = calls();
    const hashIndex = recorded.findIndex(call => call.args[0] === "run");
    expect(recorded[hashIndex].args).toEqual([
      "run", "--rm", "-i", "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--entrypoint", "htpasswd", "httpd:2.4-alpine", "-niBC", "12", "",
    ]);
    expect(recorded.slice(0, hashIndex).filter(call => call.args[0] === "pull").map(call => call.args[1])).toEqual([
      image, "postgres:17-alpine", "httpd:2.4-alpine",
    ]);
    expect(recorded.findIndex(call => call.args.includes("config"))).toBeGreaterThan(hashIndex);
    expect(result.stdout + result.stderr + readFileSync(log, "utf8")).not.toContain(adminPassword);
    expect(result.stdout + result.stderr).not.toContain(adminHash);
  });

  it.each(["DEFAULT_USER", "DEFAULT_PASSWORD", "SUPER_ADMIN_EMAIL", "SUPER_ADMIN_PASSWORD"])(
    "rejects missing %s without a terminal before Docker or file writes", name => {
      const args = ["--target", "local", "--image-source", "pull", "--image", image, "--project", "fixture"];
      const result = run(args, { [name]: undefined, CHORUS_INSTALL_NONINTERACTIVE: undefined });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(calls()).toEqual([]);
      expect(existsSync(join(home, ".config"))).toBe(false);
      expect(existsSync(wrapperPath())).toBe(false);
    },
  );

  it.each([
    ["DEFAULT_PASSWORD", "short"], ["SUPER_ADMIN_PASSWORD", "short"],
    ["DEFAULT_PASSWORD", "password\ninjection"], ["DEFAULT_PASSWORD", "password\rinjection"],
    ["SUPER_ADMIN_PASSWORD", "password\ninjection"], ["SUPER_ADMIN_PASSWORD", "password\rinjection"],
    ["SUPER_ADMIN_PASSWORD", "x".repeat(73)], ["SUPER_ADMIN_PASSWORD", "é".repeat(37)],
  ])("rejects invalid %s input without exposing its value", (name, value) => {
    const result = run([...localArgs(), "--image", image], { [name]: value });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(value);
    expect(calls()).toEqual([]);
    expect(existsSync(envPath())).toBe(false);
    expect(existsSync(wrapperPath())).toBe(false);
  });

  it.each(["x".repeat(72), "é".repeat(36)])("accepts an admin password at the 72-byte boundary", value => {
    const result = run([...localArgs(), "--image", image], {
      SUPER_ADMIN_PASSWORD: value, STUB_EXPECTED_ADMIN_PASSWORD: value,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(envPath(), "utf8")).not.toContain(value);
  });

  it.each(["12345678", "ordinary-".repeat(12)])("accepts an ordinary password without the admin-only byte limit", value => {
    const result = run([...localArgs(), "--image", image], { DEFAULT_PASSWORD: value });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(envPath(), "utf8")).toContain(`DEFAULT_PASSWORD="${value}"\n`);
  });

  it.each(["--password", "--admin-password"])("rejects plaintext password argument %s", option => {
    const result = run([...localArgs(), "--image", image, option, "argument-secret-canary"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain("argument-secret-canary");
    expect(calls()).toEqual([]);
    expect(existsSync(wrapperPath())).toBe(false);
  });

  it("accepts password files and explicit admin email without environment credentials", () => {
    const ordinaryFile = join(fixture, "ordinary password");
    const adminFile = join(fixture, "admin password");
    writeFileSync(ordinaryFile, `${password}\n`, { mode: 0o600 });
    writeFileSync(adminFile, `${adminPassword}\n`, { mode: 0o600 });
    const result = run([
      ...localArgs(), "--image", image, "--admin-email", "explicit-admin@example.invalid",
      "--password-file", ordinaryFile, "--admin-password-file", adminFile,
    ], { DEFAULT_PASSWORD: undefined, SUPER_ADMIN_PASSWORD: undefined, SUPER_ADMIN_EMAIL: undefined });
    expect(result.status, result.stderr).toBe(0);
    const saved = readFileSync(envPath(), "utf8");
    expect(saved).toContain(`DEFAULT_PASSWORD="${password}"\n`);
    expect(saved).toContain("SUPER_ADMIN_EMAIL=explicit-admin@example.invalid\n");
    expect(saved).not.toContain(adminPassword);
    expect(result.stdout + result.stderr + readFileSync(log, "utf8")).not.toContain(password);
  });

  it.skipIf(!canUsePty)("prompts for both passwords and confirmations with terminal echo disabled", () => {
    const result = runInteractive([password, password, adminPassword, adminPassword]);
    expect(result.status, result.output).toBe(0);
    expect(result.hidden).toEqual([true, true, true, true]);
    expect(result.output).not.toContain(password);
    expect(result.output).not.toContain(adminPassword);
    expect(readFileSync(envPath(), "utf8")).toContain(`DEFAULT_PASSWORD="${password}"\n`);
    expect(readFileSync(envPath(), "utf8")).toContain(adminHash);
  });

  it.skipIf(!canUsePty)("offers HTTPS in interactive setup and includes the selected proxy", () => {
    const result = runInteractive([password, password, adminPassword, adminPassword, "y", "192.0.2.10"], {
      CHORUS_LOCAL_HTTPS: undefined, CHORUS_HTTPS_PORT: "28638",
    });
    expect(result.status, result.output).toBe(0);
    expect(result.hidden).toEqual([true, true, true, true, false, false]);
    expect(result.output).toContain("https://192.0.2.10:28638");
    expect(calls().find(call => call.args.includes("up"))!.args).toContain(join(home, ".config/chorus-self-host/fixture/lan-https.yml"));
  });

  it.skipIf(!canUsePty)("defaults the interactive HTTPS choice to no", () => {
    const result = runInteractive([password, password, adminPassword, adminPassword, ""], {
      CHORUS_LOCAL_HTTPS: undefined,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Also enable self-signed LAN HTTPS?");
    expect(existsSync(join(home, ".config/chorus-self-host/fixture/lan-https.yml"))).toBe(false);
  });

  it.skipIf(!canUsePty).each([" ", "\t"])("preserves boundary whitespace in both interactive passwords (%j)", padding => {
    const ordinary = `${padding}${password}${padding}`;
    const administrator = `${padding}${adminPassword}${padding}`;
    const result = runInteractive([ordinary, ordinary, administrator, administrator], {
      STUB_EXPECTED_ADMIN_PASSWORD: administrator,
    });
    expect(result.status, result.output).toBe(0);
    expect(result.hidden).toEqual([true, true, true, true]);
    expect(readFileSync(envPath(), "utf8")).toContain(`DEFAULT_PASSWORD="${ordinary}"\n`);
    expect(result.output).not.toContain(password);
    expect(result.output).not.toContain(adminPassword);
  });

  it.skipIf(!canUsePty).each([
    [` ${password}`, password], [password, `${password} `],
    [password, password, `\t${adminPassword}`, adminPassword],
    [password, password, adminPassword, `${adminPassword}\t`],
  ])("rejects interactive confirmations differing only in whitespace (%j)", (...inputs) => {
    const result = runInteractive(inputs);
    expect(result.status).not.toBe(0);
    expect(result.hidden).toEqual(inputs.map(() => true));
    expect(result.output).toContain("confirmation does not match");
    expect(calls()).toEqual([]);
    expect(existsSync(envPath())).toBe(false);
    expect(existsSync(wrapperPath())).toBe(false);
  });

  it.skipIf(!canUsePty).each([
    [password, "wrong-confirmation"], [password, password, adminPassword, "wrong-confirmation"],
  ])("rejects an interactive password confirmation mismatch without side effects", (...inputs) => {
    const result = runInteractive(inputs);
    expect(result.status).not.toBe(0);
    expect(result.hidden).toEqual(inputs.map(() => true));
    expect(result.output).toMatch(/confirm|match/i);
    expect(result.output).not.toContain(password);
    expect(result.output).not.toContain(adminPassword);
    expect(result.output).not.toContain("wrong-confirmation");
    expect(calls()).toEqual([]);
    expect(existsSync(envPath())).toBe(false);
    expect(existsSync(wrapperPath())).toBe(false);
  });

  it.each(["--password-file", "--admin-password-file"])("rejects missing or multiline file for %s", option => {
    const missing = run([...localArgs(), "--image", image, option, join(fixture, "missing")]);
    expect(missing.status).not.toBe(0);
    const invalidFile = join(fixture, "invalid-password");
    writeFileSync(invalidFile, "first-password\nsecond-password\n", { mode: 0o600 });
    const invalid = run([...localArgs(), "--image", image, option, invalidFile]);
    expect(invalid.status).not.toBe(0);
    expect(calls()).toEqual([]);
    expect(existsSync(envPath())).toBe(false);
  });

  it.skipIf(!canRender).each([
    ["mixed punctuation", "fixture $UNDEFINED ${NOT_DEFINED} $$ # spaces \\ slash ' single \" double"],
    ["trailing backslash", "fixture-ending-backslash\\"],
    ["backslash before apostrophe", "fixture-backslash\\'apostrophe"],
  ])("preserves %s passwords through dotenv and real Compose rendering", (_, specialPassword) => {
    const result = run([...localArgs(), "--image", image], { DEFAULT_PASSWORD: specialPassword });
    expect(result.status, result.stderr).toBe(0);
    const escapedPassword = specialPassword.replace(/\\/g, "\\\\").replace(/"/g, '\\"').split("$").join("$$");
    expect(readFileSync(envPath(), "utf8")).toContain(`DEFAULT_PASSWORD="${escapedPassword}"\n`);
    const rendered = renderConfig();
    expect(rendered.status, rendered.stderr).toBe(0);
    const config = JSON.parse(rendered.stdout);
    expect(config.services.app.environment.DEFAULT_PASSWORD.split("$$").join("$")).toBe(specialPassword);
    expect(config.services.app.environment.SUPER_ADMIN_EMAIL).toBe(adminEmail);
    expect(config.services.app.environment.SUPER_ADMIN_PASSWORD_HASH.split("$$").join("$")).toBe(adminHash);
    expect(config.services.app.environment.SUPER_ADMIN_PASSWORD).toBeUndefined();
    const interpolation = renderConfig([], ["--environment"]);
    expect(interpolation.status, interpolation.stderr).toBe(0);
    expect(interpolation.stdout.split("\n")).toContain(`DEFAULT_PASSWORD=${specialPassword}`);
    expect(interpolation.stdout.split("\n")).toContain(`SUPER_ADMIN_PASSWORD_HASH=${adminHash}`);
  });

  it.each(["invalid-hash", `$2y$12$${"A".repeat(52)}`, `$2y$12$${"A".repeat(54)}`, ""])(
    "rejects malformed hash-tool output without saving credentials", hash => {
      const result = run([...localArgs(), "--image", image], { STUB_HASH: hash });
      expect(result.status).not.toBe(0);
      expect(existsSync(envPath())).toBe(false);
      expect(existsSync(wrapperPath())).toBe(false);
      expect(calls().some(call => call.args.includes("up"))).toBe(false);
    },
  );

  it.each(["pull", "build"])("dry-run %s has no command or filesystem side effects", source => {
    const result = run([...localArgs(source), "--image", image, "--dry-run"], {
      DEFAULT_PASSWORD: undefined, SUPER_ADMIN_PASSWORD: undefined,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Dry run");
    expect(result.stdout).toContain("Would pull postgres:17-alpine");
    expect(result.stdout).not.toContain("postgres:16");
    expect(result.stdout).not.toContain("httpd:2.4-alpine");
    expect(calls()).toEqual([]);
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(existsSync(wrapperPath())).toBe(false);
  });

  it.each(["DEFAULT_USER", "SUPER_ADMIN_EMAIL"])("still requires %s for a dry-run", name => {
    const result = run(["--target", "local", "--image-source", "pull", "--image", image, "--dry-run"], {
      [name]: undefined, DEFAULT_PASSWORD: undefined, SUPER_ADMIN_PASSWORD: undefined,
    });
    expect(result.status).not.toBe(0);
    expect(calls()).toEqual([]);
    expect(existsSync(join(home, ".config"))).toBe(false);
    expect(existsSync(wrapperPath())).toBe(false);
  });

  it.each([
    ["--image-source", "invalid"], ["--port", "0"], ["--port", "65536"], ["--port", "abc"],
    ["--project", "../existing"], ["--email", "bad\nEMAIL=injection"], ["--admin-email", "bad\nEMAIL=injection"], ["--image", "repo:latest"],
    ["--image", "registry:5000/repo"], ["--image", "repo:tag$injection"], ["--unknown", "value"],
  ])("rejects unsafe option %s=%s without mutation", (option, value) => {
    const result = run([...localArgs(), "--image", image, option, value]);
    expect(result.status).not.toBe(0);
    expect(calls()).toEqual([]);
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  it("fails missing values/no-TTY input instead of prompting", () => {
    for (const args of [["--target"], ["--target", "local", "--image-source"], ["--target", "local"]]) {
      const result = run(args, { CHORUS_INSTALL_NONINTERACTIVE: undefined });
      expect(result.status).not.toBe(0);
      expect(result.error).toBeUndefined();
    }
    expect(calls()).toEqual([]);
  });

  it("refuses an existing private directory without changing its config", () => {
    mkdirSync(join(home, ".config/chorus-self-host/fixture"), { recursive: true });
    writeFileSync(envPath(), "sentinel-original\n");
    const result = run([...localArgs(), "--image", image]);
    expect(result.status).not.toBe(0);
    expect(readFileSync(envPath(), "utf8")).toBe("sentinel-original\n");
    expect(calls()).toEqual([]);
  });

  it("refuses an existing deployment wrapper without overwriting or executing it", () => {
    const original = "#!/usr/bin/env bash\naws deploy unexpected\nexit 99\n";
    writeFileSync(wrapperPath(), original, { mode: 0o700 });
    const result = run([...localArgs(), "--image", image]);
    expect(result.status).not.toBe(0);
    expect(readFileSync(wrapperPath(), "utf8")).toBe(original);
    expect(calls()).toEqual([]);
    expect(existsSync(envPath())).toBe(false);
  });

  it("refuses a dangling deployment wrapper symlink without creating its target", () => {
    const target = join(fixture, "missing-wrapper-target");
    symlinkSync(target, wrapperPath());
    const result = run([...localArgs(), "--image", image]);
    expect(result.status).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(calls()).toEqual([]);
    expect(existsSync(envPath())).toBe(false);
  });

  it("writes to an alternate deployment wrapper path without touching an existing wrapper", () => {
    writeFileSync(wrapperPath(), "sentinel-original\n");
    const alternate = join(fixture, "alternate deploy.sh");
    const result = run([...localArgs(), "--image", image], { CHORUS_DEPLOY_CONFIG: alternate });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(wrapperPath(), "utf8")).toBe("sentinel-original\n");
    expect(statSync(alternate).mode & 0o777).toBe(0o700);
    const rerun = run(["--dry-run"], {}, alternate);
    expect(rerun.status, rerun.stderr).toBe(0);
  });

  it("rejects a private path redirected into the checkout", () => {
    symlinkSync(root, join(home, ".config"));
    const result = run([...localArgs(), "--image", image]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("outside the source checkout");
    expect(calls()).toEqual([]);
  });

  it.each(["ps", "volume", "network"])("refuses existing project %s resources", resource => {
    const result = run([...localArgs(), "--image", image], { STUB_RESOURCES: resource });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Nothing reused");
    expect(calls().some(call => ["pull", "build"].includes(call.args[0]))).toBe(false);
    expect(existsSync(envPath())).toBe(false);
  });

  it.each(["docker pull example", "docker pull postgres", "docker build", "docker pull httpd", "docker run"])("propagates image/hash failure %s without starting services", failure => {
    const source = failure === "docker build" ? "build" : "pull";
    const result = run([...localArgs(source), "--image", image], { STUB_FAILURE: failure });
    expect(result.status).not.toBe(0);
    expect(calls().some(call => call.args.includes("up"))).toBe(false);
    expect(existsSync(envPath())).toBe(false);
  });

  it.each([
    ["volume", "fixture_db-data"], ["volume", "fixture_app-data"], ["network", "fixture_default"],
    ["ps", "fixture-app-1"], ["ps", "fixture_db_1"],
  ])("refuses exact-name unlabelled %s resource %s before image mutation", (kind, name) => {
    const result = run([...localArgs(), "--image", image], { STUB_NAMED_KIND: kind, STUB_NAMED_RESOURCE: name });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("regardless of labels");
    expect(calls().some(call => ["pull", "build"].includes(call.args[0]))).toBe(false);
    expect(existsSync(envPath())).toBe(false);
  });

  it.each(["docker volume ls --format", "docker network ls --format", "docker ps -a --format"])(
    "fails closed on resource inventory error %s", failure => {
      const result = run([...localArgs(), "--image", image], { STUB_FAILURE: failure });
      expect(result.status).not.toBe(0);
      expect(calls().some(call => ["pull", "build"].includes(call.args[0]))).toBe(false);
      expect(existsSync(envPath())).toBe(false);
    },
  );

  it("does not confuse similar volume names with an exact collision", () => {
    const result = run([...localArgs(), "--image", image], {
      STUB_NAMED_KIND: "volume", STUB_NAMED_RESOURCE: "other_db-data\nfixture_db-data-old\nother_app-data",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("retains config on health/start failure without deleting any resources", () => {
    const result = run([...localArgs(), "--image", image], { STUB_FAILURE: "up -d" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Startup failed");
    expect(existsSync(envPath())).toBe(true);
    expect(calls().some(call => call.args.some(arg => ["down", "rm", "prune"].includes(arg)))).toBe(false);
  });

  it.each(["pull", "build"])("generates a private secret-free %s wrapper that reuses saved state on rerun", source => {
    const installed = run([...localArgs(source), "--image", image]);
    expect(installed.status, installed.stderr).toBe(0);
    const saved = readFileSync(envPath(), "utf8");
    const wrapper = readFileSync(wrapperPath(), "utf8");
    expect(statSync(wrapperPath()).mode & 0o777).toBe(0o700);
    expect(spawnSync("bash", ["-n", wrapperPath()]).status).toBe(0);
    for (const value of [password, adminPassword, adminHash, saved.match(/^POSTGRES_PASSWORD=(.*)$/m)![1]]) {
      expect(wrapper).not.toContain(value);
    }
    expect(wrapper).toContain("deploy/self-host/deploy-local.sh");
    expect(wrapper).toContain(root);
    expect(wrapper).toContain("fixture");
    expect(wrapper).toContain(join(home, ".config/chorus-self-host/fixture"));
    expect(wrapper).toContain(source);
    expect(wrapper).not.toContain("--skip-image-preparation");
    const firstCalls = calls();
    const rerun = run([], {
      DEFAULT_USER: "ignored@example.invalid", DEFAULT_PASSWORD: "ignored-rerun-password",
      SUPER_ADMIN_PASSWORD: "ignored-rerun-admin", SUPER_ADMIN_EMAIL: "ignored-admin@example.invalid",
      CHORUS_IMAGE: "ignored:canary", POSTGRES_IMAGE: "postgres:16-alpine",
      POSTGRES_PASSWORD: "ignored-database-password", NEXTAUTH_SECRET: "ignored-auth-secret",
      COMPOSE_FILE: "/not-the-saved-compose.yml", COMPOSE_PROJECT_NAME: "ignored-project",
    }, wrapperPath());
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(readFileSync(envPath(), "utf8")).toBe(saved);
    expect(readFileSync(wrapperPath(), "utf8")).toBe(wrapper);
    const repeated = calls().slice(firstCalls.length);
    expect(repeated.every(call => call.command === "docker")).toBe(true);
    expect(repeated.some(call => call.args[0] === "run")).toBe(false);
    expect(repeated.some(call => call.args.includes("httpd:2.4-alpine"))).toBe(false);
    expect(repeated.some(call => call.args.some(arg => ["down", "rm", "prune", "--force-recreate", "--renew-anon-volumes"].includes(arg)))).toBe(false);
    expect(repeated.some(call => call.args[0] === "image" && call.args[1] === "inspect" && call.args[2] === "postgres:17-alpine")).toBe(true);
    if (source === "build") {
      const builds = calls().filter(call => call.args[0] === "build");
      expect(builds).toHaveLength(2);
      for (const build of builds) {
        expect(build.args).toEqual(["build", "--target", "production", "--file", join(root, "Dockerfile"), "--tag", image, root]);
      }
      expect(repeated.some(call => call.args[0] === "pull")).toBe(false);
    } else {
      expect(calls().filter(call => call.args[0] === "pull" && call.args[1] === image)).toHaveLength(2);
      expect(repeated.filter(call => call.args[0] === "pull").map(call => call.args)).toEqual([["pull", image]]);
    }
    const start = repeated.find(call => call.args.includes("up"))!;
    expect(start.args).toEqual([
      "compose", "--project-name", "fixture", "--env-file", envPath(),
      "-f", join(root, "deploy/self-host/compose.yml"), "-f", join(root, "deploy/self-host/compose.local.yml"),
      "up", "-d", "--pull", "never", "--wait", "--wait-timeout", "180",
    ]);
    const configIndex = repeated.findIndex(call => call.args.includes("config"));
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(configIndex).toBeLessThan(repeated.indexOf(start));
    expect(start.passwordOverride).toBeUndefined();
    expect(start.adminOverride).toBeUndefined();
    expect(start.secretOverride).toBeUndefined();
    expect(start.imageOverride).toBeUndefined();
  });

  it("pulls the saved database image on rerun only when it is missing locally", () => {
    const installed = run([...localArgs(), "--image", image]);
    expect(installed.status, installed.stderr).toBe(0);
    const saved = readFileSync(envPath(), "utf8").replace("POSTGRES_IMAGE=postgres:17-alpine", "POSTGRES_IMAGE=postgres:17.6-alpine");
    writeFileSync(envPath(), saved);
    writeFileSync(log, "");
    const rerun = run([], { STUB_IMAGE_MISSING: "1" }, wrapperPath());
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(calls().filter(call => call.args[0] === "pull").map(call => call.args)).toEqual([
      ["pull", image], ["pull", "postgres:17.6-alpine"],
    ]);
    expect(readFileSync(envPath(), "utf8")).toBe(saved);
  });

  it("includes private HTTPS and PG17 restore overrides on every rerun", () => {
    const installed = run([...localArgs(), "--image", image]);
    expect(installed.status, installed.stderr).toBe(0);
    const privateDir = join(home, ".config/chorus-self-host/fixture");
    const https = join(privateDir, "https.yml");
    const pg17 = join(privateDir, "pg17.yml");
    const httpsContent = 'services:\n  app:\n    environment:\n      NEXTAUTH_URL: https://fixture.example.invalid\n      COOKIE_SECURE: "true"\n';
    const pg17Content = 'volumes:\n  db-data:\n    external: true\n    name: fixture_restored_pg17\n';
    writeFileSync(https, httpsContent);
    writeFileSync(pg17, pg17Content);
    const saved = readFileSync(envPath(), "utf8");
    writeFileSync(log, "");
    const rerun = run([], canRender ? { STUB_RENDERER: realDocker } : {}, wrapperPath());
    expect(rerun.status, rerun.stderr).toBe(0);
    const composeCalls = calls().filter(call => call.args.includes("--env-file"));
    expect(composeCalls).toHaveLength(2);
    for (const call of composeCalls) {
      const files = call.args.filter((_, index) => call.args[index - 1] === "-f");
      expect(files).toEqual([
        join(root, "deploy/self-host/compose.yml"), join(root, "deploy/self-host/compose.local.yml"), https, pg17,
      ]);
    }
    expect(readFileSync(envPath(), "utf8")).toBe(saved);
    expect(readFileSync(https, "utf8")).toBe(httpsContent);
    expect(readFileSync(pg17, "utf8")).toBe(pg17Content);
    if (canRender) {
      const rendered = renderConfig([https, pg17]);
      expect(rendered.status, rendered.stderr).toBe(0);
      const config = JSON.parse(rendered.stdout);
      expect(config.volumes["db-data"]).toMatchObject({ name: "fixture_restored_pg17", external: true });
      expect(config.services.app.environment.NEXTAUTH_URL).toBe("https://fixture.example.invalid");
      expect(config.services.app.environment.COOKIE_SECURE).toBe("true");
    }
  });

  it("prepares optional LAN HTTPS before redeploy, preserving private configuration", () => {
    const installed = run([...localArgs(), "--image", image]);
    expect(installed.status, installed.stderr).toBe(0);
    const override = addLanHttps();
    const saved = readFileSync(envPath(), "utf8");
    writeFileSync(log, "");
    const rerun = run([], {
      ...(canRender ? { STUB_RENDERER: realDocker } : {}),
      CHORUS_TLS_CERT_FILE: "", CHORUS_TLS_KEY_FILE: "", CHORUS_HTTPS_PORT: "invalid-port",
      CHORUS_HTTPS_IMAGE: "invalid image",
    }, wrapperPath());
    expect(rerun.status, rerun.stderr).toBe(0);
    const composeCalls = calls().filter(call => call.args.includes("--env-file"));
    expect(composeCalls.map(call => call.args.slice(-2))).toContainEqual(["pull", "lan-https"]);
    expect(composeCalls.findIndex(call => call.args.includes("pull")))
      .toBeLessThan(composeCalls.findIndex(call => call.args.includes("up")));
    for (const call of composeCalls) expect(call.args).toContain(override);
    expect(readFileSync(envPath(), "utf8")).toBe(saved);
    if (canRender) {
      const rendered = renderConfig([override]);
      expect(rendered.status, rendered.stderr).toBe(0);
      const config = JSON.parse(rendered.stdout);
      expect(config.services["lan-https"].ports[0].published).toBe("28638");
      expect(config.services["lan-https"].volumes[0].source).toBe(join(root, "deploy/self-host/nginx.lan-https.conf"));
      expect(config.services.app.environment.COOKIE_SECURE).toBe("false");
    }
  });

  it("does not deploy if the optional HTTPS image pull fails", () => {
    expect(run([...localArgs(), "--image", image]).status).toBe(0);
    addLanHttps();
    const saved = readFileSync(envPath(), "utf8");
    writeFileSync(log, "");
    const rerun = run([], { STUB_FAILURE: "pull lan-https" }, wrapperPath());
    expect(rerun.status).not.toBe(0);
    expect(calls().some(call => call.args.includes("up"))).toBe(false);
    expect(readFileSync(envPath(), "utf8")).toBe(saved);
  });

  it.each([false, true])("runs wrapper dry-run with no Docker calls or credential changes (HTTPS=%s)", https => {
    const installed = run([...localArgs(), "--image", image]);
    expect(installed.status, installed.stderr).toBe(0);
    const override = https ? addLanHttps() : undefined;
    const saved = readFileSync(envPath(), "utf8");
    const wrapper = readFileSync(wrapperPath(), "utf8");
    const envModified = statSync(envPath()).mtimeMs;
    writeFileSync(log, "");
    const rerun = run(["--dry-run"], {
      DEFAULT_PASSWORD: undefined, SUPER_ADMIN_PASSWORD: undefined, DEFAULT_USER: undefined, SUPER_ADMIN_EMAIL: undefined,
    }, wrapperPath());
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(rerun.stdout).toMatch(/dry run/i);
    if (override) expect(rerun.stdout).toContain(override);
    expect(calls()).toEqual([]);
    expect(readFileSync(envPath(), "utf8")).toBe(saved);
    expect(readFileSync(wrapperPath(), "utf8")).toBe(wrapper);
    expect(statSync(envPath()).mtimeMs).toBe(envModified);
    expect(rerun.stdout + rerun.stderr).not.toContain(password);
    expect(rerun.stdout + rerun.stderr).not.toContain(adminHash);
  });

  it.each([
    ["--project", "other"], ["--private-dir", "saved-directory"], ["--image-source", "build"],
    ["--image", "other:v2"], ["--skip-image-preparation"], ["--force-recreate"],
  ])("rejects wrapper argument overrides %s", (...args) => {
    const installed = run([...localArgs(), "--image", image]);
    expect(installed.status, installed.stderr).toBe(0);
    const saved = readFileSync(envPath(), "utf8");
    writeFileSync(log, "");
    const rerun = run(args.map(arg => arg === "saved-directory" ? join(home, ".config/chorus-self-host/fixture") : arg), {}, wrapperPath());
    expect(rerun.status).not.toBe(0);
    expect(calls()).toEqual([]);
    expect(readFileSync(envPath(), "utf8")).toBe(saved);
  });

  it.each(["docker pull example", "docker build", "docker pull postgres", "config --quiet", "up -d"])(
    "propagates rerun failure %s without replacing config or deleting resources", failure => {
      const source = failure === "docker build" ? "build" : "pull";
      const installed = run([...localArgs(source), "--image", image]);
      expect(installed.status, installed.stderr).toBe(0);
      const saved = readFileSync(envPath(), "utf8");
      const wrapper = readFileSync(wrapperPath(), "utf8");
      writeFileSync(log, "");
      const rerun = run([], { STUB_FAILURE: failure, STUB_IMAGE_MISSING: "1" }, wrapperPath());
      expect(rerun.status).not.toBe(0);
      expect(readFileSync(envPath(), "utf8")).toBe(saved);
      expect(readFileSync(wrapperPath(), "utf8")).toBe(wrapper);
      expect(calls().some(call => call.args.some(arg => ["down", "rm", "prune", "--force-recreate"].includes(arg)))).toBe(false);
      if (failure !== "up -d") expect(calls().some(call => call.args.includes("up"))).toBe(false);
    },
  );

  it("fails a rerun with missing private env instead of regenerating credentials", () => {
    const installed = run([...localArgs(), "--image", image]);
    expect(installed.status, installed.stderr).toBe(0);
    rmSync(envPath());
    writeFileSync(log, "");
    const rerun = run([], {}, wrapperPath());
    expect(rerun.status).not.toBe(0);
    expect(existsSync(envPath())).toBe(false);
    expect(calls()).toEqual([]);
  });

  it.each(["local", "unmarked"])("refuses AWS reuse/overwrite of a %s wrapper", target => {
    const body = `#!/usr/bin/env bash\n${target === "local" ? "CHORUS_DEPLOY_TARGET=local\n" : ""}exit 99\n`;
    writeFileSync(wrapperPath(), body, { mode: 0o700 });
    const result = run(["--target", "aws", "--dry-run"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("refusing AWS reuse/overwrite");
    expect(readFileSync(wrapperPath(), "utf8")).toBe(body);
    expect(calls()).toEqual([]);
  });

  it.each(["alb", "cloudfront"])("preserves default AWS %s dry-run routing", mode => {
    const result = run([], {
      CHORUS_INSTALL_DRY_RUN: "1", DEPLOY_MODE: mode, AWS_REGION: "us-east-1",
      ACM_CERT_ARN: mode === "alb" ? "arn:aws:acm:us-east-1:000000000000:certificate/fixture" : "",
      ADMIN_EMAIL: "admin@example.invalid", ADMIN_PASSWORD: "test-only-password",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(wrapperPath(), "utf8")).toContain("CHORUS_DEPLOY_TARGET=aws\n");
    expect(calls().some(call => call.command === "aws")).toBe(true);
    expect(calls().some(call => call.command === "docker")).toBe(false);
    expect(readFileSync(join(fixture, "default_deploy.sh"), "utf8")).toContain(`DEPLOY_MODE="${mode}"`);
  });

  it("routes environment-only local/build inputs without a terminal", () => {
    const result = run([], {
      CHORUS_INSTALL_TARGET: "local", CHORUS_IMAGE_SOURCE: "build", DEFAULT_USER: "owner@example.invalid",
      CHORUS_LOCAL_PROJECT: "fixture", CHORUS_PORT: "18638", CHORUS_INSTALL_NONINTERACTIVE: undefined,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(calls().some(call => call.args[0] === "build")).toBe(true);
    expect(readFileSync(envPath(), "utf8")).toContain("CHORUS_PORT=18638\n");
  });
});
