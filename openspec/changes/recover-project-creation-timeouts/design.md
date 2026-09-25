## Context

The original fix acquires a synchronous guard before validation and holds it through POST and 600 ms success feedback. That excludes duplicate click/Enter events, but a hung request traps the dialog indefinitely. A cancelled client request cannot roll back a server-side project creation.

## Decisions

Use one current attempt object from validation start. Its identity, AbortController, phase, dismissal flag and timer distinguish old continuations from the current operation. React state presents the phase; the ref excludes same-tick submissions.

During validation, Cancel, Escape and outside dismissal abort the actual directory request/poll, invalidate the attempt and preserve drafts. Both the validation adapter and dialog recheck cancellation after awaiting. Existing no-argument validation callers remain compatible. Directory drafts are retained in the dialog parent because Radix unmounts content on dismissal.

Once POST starts, block dismissal for at most 20 seconds including response-body reading. Do not abort POST at this UI deadline: continue listening for a definitive result. Timeout, transport/parse failures, malformed responses and 5xx leave the outcome unconfirmed. Only a recognized API 4xx rejection or a valid success resolves it.

Unconfirmed state allows dismissal but disables submission, including after close/reopen. The message explicitly says the old request may still create a project even when absent from the list. The action “I've checked the list and still want to create again” releases the guard for an informed new operation; it does not submit automatically or establish that the earlier operation failed.

Old continuations never release the current attempt, overwrite its errors or close its dialog. A late success can refresh data while the component is mounted. The two host `onCreated` callbacks are refresh-only; closure is owned by the current dialog operation. Once an attempt was dismissed it cannot regain closure ownership by reopening.

Keep 600 ms success feedback and clear drafts only on successful completion in the original, undismissed dialog. Preserve original trimmed payload snapshots, project group and cwd references, and IME guard.

## Risks and Limits

- No server idempotency: an explicitly confirmed new operation can still duplicate an old pending POST.
- The unknown latch lasts for this mounted dialog, including open/close; full navigation/reload does not persist it.
- The UI timer improves exit behavior, not server completion semantics.
- A server rejection is recognized conservatively by its 4xx status and known pre-creation/transaction-rejection error code. Unknown responses require user confirmation.

## Verification

Deterministic component tests cover all submission gestures, actual Radix dismissal, cancelled/late validation, request and body deadlines, unknown close/reopen, informed restart, stale results/timers, payload and IME, and unmount. Directory adapter tests cover actual signal forwarding and no stale mutation. Both themes receive browser verification using intercepted POSTs without creating duplicate real projects.

Pencil remains waived by the requester in Idea comment 0683e158-87ed-47a4-ad27-ab4aefecc4a9. Final independent task review and Admin Claude aggregate review plus green CI precede the authorized develop merge.
