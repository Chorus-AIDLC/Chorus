# Tasks

- [ ] Replace backend connection ordering with a deterministic comparator.
  - [ ] Update `sortConnectionViews` in `src/services/daemon-connection.service.ts` to rank effective status first, then agent name, agent uuid, cwd, host, client type, and connection uuid.
  - [ ] Keep timestamp fields projected but remove them as primary sort keys.
  - [ ] Add unit tests proving shuffled equivalent inputs produce identical output order and heartbeat-only timestamp changes do not move rows.

- [ ] Add frontend defensive ordering for agent/cwd presence groups.
  - [ ] Add or extract a pure sorting helper near `src/components/agent-presence/instance-group.tsx`.
  - [ ] Apply the helper before grouping/rendering in the presence popover and full connections modal paths.
  - [ ] Cover multi-agent, duplicate-name, multi-cwd, and null-cwd cases in component/unit tests.

- [ ] Add local E2E refresh-stability coverage.
  - [ ] Follow the project's existing local daemon/Claude-style E2E pattern.
  - [ ] Drive repeated refreshes with equivalent connection sets in different raw orders.
  - [ ] Assert visible agent rows and cwd sub-rows keep the same DOM order.

- [ ] Run verification.
  - [ ] Run the targeted service/component tests.
  - [ ] Run the new local E2E test.
  - [ ] Run the relevant full test command used by this repo for frontend/service changes.
