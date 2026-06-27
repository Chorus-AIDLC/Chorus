import { describe, it, expect } from "vitest";
import {
  encodePinSuffix,
  decodePinSuffix,
  buildMentionMarker,
} from "../mention-format";

const UUID = "abcdef12-3456-7890-abcd-ef1234567890";

describe("encodePinSuffix", () => {
  it("returns '' when nothing is pinned (un-pinned mention is unchanged)", () => {
    expect(encodePinSuffix(null, null)).toBe("");
    expect(encodePinSuffix(undefined, undefined)).toBe("");
  });

  it("encodes host + cwd as a ?cwd=…&host=… query suffix", () => {
    expect(encodePinSuffix("Laptop-Q3", "/home/u/dev/chorus")).toBe(
      "?cwd=%2Fhome%2Fu%2Fdev%2Fchorus&host=Laptop-Q3",
    );
  });

  it("writes an empty cwd value for a null-cwd pin (unknown-path instance)", () => {
    // host pinned but cwd unknown → cwd present-but-empty so the decoder can
    // distinguish "pinned to unknown path" from "not pinned".
    expect(encodePinSuffix("ci-runner", null)).toBe("?cwd=&host=ci-runner");
  });

  it("preserves an empty-string host ('' = unknown-host instance)", () => {
    expect(encodePinSuffix("", "/srv/app")).toBe("?cwd=%2Fsrv%2Fapp&host=");
  });

  it("escapes parens so the payload never breaks the closing-paren match", () => {
    const suffix = encodePinSuffix("h(1)", "/a(b)/c");
    expect(suffix).not.toContain("(");
    expect(suffix).not.toContain(")");
    // And it round-trips back to the originals.
    expect(decodePinSuffix(suffix.slice(1))).toEqual({
      pinnedHost: "h(1)",
      pinnedCwd: "/a(b)/c",
    });
  });
});

describe("decodePinSuffix", () => {
  it("returns both null for an absent/empty suffix (un-pinned)", () => {
    expect(decodePinSuffix(undefined)).toEqual({ pinnedHost: null, pinnedCwd: null });
    expect(decodePinSuffix("")).toEqual({ pinnedHost: null, pinnedCwd: null });
    expect(decodePinSuffix(null)).toEqual({ pinnedHost: null, pinnedCwd: null });
  });

  it("decodes a host + cwd pin", () => {
    expect(decodePinSuffix("cwd=%2Fhome%2Fu%2Fdev%2Fchorus&host=Laptop-Q3")).toEqual({
      pinnedHost: "Laptop-Q3",
      pinnedCwd: "/home/u/dev/chorus",
    });
  });

  it("maps an empty cwd value to a null cwd (unknown-path pin)", () => {
    expect(decodePinSuffix("cwd=&host=ci-runner")).toEqual({
      pinnedHost: "ci-runner",
      pinnedCwd: null,
    });
  });

  it("maps an empty host value to '' (unknown-host pin)", () => {
    expect(decodePinSuffix("cwd=%2Fsrv%2Fapp&host=")).toEqual({
      pinnedHost: "",
      pinnedCwd: "/srv/app",
    });
  });

  it("treats a host-absent suffix as host=null", () => {
    expect(decodePinSuffix("cwd=%2Fsrv%2Fapp")).toEqual({
      pinnedHost: null,
      pinnedCwd: "/srv/app",
    });
  });
});

describe("buildMentionMarker", () => {
  it("produces the legacy bare form when un-pinned (byte-identical)", () => {
    expect(buildMentionMarker("DevBot", "agent", UUID)).toBe(
      `@[DevBot](agent:${UUID})`,
    );
    expect(buildMentionMarker("DevBot", "agent", UUID, null, null)).toBe(
      `@[DevBot](agent:${UUID})`,
    );
  });

  it("appends the pin suffix when pinned", () => {
    expect(
      buildMentionMarker("DevBot", "agent", UUID, "Laptop-Q3", "/home/u/dev/chorus"),
    ).toBe(`@[DevBot](agent:${UUID}?cwd=%2Fhome%2Fu%2Fdev%2Fchorus&host=Laptop-Q3)`);
  });

  it("round-trips a pinned marker through encode→decode", () => {
    const marker = buildMentionMarker("DevBot", "agent", UUID, "h", "/p");
    // Extract the suffix between the uuid and the closing paren.
    const suffix = marker.slice(marker.indexOf("?") + 1, marker.length - 1);
    expect(decodePinSuffix(suffix)).toEqual({ pinnedHost: "h", pinnedCwd: "/p" });
  });
});

