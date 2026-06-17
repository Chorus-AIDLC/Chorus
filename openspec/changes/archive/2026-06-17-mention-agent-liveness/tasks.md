# Tasks: Agent liveness in the @-mention dropdown

> Chorus task drafts are the source of truth; this mirrors them for the change record.

## 1. Agent liveness in the @-mention surface (service + MCP + dropdown UI)
- [ ] `Mentionable` gains optional `online` + `activeCount`; batched enrichment helper wired into BOTH branches of `searchMentionables` (empty-query + search)
- [ ] `online` reuses connection registry `effectiveStatus` + `STALE_THRESHOLD_MS` (one batched connection query, companyUuid-scoped)
- [ ] `activeCount` = running/queued `DaemonExecution` per agent (one batched aggregate); coherent with online (offline ⇒ 0)
- [ ] `chorus_search_mentionables` description + `docs/MCP_TOOLS.md` document the two agent fields
- [ ] `mention-editor.tsx`: agent rows show static dot (online, Online/Offline tooltip) + count badge (>0 only); roles line removed; user rows unchanged; en+zh localized; `docs/design.pen` updated
- [ ] Service unit tests (Prisma mocked) + dropdown render test; `tsc` clean; full suite green
