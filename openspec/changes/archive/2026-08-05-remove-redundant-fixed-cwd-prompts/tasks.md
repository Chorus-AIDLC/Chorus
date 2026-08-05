## 1. Proposal Header Cleanup

- [ ] 1.1 Remove the `FixedCwdAnchor` import, `fixedTarget` destructuring, and card render from `ProposalActions` only.

## 2. Verification

- [ ] 2.1 Verify all other `FixedCwdAnchor` call sites and cwd controls remain unchanged.
- [ ] 2.2 Run focused tests, type checks, UI lint, and browser acceptance for the Proposal header.