// ===== Codec byte-stability (cwd-addressable mentions T-final lock-in) =====
//
// The cwd-addressable-instances feature interprets the `?cwd=…&host=…` suffix as
// "the AgentInstance for this agent at (host, cwd)" — but it CHANGES NOTHING about
// the wire format or the codec (spec: "without changing the wire format"; existing
// stored comment tokens require no migration). These tests pin the exact bytes the
// codec emits and prove `decode ∘ encode` is the identity over the (host, cwd)
// domain (incl. both sentinels and paren-bearing payloads), so any future drift in
// encodePinSuffix/decodePinSuffix is caught — the durable instance handle stays
// (host, cwd), the SAME tuple daemon-connection.service.resolveInstanceByTuple keys
// on, never a connectionUuid.
describe("pin codec byte-stability (wire format unchanged)", () => {
  // The complete (host, cwd) domain the registry / resolver must round-trip:
  // a normal place, the unknown-host ("") and unknown-path (null) sentinels, and a
  // paren-bearing payload (which must never break the closing-paren regex match).
  const CASES: Array<{ host: string | null; cwd: string | null }> = [
    { host: "prod", cwd: "/work" },
    { host: "Laptop-Q3", cwd: "/home/u/dev/chorus" },
    { host: "ci-runner", cwd: null }, // unknown-path pin
    { host: "", cwd: "/srv/app" }, // unknown-host pin ("" sentinel)
    { host: "h(1)", cwd: "/a(b)/c" }, // parens must be escaped away
    { host: "host with spaces", cwd: "/path with spaces/x" },
    { host: "h&q=x", cwd: "/p?a=b&c=d" }, // reserved chars must survive
  ];

  it.each(CASES)(
    "decode(encode($host,$cwd)) is the identity and the suffix is paren-free",
    ({ host, cwd }) => {
      const suffix = encodePinSuffix(host, cwd);
      // Suffix begins with `?` and contains no bare paren (so the markup regex's
      // "up to the closing paren" match can never be broken by the payload).
      expect(suffix.startsWith("?")).toBe(true);
      expect(suffix).not.toContain("(");
      expect(suffix).not.toContain(")");
      // Round-trip: decode the text after the leading `?`.
      expect(decodePinSuffix(suffix.slice(1))).toEqual({
        pinnedHost: host,
        pinnedCwd: cwd,
      });
    },
  );

  it("emits the exact documented bytes for the spec's pinned-mention example", () => {
    // Spec scenario token: @[Name](agent:uuid?cwd=/work&host=prod). The codec's
    // suffix bytes are frozen here — a change to this string is a wire-format
    // change and would require migrating stored comment tokens (forbidden).
    expect(encodePinSuffix("prod", "/work")).toBe("?cwd=%2Fwork&host=prod");
    expect(buildMentionMarker("Name", "agent", UUID, "prod", "/work")).toBe(
      `@[Name](agent:${UUID}?cwd=%2Fwork&host=prod)`,
    );
  });

  it("an un-pinned marker is byte-identical to the legacy bare form (no migration)", () => {
    // Both the explicit-null and the omitted-arg paths must serialize with NO
    // suffix, so every previously-stored bare token still parses unchanged.
    expect(encodePinSuffix(null, null)).toBe("");
    expect(buildMentionMarker("Name", "agent", UUID)).toBe(`@[Name](agent:${UUID})`);
    expect(buildMentionMarker("Name", "agent", UUID, null, null)).toBe(
      `@[Name](agent:${UUID})`,
    );
  });
});
