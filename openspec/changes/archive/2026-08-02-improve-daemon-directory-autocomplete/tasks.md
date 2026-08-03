## 1. Effective browse-root protocol

- [ ] Extend directory operations with a correlated roots request.
- [ ] Return only the selected daemon's effective normalized roots.
- [ ] Cover authorization, offline, timeout, malformed result, and no-cache behavior.

## 2. Shared path autocomplete

- [ ] Refactor `DirectoryBrowser` to load roots and prefill the default root.
- [ ] Add 250 ms debounce, abort/generation guards, bounded candidates, and stale-result rejection.
- [ ] Implement accessible keyboard, IME, parent-navigation, and mobile behavior.

## 3. Consumer integration and verification

- [ ] Keep project fixed-cwd and temporary cwd consumers on the shared component.
- [ ] Add localized loading, empty, root, and typed-error states.
- [ ] Verify single/multiple roots, races, keyboard, mobile, validation, and both final actions.
