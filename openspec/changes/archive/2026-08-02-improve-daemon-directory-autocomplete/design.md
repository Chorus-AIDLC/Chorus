# Design: daemon root prefill and path-prefix autocomplete

## Context

`DirectoryBrowser` is already shared by project settings and the temporary wake
cwd picker. It currently derives hosts from online instances, starts with an
empty path, and sends `list` only after Enter or a search-button click. The
server persists and correlates `list` and `validate` requests, while the daemon
alone knows the effective `browseRoots` that bound discovery.

The root list must therefore come from the live daemon, not from startup cwd
instances, client inference, or a server-configured fallback.

## Goals and Non-Goals

### Goals

- Make the valid starting roots discoverable without weakening daemon ownership.
- Make completion responsive under fast typing and out-of-order responses.
- Keep fixed and temporary cwd flows behaviorally identical.
- Preserve bounded one-level results and fresh validation before use.
- Support keyboard, IME, and narrow mobile viewports.

### Non-Goals

- Persisting a user's last selected root.
- Returning an unbounded directory listing.
- Adding fuzzy search, file discovery, hidden paths, symlink traversal, or
  server-side browse-root configuration.
- Replacing the persisted directory-request transport.

## Architecture

### Correlated effective-root request

Extend `DirectoryOperation` and the directory request API with `roots`. A roots
request carries the same user, Agent, target connection, deadline, and report
authentication as `list` and `validate`, but no client path. The daemon returns
only its normalized effective roots in configured order.

The server does not cache or merge root lists. Switching host creates a new
request. Offline, timeout, stale-target, and internal failures use the existing
typed terminal states. This keeps the displayed roots aligned with the daemon
that will later list and validate the path.

### Shared autocomplete state machine

Keep one `DirectoryBrowser` for both callers. Its state is keyed by selected
connection:

- `loadingRoots`, `ready`, `loadingCandidates`, `validating`, or `error`
- effective roots and selected root
- editable full path and the current basename prefix
- candidate page and highlighted candidate index
- monotonically increasing query generation

Selecting a host invalidates all prior generations, clears candidates and
selection, requests roots, and initializes the path from the first root.
Changing roots performs the same invalidation without querying candidates.

Candidate requests start only when the path is inside the selected root and the
current basename has at least one character. Input changes wait 250 ms. Each
effect cleanup aborts its fetch/poll loop where supported and increments the
generation. A completion updates visible state only when connection, root,
prefix, and generation still match.

The request uses the backend's bounded default limit and does not auto-fetch
additional pages. Users narrow the prefix to refine results.

### Combobox interaction

The path input owns an ARIA combobox and controls a listbox. The first returned
candidate is highlighted by default. Arrow keys move the highlight, `Tab`
accepts the highlighted candidate, `Enter` selects it, and `Escape` closes the
list. IME composition suppresses completion commands.

Selecting a candidate writes its full path plus the platform separator and
prepares the next level. Because an empty basename does not query, the user
types the next first character before another request. A parent-directory
control clamps navigation to the selected root. Mobile users tap candidates and
the same parent control; path text wraps or scrolls without widening dialogs.

### Validation and errors

Candidate selection is not sufficient to save or run. The existing `validate`
operation remains the final gate and returns the normalized path. Loading roots,
loading candidates, empty candidates, offline, timeout, invalid, outside-root,
access-denied, stale-target, limit, and internal states remain distinguishable.
Errors from an obsolete generation are discarded rather than replacing current
results.

## API and Module Contracts

- `DirectoryOperation = "roots" | "list" | "validate"`.
- `roots` success result: `{ roots: string[] }`, in daemon effective order.
- A successful roots result MUST contain at least one normalized root; malformed
  success payloads map to `INTERNAL_ERROR`.
- `list` retains `{ items, nextCursor? }` and the existing server-side limit.
- `DirectoryBrowser` receives online instances and emits only a freshly
  validated `ValidatedDirectory`; callers do not implement root or completion
  state themselves.
- Both entry points retain their existing final action: project settings saves
  a preference, while the wake picker passes a one-operation validation UUID.

## Implementation Plan

1. Extend daemon and server request contracts with `roots`, including
   authorization, correlation, timeout, and protocol tests.
2. Refactor `DirectoryBrowser` around a cancellable query generation and
   accessible combobox state machine.
3. Update both consumers, translations, focused component tests, and browser
   coverage across desktop and mobile.

## Risks and Mitigations

- **Root disclosure expands accidentally:** return only the live daemon's
  effective allowlist through the already authorized target connection.
- **Old polling loops overwrite new input:** guard every transition by
  connection, prefix, and generation in addition to aborting work.
- **`Tab` breaks normal focus traversal:** prevent default only when a visible
  highlighted candidate is accepted; otherwise preserve native focus behavior.
- **Path separators vary by host:** treat daemon-normalized roots and candidate
  paths as opaque and derive navigation from returned paths, not local OS APIs.
- **Large roots produce noisy results:** retain the bounded server limit and
  require one basename character before listing.
