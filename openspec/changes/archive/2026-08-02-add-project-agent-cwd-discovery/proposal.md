## Why

Chorus can currently route work only to working directories already registered as live daemon connections. Users with several repositories on one host must preconfigure every cwd at daemon startup and repeatedly choose an instance in project workflows. This prevents project settings from establishing a durable per-Agent cwd and cannot discover an unregistered directory safely.

## What Changes

- Add a daemon-local `browseRoots` allowlist and a bounded, prefix-based directory discovery protocol addressed to an online Agent instance.
- Add a user-scoped project-Agent cwd preference that can pin one cwd for each Agent in a project or leave the Agent in temporary-selection mode.
- Extend project settings with Agent working-directory controls that select a host first, browse allowed directories, explicitly save or clear a fixed cwd, and show invalid/offline states.
- Make a fixed project-Agent cwd sticky across project workflows and Agent instances until cleared; when no fixed cwd exists, existing temporary cwd selection remains available.
- Let workflows without a fixed cwd expand the temporary picker to browse an allowed unregistered directory for that operation without persisting a project preference.
- Route work to a discovered cwd through the selected daemon host without requiring that directory to have been registered as a startup `cwd`.
- Return stable typed errors for offline hosts, timeouts, invalid or out-of-root paths, inaccessible directories, and stale selections.

## Capabilities

### New Capabilities

- `daemon-directory-discovery`: Host-controlled browse roots, remote prefix completion, request/response transport, normalization, limits, and typed failures.
- `project-agent-cwd`: User × project × Agent fixed cwd persistence, resolution priority, project-settings workflow, and wake routing to discovered paths.

### Modified Capabilities

- `daemon-cwd-instance-addressing`: Permit a selected online daemon host to execute a wake in an allowed discovered cwd even when no startup connection was registered for that path.
- `daemon-background-lifecycle`: Configure and persist daemon browse roots independently from served startup cwds.

## Impact

The change affects daemon CLI configuration, reverse control transport, daemon filesystem access, connection and wake-target services, Prisma data, project settings, assignment/stage-advance cwd selection, localization, and focused unit/integration/browser tests. Existing projects and daemons retain current behavior when no project-Agent cwd has been fixed.
