// Covers the generated settings that back the `workspace` permission posture:
// the four sandbox invariants, read-deny defaults, network allowances, and the
// two credential-resolution paths (extracted vs explicit) plus the failure that
// must NOT be silent.
import { describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceSettings,
  extractAuthSettings,
  hasUsableAuth,
  defaultDenyRules,
  writeWorkspaceSettings,
  FORWARDED_AUTH_KEYS,
  DEFAULT_DENIED_READ_DIRS,
  DEFAULT_ALLOWED_DOMAINS,
} from "../workspace-settings.mjs";

const operatorSettings = {
  awsCredentialExport: '"/path/to/claude" default-credential-export',
  model: "global.anthropic.claude-opus-5-5[1m]",
  fallbackModel: ["global.anthropic.claude-opus-5[1m]"],
  env: { AWS_REGION: "us-west-2", CLAUDE_CODE_USE_BEDROCK: "1", UNRELATED: "x" },
  permissions: { defaultMode: "auto" },
  statusLine: { type: "command" },
};

/** Injected IO: read returns a map of path → content; writes are captured. */
function mkIO(files = {}) {
  const written = {};
  return {
    written,
    io: {
      read: (p) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p];
      },
      write: (p, c, opts) => {
        written.path = p;
        written.content = c;
        written.opts = opts;
      },
      mkdir: vi.fn(),
      rename: (from, to) => {
        written.renamedFrom = from;
        written.renamedTo = to;
      },
      rm: vi.fn(),
    },
  };
}

describe("extractAuthSettings", () => {
  it("picks only credential-bearing keys and the forwarded env subset", () => {
    const auth = extractAuthSettings(operatorSettings);
    expect(auth.awsCredentialExport).toBe(operatorSettings.awsCredentialExport);
    expect(auth.model).toBe(operatorSettings.model);
    expect(auth.env).toEqual({ AWS_REGION: "us-west-2", CLAUDE_CODE_USE_BEDROCK: "1" });
    // Operator settings we must NOT carry over: their permissions would fight
    // the generated ones, and unrelated UI config is noise.
    expect(auth.permissions).toBeUndefined();
    expect(auth.statusLine).toBeUndefined();
    expect(auth.env.UNRELATED).toBeUndefined();
  });

  it("returns {} for a missing or empty source rather than throwing", () => {
    for (const input of [null, {}, { statusLine: {} }]) expect(extractAuthSettings(input)).toEqual({});
  });
});

describe("hasUsableAuth", () => {
  it("accepts a credential hook or a provider env var", () => {
    expect(hasUsableAuth({ awsCredentialExport: "x" })).toBe(true);
    expect(hasUsableAuth({ apiKeyHelper: "x" })).toBe(true);
    expect(hasUsableAuth({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } })).toBe(true);
    expect(hasUsableAuth({ env: { ANTHROPIC_BASE_URL: "https://x" } })).toBe(true);
  });

  it("rejects a model-only object: naming a model authenticates nothing", () => {
    expect(hasUsableAuth({ model: "m", fallbackModel: ["n"] })).toBe(false);
    expect(hasUsableAuth({ env: { AWS_REGION: "us-west-2" } })).toBe(false);
    expect(hasUsableAuth({})).toBe(false);
  });
});

describe("buildWorkspaceSettings", () => {
  it("pins all four sandbox invariants", () => {
    const { settings } = buildWorkspaceSettings({ operatorSettings });
    expect(settings.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      // The escape hatch must be off, or dangerouslyDisableSandbox reopens everything.
      allowUnsandboxedCommands: false,
      // Explicit, not defaulted: managed settings still apply and could add one.
      excludedCommands: [],
    });
  });

  it("never leaves defaultMode on auto", () => {
    // `auto` lets the classifier approve on its own; relying on that is how the
    // allowlist-only posture became a silent no-op.
    const { settings } = buildWorkspaceSettings({ operatorSettings });
    expect(settings.permissions.defaultMode).toBe("dontAsk");
  });

  it("denies reads of every default sensitive dir, under the given home", () => {
    const { settings } = buildWorkspaceSettings({ operatorSettings, home: "/home/op" });
    for (const dir of DEFAULT_DENIED_READ_DIRS) {
      expect(settings.permissions.deny).toContain(`Read(//home/op/${dir}/**)`);
    }
  });

  it("allows the default dev domains and appends operator additions", () => {
    const { settings } = buildWorkspaceSettings({
      operatorSettings, extraAllowedDomains: ["internal.example.com"],
    });
    for (const domain of DEFAULT_ALLOWED_DOMAINS) {
      expect(settings.permissions.allow).toContain(`WebFetch(domain:${domain})`);
    }
    expect(settings.permissions.allow).toContain("WebFetch(domain:internal.example.com)");
  });

  it("lets an operator append deny rules without losing the defaults", () => {
    const { settings } = buildWorkspaceSettings({
      operatorSettings, home: "/home/op", extraDenyRules: ["Read(//srv/secrets/**)"],
    });
    expect(settings.permissions.deny).toContain("Read(//srv/secrets/**)");
    expect(settings.permissions.deny).toContain("Read(//home/op/.ssh/**)");
  });

  it("prefers an explicit auth file over extraction", () => {
    const explicit = { apiKeyHelper: "/usr/local/bin/key-helper" };
    const built = buildWorkspaceSettings({ operatorSettings, authSettings: explicit });
    expect(built.authSource).toBe("explicit");
    expect(built.settings.apiKeyHelper).toBe(explicit.apiKeyHelper);
    // Extraction is not merged in underneath: an operator who supplied a file did
    // so because extraction could not work for their build.
    expect(built.settings.awsCredentialExport).toBeUndefined();
  });

  it("reports authSource none when nothing resolves", () => {
    expect(buildWorkspaceSettings({ operatorSettings: null }).authSource).toBe("none");
  });
});

