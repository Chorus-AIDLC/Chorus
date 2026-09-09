# Design — frontmatter metadata card

## 1. The deferred decision: why pre-parse, not `remarkPlugins`

Elaboration deferred the implementation choice to this document. Two
candidates were on the table:

**(A) `remark-frontmatter` in the Streamdown pipeline.** `StreamdownProps`
does expose `remarkPlugins` (`node_modules/streamdown/dist/index.d.ts`),
so this looked like the smaller change.

**It does not work.** Streamdown chunks its input into independently
parsed blocks via `parseMarkdownIntoBlocks`. Probing the real 2.5.0
export with the exact spec-lite header shows the frontmatter is split
across **two** blocks:

```js
parseMarkdownIntoBlocks(md)
// [
//   "---\n",
//   "date: 2026-09-08\nchange: …\nproposalUuid:\n---\n\n",
//   "# Title\n\n",
//   …
//   "---",          // ← a real thematic break, later in the doc
//   …
// ]
```

A remark plugin runs per block, so it never sees a complete
`---\n…\n---` node — the opening fence is alone in block 0. Worse, the
standalone `"---"` block from a genuine mid-document thematic break
*would* look like the start of a frontmatter fence to a per-block
parser. The approach is structurally unsound here, not merely awkward.

**(B) Pre-parse and strip before handing the string to Streamdown.**
Chosen. It is correct by construction:

- Frontmatter is only ever recognized at offset 0 of the whole string,
  which is the actual YAML frontmatter rule — so mid-document `---`
  can never be misread.
- It lands in `MarkdownContent`, the single centralized renderer, so
  "all surfaces" (the elaborated scope) is satisfied by one edit with no
  per-call-site work — and it upholds the capability's existing
  centralization requirement.
- The card is a real React component, so it uses semantic Tailwind
  tokens and works in both themes without fighting react-markdown's
  handling of `yaml` mdast nodes (react-markdown drops them silently
  unless a rehype stage converts them to elements).

## 2. No new dependency

`js-yaml` exists in `node_modules` but only as a **transitive dev**
dependency (via `eslint`), so it is not usable from `src/`. Promoting it
to a production dependency would ship a general YAML engine into the
client bundle to read a flat key/value list.

Instead: a ~40-line pure-TS line parser in `src/lib/frontmatter.ts`. It
is pure JS, so it satisfies the project's cross-platform dependency rule
trivially. The deliberate trade-off is that it handles only **flat
scalar mappings** — and *bails out* on anything else rather than
guessing.

## 3. `splitFrontmatter()` contract

```ts
export interface FrontmatterEntry { key: string; value: string }

export interface SplitFrontmatterResult {
  /** Parsed entries in source order, or null when there is no frontmatter. */
  entries: FrontmatterEntry[] | null;
  /** The markdown body to render. Identical to the input when entries is null. */
  body: string;
}

export function splitFrontmatter(source: string): SplitFrontmatterResult;
```

Recognition rules — **all** must hold, or the function returns
`{ entries: null, body: source }` (the input, unmodified):

1. The source begins exactly with `---` followed by a line ending
   (no leading blank lines, no leading whitespace before the fence).
2. A closing fence line of exactly `---` or `...` appears later.
3. Every line between the fences is one of:
   - blank,
   - a comment (`#` as the first non-space character),
   - a `key: value` pair whose key matches `/^[A-Za-z0-9_.-]+$/`.
4. At least one `key: value` pair is present (a fence pair wrapping only
   blanks/comments is not metadata).

Value handling, kept deliberately minimal:

- Trailing ` #` comments are stripped from **unquoted** values only
  (`spec: ..    # the durable folder` → `..`). A `#` inside a quoted
  value is preserved.
- Surrounding matched `"` or `'` are removed; no escape processing.
- An empty value stays an empty string (`proposalUuid:` → `""`) and the
  entry is still shown — presence of the key is itself information.
- Values are **never** coerced: dates, numbers and booleans all stay
  strings. There is no schema awareness, per the elaborated decision.

The bail-out is what makes "apply to all surfaces" safe. A comment or
chat message that opens with `---` and then prose is not a flat mapping,
so rule 3 fails and it renders exactly as it does today.

## 4. Card presentation

`<FrontmatterCard entries={…} />` renders above the body:

- A bordered, muted surface (`border-border`, `bg-muted/40`,
  `rounded-lg`) with a `<dl>` of `key` / `value` rows — a definition
  list is the correct semantics for key/value metadata, and it degrades
  to readable text for screen readers.
- Keys in `text-muted-foreground` with a monospace face (they are
  identifiers); values in `text-foreground`, `break-words` so a long
  UUID or path cannot overflow the panel.
- **Semantic tokens only**, no hardcoded hex — so light and dark are
  both correct for free, per the project theme rule. No `dark:` variant
  is needed because no fixed-palette class is used.
- An `sr-only` label from i18n (`markdown.frontmatterLabel`, added to
  both `en` and `zh`) names the region. The keys themselves are content,
  not UI strings, so they are **not** translated.
- Empty values render as an em-dash placeholder so the row does not
  collapse to an ambiguous blank.

## 5. Integration point

```tsx
const { entries, body } = useMemo(() => splitFrontmatter(children), [children]);
…
return (
  <>
    {entries && <FrontmatterCard entries={entries} />}
    <Streamdown … >{body}</Streamdown>
  </>
);
```

`children` is already the only content input, and every prop currently
forwarded to `Streamdown` is untouched — including the `key={isDark…}`
remount that drives mermaid repainting. Content without frontmatter
takes the `entries === null` path and its render stays byte-identical to
today, which is the regression guarantee for the existing surfaces.

## 6. Risks

| Risk | Mitigation |
|---|---|
| A comment/chat message starting with `---` becomes a card | Bail-out rule 3: only flat `key: value` mappings qualify; anything else renders unchanged |
| Nested YAML (lists, sub-maps) rendered wrong | Rule 3 rejects it → the block renders as today rather than being mis-flattened |
| Existing surfaces regress | `entries === null` path forwards the untouched string and all props; covered by an explicit test |
| Exported docs get two frontmatter blocks | Pre-existing behavior of `export-md.ts`, unchanged by this change; recorded as a follow-up, not fixed here |
