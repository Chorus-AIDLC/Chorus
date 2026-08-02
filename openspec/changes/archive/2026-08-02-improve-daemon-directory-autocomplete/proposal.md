# Improve daemon directory autocomplete

## Why

The shipped daemon directory picker requires users to guess an allowed absolute
root, type a prefix, and explicitly submit each browse request. This exposes the
backend capability but makes both project cwd configuration and temporary cwd
selection slow and error-prone. The UI also has no race policy for overlapping
requests, so converting the current button flow directly to input-driven
requests would allow stale results and request storms.

## What Changes

- Add an authorized, correlated directory request operation that returns the
  selected daemon's currently effective `browseRoots`.
- Prefill the only root automatically; for multiple roots, select the first
  daemon-provided root by default and expose an explicit root selector.
- Replace manual browse submission with bounded path-prefix autocomplete after
  the first basename character.
- Debounce input by 250 ms, cancel client work where possible, correlate each
  request with its prefix, and ignore every stale response.
- Provide standard combobox keyboard behavior, including an initially
  highlighted first result and `Tab` acceptance, plus mobile-safe selection and
  navigation to the parent directory.
- Reuse one directory browser component and state contract in project fixed-cwd
  settings and one-operation temporary cwd selection.
- Preserve the daemon's existing normalization, containment, omission, result
  limit, typed error, and fresh validation guarantees.

## Capabilities

### Modified Capabilities

- `daemon-directory-discovery`: expose effective roots through the existing
  correlated control path and define bounded, race-safe prefix-completion
  consumption.
- `project-agent-cwd`: use the same root-aware autocomplete interaction in the
  fixed and temporary cwd entry points.

## Impact

The change affects the daemon directory control command, directory-request API
and service types, the shared `DirectoryBrowser`, project settings, the
temporary wake cwd picker, localization, and focused service/component/browser
tests. It does not change `browseRoots` ownership, create startup connections,
expand filesystem visibility, or alter runtime-cwd routing.
