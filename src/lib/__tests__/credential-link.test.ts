import { describe, expect, it } from "vitest";
import { credentialLinkUrl } from "../credential-link";

const token = "Ab0_-".repeat(8) + "xyz";
const path = `/login/local/accept?token=${token}`;
const origin = "https://workspace.customer.example";

describe("credentialLinkUrl", () => {
  it("hydrates a relative credential link on a custom CNAME origin", () => {
    expect(token).toHaveLength(43);
    expect(credentialLinkUrl(path, origin)).toBe(`${origin}${path}`);
  });

  it.each(["https://backend.example.com", "http://localhost:8637"])("discards the legacy server origin %s", (backend) => {
    expect(credentialLinkUrl(`${backend}${path}`, origin)).toBe(`${origin}${path}`);
  });

  it("uses the browser origin including its port, not a supplied path or query", () => {
    expect(credentialLinkUrl(path, "http://localhost:8637/settings?foo=bar")).toBe(`http://localhost:8637${path}`);
  });

  it.each([
    "",
    "/login/local/accept",
    "/login/local/accept?token=",
    "/login/local/accept?token=opaque-fixture",
    `/login/local/accept?token=${"a".repeat(42)}`,
    `/login/local/accept?token=${"a".repeat(44)}`,
    `/login/local/accept?token=${"a".repeat(42)}%2B`,
    `/login/local/accept?token=${"a".repeat(42)}%2F`,
    `/login/local/accept?token=${"a".repeat(42)}%3D`,
    `/login/local/accept?token=${"a".repeat(42)}%20`,
    `/login/local/accept?TOKEN=${token}`,
    `/login/local/accept?token=${token}&token=${token}`,
    `/login/local/accept?token=${token}&next=/admin`,
    `/login/local/accept?extra=1&token=${token}`,
    `/login/local/accept?token=${token}#fragment`,
    `/login/local/accept/?token=${token}`,
    `/login/local/accept/other?token=${token}`,
    `/login/local/reset?token=${token}`,
    `/other/login/local/accept?token=${token}`,
    `https://user@backend.example.com${path}`,
    `https://user:password@backend.example.com${path}`,
    `ftp://backend.example.com${path}`,
    `javascript:alert(1)`,
    `data:text/plain,${path}`,
    `https://[invalid${path}`,
  ])("rejects malformed or unsafe credential link %j", (value) => {
    expect(credentialLinkUrl(value, origin)).toBe("");
  });

  it.each([
    "",
    "not-an-origin",
    "//workspace.customer.example",
    "ftp://workspace.customer.example",
    "javascript:alert(1)",
    "https://user@workspace.customer.example",
    "https://user:password@workspace.customer.example",
    "https://[invalid",
  ])("rejects an invalid browser origin %j", (value) => {
    expect(credentialLinkUrl(path, value)).toBe("");
  });
});
