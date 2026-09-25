## Why

PR #575 prevents overlapping project creation, but the busy guard also prevents every exit while validation or POST is pending. A mocked POST remained pending for 120 seconds with no way to dismiss the dialog. The requester authorized completing recovery in #575, requesting Admin Claude review, and merging to develop if review and CI pass.

## What Changes

- Keep the original shared synchronous submission guard and IME handling.
- Allow cancellation of directory validation with a real AbortSignal.
- Bound the POST/response-body UI wait to 20 seconds. Timeout, transport failure, malformed response and server errors mean the outcome is unconfirmed.
- Preserve drafts and the unconfirmed guard across dismissal. Explain that the previous request may still create a project; require explicit informed confirmation before a new operation.
- Isolate each attempt from old responses and timers. Late success refreshes data without closing a reopened dialog.

## Capabilities

### Modified Capabilities
- `project-creation-submission`: distinguish cancellable validation, definitive rejection and unconfirmed creation; preserve one active user operation.

## Impact

Project creation dialog, both host pages, directory validation signal forwarding, draft persistence, all four locales, regression tests. No API or database schema changes.

The sibling project-group/Idea submission defects and server idempotency/result lookup are a separate follow-up Idea. This patch does not guarantee exactly-once creation across deliberate retries or remount/navigation.

Source: https://github.com/Chorus-AIDLC/Chorus/pull/575 and originating Chorus Idea comments.

## Aggregate review follow-up

Admin Claude review found that a dismissed late success silently unlocked the retained draft and that an unrelated AbortError could disappear without a message. Require an explicit new-operation acknowledgement after a dismissed success and only suppress errors when this attempt's signal was actually aborted. Preserve the existing late-response isolation contract.
