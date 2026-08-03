// Pure, dependency-free mention-markup codec — shared by the SERVER mention
// service (parse/create) and the CLIENT mention editor (serialize/parse), so the
// producer and the parser of the on-disk markup can never drift.
//
// Markup: `@[DisplayName](type:uuid)` with an OPTIONAL pinned-instance suffix
// `?cwd=…&host=…` INSIDE the parens (cwd-addressable instances, T3). An
// un-pinned mention is byte-identical to before this change. This module is
// importable from client components (it pulls in NO prisma / server code).

/**
 * Encode a pinned (host, cwd) into the mention markup's query-string suffix:
 * `?cwd=<enc>&host=<enc>`. Returns "" (no suffix) when nothing is pinned, so an
 * un-pinned mention serializes byte-identically to before this change.
 *
 * Values are percent-encoded AND have `(`/`)` additionally escaped (which
 * encodeURIComponent leaves intact) so the payload is paren-free — the markup
 * regex matches the suffix as "everything up to the closing paren". cwd is
 * always written (even null, as an empty value) when ANY pin is present so the
 * decoder can distinguish "pinned to unknown path" from "not pinned".
 */
export function encodePinSuffix(
  pinnedHost: string | null | undefined,
  pinnedCwd: string | null | undefined,
  runtimeCwd = false,
): string {
  // No pin at all → no suffix (un-pinned mention is unchanged).
  if (
    (pinnedHost === null || pinnedHost === undefined) &&
    (pinnedCwd === null || pinnedCwd === undefined)
  ) {
    return "";
  }
  const enc = (v: string) =>
    encodeURIComponent(v).replace(/\(/g, "%28").replace(/\)/g, "%29");
  const parts: string[] = [];
  // cwd present-but-null → empty value (distinct from "absent" by the decoder).
  parts.push(`cwd=${pinnedCwd == null ? "" : enc(pinnedCwd)}`);
  if (pinnedHost != null) parts.push(`host=${enc(pinnedHost)}`);
  if (runtimeCwd) parts.push("runtime=1");
  return `?${parts.join("&")}`;
}

/**
 * Decode a pin query-string suffix (the text after `?`, without the `?`) into
 * (pinnedHost, pinnedCwd). Returns both null when the suffix is absent/empty
 * (un-pinned). A present `cwd=` with an empty value decodes to null (pinned to
 * an unknown-path instance); a present `host=` with an empty value decodes to
 * "" (the unknown-host sentinel).
 */
export function decodePinSuffix(suffix: string | undefined | null): {
  pinnedHost: string | null;
  pinnedCwd: string | null;
  runtimeCwd?: true;
} {
  if (!suffix) return { pinnedHost: null, pinnedCwd: null };
  const params = new URLSearchParams(suffix);
  const hasCwd = params.has("cwd");
  const hasHost = params.has("host");
  if (!hasCwd && !hasHost) return { pinnedHost: null, pinnedCwd: null };
  const rawCwd = params.get("cwd") ?? "";
  const rawHost = params.get("host");
  const decoded: {
    pinnedHost: string | null;
    pinnedCwd: string | null;
    runtimeCwd?: true;
  } = {
    // Empty cwd value → unknown-path pin (null). Otherwise the decoded path.
    pinnedCwd: hasCwd && rawCwd !== "" ? rawCwd : null,
    // host present (even empty) → the host pin ("" = unknown-host). Absent → null.
    pinnedHost: hasHost ? rawHost ?? "" : null,
  };
  if (params.get("runtime") === "1") decoded.runtimeCwd = true;
  return decoded;
}

/**
 * Build a full mention marker, optionally pinned. `@[Name](type:uuid)` when
 * un-pinned (unchanged), `@[Name](type:uuid?cwd=…&host=…)` when pinned. Shared
 * by the editor's serializer and the service so producer and parser can't drift.
 */
export function buildMentionMarker(
  displayName: string,
  type: "user" | "agent",
  uuid: string,
  pinnedHost?: string | null,
  pinnedCwd?: string | null,
  runtimeCwd = false,
): string {
  return `@[${displayName}](${type}:${uuid}${encodePinSuffix(pinnedHost, pinnedCwd, runtimeCwd)})`;
}
