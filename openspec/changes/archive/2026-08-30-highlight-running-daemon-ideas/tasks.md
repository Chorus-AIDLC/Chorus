## 1. Session Activity Realtime State

- [ ] 1.1 Emit only `session_started` and `session_ended` from the existing turn transition chokepoint, carrying session, activity token, direct Idea, agent, and origin connection without schema changes.
- [ ] 1.2 Forward company-scoped live activity to user subscribers, keep agent keys self-only, and replay currently running activities on SSE connect/reconnect through the same event shape.
- [ ] 1.3 Derive subscriber-relative `canOpen` from existing ownership, then add the frontend reducer and Idea grouping with overlapping-activity handling, stable ordering, connection-detail joins, owned navigation through the existing agent+CWD locator, and status-only treatment for other users.
- [ ] 1.4 Cover transition edges, bootstrap/live races, reconnect convergence, company/agent-key visibility fencing, owned versus other-user authorization, reducer behavior, and agent/CWD navigation with automated tests.

## 2. Tracker and Graph Indicators

- [ ] 2.1 Add the shared DOM active-session disclosure/count/chooser and integrate it into flat and lineage Tracker Idea rows.
- [ ] 2.2 Feed the same active-session map into graph Idea nodes, paint the compact running treatment, and add hover plus dedicated hit-region behavior.
- [ ] 2.3 Preserve Tracker row navigation, graph expand/card-body actions, lifecycle badges, and generic presence visuals.
- [ ] 2.4 Add English/Chinese copy and zero/one/many/final-end tests for both surfaces, including no resource-graph refetch.
