## 1. Authorization and enrollment

Chorus proposal: `6a038e45-9d9b-47da-812f-2484e58d257d`.
Task drafts are authoritative: T1 `3ca61657-fc40-435b-957a-e9820bde4dba`; T2 `882bd24c-8946-46bf-8cec-40dd7434d2e6`; T3 `e112e8e9-3831-47b1-b7e2-74f5f928522a`; T4 `1fe9ae1a-cff9-48b2-81a2-ed074db9ada8`; T5 `698de0d0-6317-4663-9f6a-1e438cd11647`.
Mapping: 1.1 → T1; 1.2 → T2; 2.1–2.2 → T3; 3.1 → T4; 4.1–4.2 → T5.
Materialized tasks: T1 `15d5d470-408b-4693-a9f3-c020316a2352`; T2 `cc88fecc-892b-48e9-9b61-1bbe4329bae7`; T3 `3aabe811-f4fa-43c4-a0ab-93e675e14958`; T4 `075f8aa3-d7a8-489b-af98-2c10898dc652`; T5 `c2215064-8873-476b-bce1-6a6fdbfd2d36`.

- [x] 1.1 Add incremental metadata/proof migration and transactional per-Idea assignment/enrollment transition, preserving legacy guards and Idea-scoped YOLO.
- [x] 1.2 Wire human UI/REST/create/handoff and verified MCP assignment origins, proof validation/consumption, owner consent and same-agent kickoff dedup.

## 2. Routing and gates

- [x] 2.1 Replace fixed-lead eligibility with current-orchestrator authority, action-specific gates and private recommendation fallback.
- [x] 2.2 Fence orchestrator/product turns and mutation contexts across assignment generations, recovery and client capability negotiation.

## 3. User experience and compatibility

- [x] 3.1 Preserve verified assignment backend support while keeping normal assignment in the existing modal; simplify gate UI, retain silent refresh, and update translations, MCP descriptions and all maintained skills/runtime ports.

## 4. Verification and local rollout

- [x] 4.1 Complete DB/adapter/port/browser regressions, root tests and typecheck; obtain independent aggregate review.
- [x] 4.2 Back up the local database, validate incremental migration/client compatibility, deploy the saved stack and record health and safe rollback evidence without merge or publication.
