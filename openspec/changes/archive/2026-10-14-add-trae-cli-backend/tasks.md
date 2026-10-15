# Tasks

Chorus task drafts are the source of truth; this list mirrors them.

- [x] 1. Codex-family profile + TRAE App Server spawner, session/usage maps, agent-cli-config
- [x] 2. Register `trae` agent type across CLI and server
- [x] 3. `chorus agents add` TRAE adapter (plugin reuse + keyless MCP + env/restart verification)
- [x] 4. TRAE hook compatibility (first shipped as a dispatcher + TRAE copies; superseded by item 8)
- [x] 5. Public docs, landing, install guide UI and i18n (`docs/design.pen` waived by requester)
- [x] 6. Live end-to-end verification on real traecli
- [x] 7. Fix `--chorus-only` refusing Chorus MCP calls on Codex and TRAE (design D8)
- [x] 8. Unify Codex/TRAE hooks into shared scripts (drop dispatcher and copies) and fix shared hook bugs (design D6)
