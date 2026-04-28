import { describe, it, expect } from "vitest";
import { parseHost } from "@/lib/oidc-utils";

describe("parseHost", () => {
  it("returns the hostname of a normal https URL", () => {
    expect(parseHost("https://auth.acme.com")).toBe("auth.acme.com");
  });

  it("returns host (host + port) for URLs with explicit ports", () => {
    expect(parseHost("https://auth.acme.com:8080/realm")).toBe(
      "auth.acme.com:8080"
    );
  });

  it("returns the hostname of an http URL", () => {
    expect(parseHost("http://localhost:3000")).toBe("localhost:3000");
  });

  it("returns the original string when input is not a parseable URL", () => {
    expect(parseHost("not-a-valid-url")).toBe("not-a-valid-url");
  });

  it("returns the original string for empty input", () => {
    expect(parseHost("")).toBe("");
  });
});
