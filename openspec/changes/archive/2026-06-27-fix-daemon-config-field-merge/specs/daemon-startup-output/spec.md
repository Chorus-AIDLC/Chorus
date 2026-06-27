# daemon-startup-output Spec Delta

## MODIFIED Requirements

### Requirement: `claude` installation detection at startup

On startup the daemon SHALL detect whether the `claude` executable is installed
(reusing the existing PATH resolution, including the Windows `claude.cmd` shim and
any configured override) and SHALL report the result in the startup banner —
showing the resolved path when found, or a clear "not found" indication with
guidance when absent. When `claude` is **not** found, the daemon SHALL, in
addition to the banner row, emit exactly one prominent `⚠` warning line to
**stderr** at startup — in the visual style of the YOLO autonomy warning line —
stating that wakes will fail until `claude` is installed (or `CHORUS_CLAUDE_PATH`
is set) and that `PATH` must include the directory holding `claude` (e.g.
`~/.local/bin`). This stderr line ensures the missing binary is visible in an
unattended/systemd journal at startup rather than only when a wake later fails.
A missing `claude` SHALL NOT prevent the daemon from subscribing; the daemon SHALL
still start, with wakes also surfacing the missing-binary error visibly when one
arrives (preserving current non-fatal behavior).

#### Scenario: Installed claude is reported with its path

- **WHEN** `claude` is resolvable on PATH (or via the configured override) at
  startup
- **THEN** the banner shows that claude is installed and the resolved path, and no
  `⚠` claude-not-found warning line is emitted

#### Scenario: Missing claude is reported but does not block startup

- **WHEN** `claude` cannot be resolved at startup
- **THEN** the banner clearly indicates claude was not found with guidance, the
  daemon emits exactly one prominent `⚠` stderr warning line naming how to fix it,
  and the daemon still starts and subscribes
