# daemon-permission-mode Spec Delta

## REMOVED Requirements

### Requirement: Credential change clears the YOLO acknowledgement

**Reason:** Superseded by the daemon.json field-level merge decision (elaboration q1 = preserve always). All writes to `~/.chorus/daemon.json` are now field-level merges that preserve every pre-existing field, including `yoloAckAt`. A config write — including `chorus login` — must never silently discard the user's recorded YOLO acknowledgement, which was the data-loss footgun this change fixes. Consequently re-login no longer clears the ack and no longer forces a one-time re-confirmation. The remaining permission-mode requirements (default YOLO, TTY first-run confirmation + persisted ack, non-TTY warn-and-run, `--chorus-only`) are unchanged and continue to bound YOLO exposure.

**Migration:** none. Existing `daemon.json` files that already carry `yoloAckAt` simply retain it across the next `chorus login`. Files without an ack behave as before (a TTY yolo start still prompts once and persists the ack).
