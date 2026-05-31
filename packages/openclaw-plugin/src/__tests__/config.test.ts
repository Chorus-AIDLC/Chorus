import { describe, it, expect, vi } from "vitest";
import {
  resolveConfig,
  validateConfigWithWarnings,
  CONFIG_FILE_PATH,
  CONFIG_KEY_PATH,
  type ChorusPluginConfig,
} from "../config.js";

describe("resolveConfig", () => {
  it("returns undefined for missing chorusUrl/apiKey", () => {
    const cfg = resolveConfig(undefined);
    expect(cfg.chorusUrl).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
  });

  it("passes through provided values", () => {
    const cfg = resolveConfig({
      chorusUrl: "https://chorus.example.com",
      apiKey: "cho_abc",
    });
    expect(cfg.chorusUrl).toBe("https://chorus.example.com");
    expect(cfg.apiKey).toBe("cho_abc");
  });

  it("coerces empty-string url/key to undefined", () => {
    const cfg = resolveConfig({ chorusUrl: "", apiKey: "" });
    expect(cfg.chorusUrl).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
  });

  it("ignores unknown extra keys in the raw bag", () => {
    const cfg = resolveConfig({ chorusUrl: "https://c.example.com", apiKey: "cho_x", extra: 1 });
    expect(cfg).toEqual({ chorusUrl: "https://c.example.com", apiKey: "cho_x" });
  });
});

describe("validateConfigWithWarnings", () => {
  function makeLogger() {
    return { warn: vi.fn() };
  }

  it("returns true and does not warn when both required fields present", () => {
    const logger = makeLogger();
    const cfg: ChorusPluginConfig = {
      chorusUrl: "https://c.example.com",
      apiKey: "cho_x",
    };
    expect(validateConfigWithWarnings(cfg, logger)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns false and warns naming chorusUrl when missing", () => {
    const logger = makeLogger();
    const cfg: ChorusPluginConfig = {
      apiKey: "cho_x",
    };
    expect(validateConfigWithWarnings(cfg, logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0][0]).toContain("chorusUrl");
    expect(logger.warn.mock.calls[0][0]).not.toContain('"apiKey"');
  });

  it("returns false and warns naming apiKey when missing", () => {
    const logger = makeLogger();
    const cfg: ChorusPluginConfig = {
      chorusUrl: "https://c.example.com",
    };
    expect(validateConfigWithWarnings(cfg, logger)).toBe(false);
    expect(logger.warn.mock.calls[0][0]).toContain("apiKey");
  });

  it("names both fields when both missing, referencing the config path", () => {
    const logger = makeLogger();
    const cfg: ChorusPluginConfig = {};
    expect(validateConfigWithWarnings(cfg, logger)).toBe(false);
    const msg = logger.warn.mock.calls[0][0];
    expect(msg).toContain("chorusUrl");
    expect(msg).toContain("apiKey");
    expect(msg).toContain(CONFIG_KEY_PATH);
    expect(msg).toContain(CONFIG_FILE_PATH);
  });
});
