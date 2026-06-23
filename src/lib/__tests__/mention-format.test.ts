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