describe("defaultDenyRules", () => {
  it("emits absolute // rules with forward slashes on any platform", () => {
    const rules = defaultDenyRules("/home/op");
    expect(rules.every((r) => r.startsWith("Read(//") && r.endsWith("/**)"))).toBe(true);
    expect(rules.some((r) => r.includes("\\"))).toBe(false);
  });
});

describe("writeWorkspaceSettings", () => {
  const OP = "/cfg/settings.json";

  it("writes 0600 atomically and reports the extracted source", () => {
    const { io, written } = mkIO({ [OP]: JSON.stringify(operatorSettings) });
    const res = writeWorkspaceSettings({ operatorSettingsPath: OP, dir: "/run/ws" }, io);
    expect(res.authSource).toBe("extracted");
    expect(written.opts).toEqual({ mode: 0o600 });
    expect(written.renamedFrom).toBe("/run/ws/settings.json.tmp");
    expect(written.renamedTo).toBe("/run/ws/settings.json");
    expect(JSON.parse(written.content).sandbox.enabled).toBe(true);
  });

  it("fails loudly when no credentials resolve, naming the override", () => {
    // A workspace wake with no credentials retries 403 until killed. That has to
    // read as a configuration error, never as a hang.
    const { io, written } = mkIO({ [OP]: JSON.stringify({ model: "m" }) });
    expect(() => writeWorkspaceSettings({ operatorSettingsPath: OP, dir: "/run/ws" }, io))
      .toThrow(/claudeSettingsPath/);
    expect(written.content).toBeUndefined();
    for (const key of FORWARDED_AUTH_KEYS.slice(0, 2)) {
      expect(() => writeWorkspaceSettings({ operatorSettingsPath: OP, dir: "/run/ws" }, io)).toThrow(new RegExp(key));
    }
  });

  it("fails loudly when an explicit settings file is missing or malformed", () => {
    const { io } = mkIO({ [OP]: JSON.stringify(operatorSettings), "/bad.json": "{nope" });
    expect(() => writeWorkspaceSettings({ operatorSettingsPath: OP, authSettingsPath: "/bad.json" }, io))
      .toThrow(/missing or not valid JSON/);
    expect(() => writeWorkspaceSettings({ operatorSettingsPath: OP, authSettingsPath: "/absent.json" }, io))
      .toThrow(/missing or not valid JSON/);
  });

  it("treats an unreadable operator settings file as absent, not as a crash", () => {
    const { io } = mkIO({});
    expect(() => writeWorkspaceSettings({ operatorSettingsPath: OP, dir: "/run/ws" }, io)).toThrow(/no usable/);
  });

  it("cleans up the whole per-wake directory, not just the file", () => {
    const { io } = mkIO({ [OP]: JSON.stringify(operatorSettings) });
    writeWorkspaceSettings({ operatorSettingsPath: OP, dir: "/run/ws" }, io).cleanup();
    expect(io.rm).toHaveBeenCalledWith("/run/ws");
  });

  it("gives each wake its own directory when none is supplied", () => {
    const { io } = mkIO({ [OP]: JSON.stringify(operatorSettings) });
    const a = writeWorkspaceSettings({ operatorSettingsPath: OP }, io).path;
    const b = writeWorkspaceSettings({ operatorSettingsPath: OP }, io).path;
    expect(a).not.toBe(b);
  });
});
