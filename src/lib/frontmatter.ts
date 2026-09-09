/**
 * Leading YAML frontmatter splitter for the Markdown rendering pipeline.
 *
 * Deliberately a pure-TS line parser rather than a YAML engine: the only
 * shape we support is a flat scalar mapping, and anything else bails out
 * (returning the input untouched) instead of guessing. Adding a general YAML
 * parser to the client bundle for a flat key/value read is not worth it, and
 * `js-yaml` is only a transitive dev dependency here so it is not usable
 * from `src/` anyway.
 */

export interface FrontmatterEntry {
  key: string;
  value: string;
}

export interface SplitFrontmatterResult {
  /** Parsed entries in source order, or null when there is no frontmatter. */
  entries: FrontmatterEntry[] | null;
  /** The markdown body to render. Identical to the input when entries is null. */
  body: string;
}

const KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * A plain scalar cannot start with these YAML indicators. A flow mapping /
 * sequence (`{`, `[`) or a block scalar (`|`, `>`) is not a flat scalar value,
 * and an anchor / alias (`&`, `*`) is not either — bail rather than store the
 * raw text as if it were the value.
 */
const NON_SCALAR_VALUE_START = new Set(["{", "[", "|", ">", "&", "*"]);

/**
 * Splits a leading YAML frontmatter block off `source`.
 *
 * Recognition rules — all must hold, or `{ entries: null, body: source }` is
 * returned with `body` strictly identical to the input:
 *
 * 1. The source begins exactly with a `---` fence line (no leading blank
 *    lines, no whitespace before the fence).
 * 2. A closing fence line of exactly `---` or `...` appears later.
 * 3. Every line between the fences is blank, a `#` comment, or a
 *    `key: value` pair whose key matches `[A-Za-z0-9_.-]+`.
 * 4. At least one `key: value` pair is present.
 *
 * Values are opaque strings: no type coercion, no schema awareness. An empty
 * value stays `""` and its entry is still produced, because the presence of
 * the key is itself information.
 */
export function splitFrontmatter(source: string): SplitFrontmatterResult {
  const unchanged: SplitFrontmatterResult = { entries: null, body: source };

  // Rule 1 — the opening fence must be the very first thing in the content.
  if (!source.startsWith("---")) return unchanged;

  let cursor = 0;
  /** Reads one line, consuming its terminator; returns null at end of input. */
  const readLine = (): string | null => {
    if (cursor >= source.length) return null;
    const newline = source.indexOf("\n", cursor);
    const text = source.slice(cursor, newline === -1 ? source.length : newline);
    cursor = newline === -1 ? source.length : newline + 1;
    return text.endsWith("\r") ? text.slice(0, -1) : text;
  };

  if (readLine() !== "---") return unchanged;

  const entries: FrontmatterEntry[] = [];
  let bodyStart = -1;

  for (;;) {
    const line = readLine();
    // Rule 2 — end of input without a closing fence (e.g. a still-streaming
    // message): not frontmatter yet, render as body.
    if (line === null) return unchanged;

    if (line === "---" || line === "...") {
      bodyStart = cursor;
      break;
    }

    // Rule 3 — blanks and comments are allowed but carry no entry.
    if (line.trim() === "") continue;
    if (line.trimStart().startsWith("#")) continue;

    const colon = line.indexOf(":");
    if (colon <= 0) return unchanged;

    const key = line.slice(0, colon);
    // Leading whitespace fails this pattern, so indented lines (nested
    // mappings, list items) bail out instead of being flattened.
    if (!KEY_PATTERN.test(key)) return unchanged;

    const rawValue = line.slice(colon + 1);
    // YAML requires a space after the colon of a mapping key; without one the
    // line is a plain scalar (`https://example.com`), not a pair.
    if (rawValue !== "" && !/^[ \t]/.test(rawValue)) return unchanged;

    const value = normalizeValue(rawValue);
    if (value !== "" && NON_SCALAR_VALUE_START.has(value[0])) return unchanged;

    entries.push({ key, value });
  }

  // Rule 4 — a fence pair wrapping only blanks/comments is not metadata.
  if (entries.length === 0) return unchanged;

  return { entries, body: source.slice(bodyStart) };
}

function normalizeValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const close = trimmed.indexOf(quote, 1);
    // Matched pair: take what is inside verbatim (no escape processing) and
    // drop anything after the closing quote, so a `#` inside quotes survives.
    if (close > 0) return trimmed.slice(1, close);
  }

  // Unquoted: a whitespace-introduced `#` starts a trailing comment. A `#`
  // with no whitespace before it (e.g. `#fff`) is part of the value.
  return trimmed.replace(/[ \t]+#.*$/, "").trimEnd();
}
