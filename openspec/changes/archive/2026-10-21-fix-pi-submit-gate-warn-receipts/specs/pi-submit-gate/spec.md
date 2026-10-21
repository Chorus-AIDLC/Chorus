# Spec Delta

## Purpose

Keep Pi's local task and proposal submit receipts fresh across submit attempts, preventing delayed pre-submit results from silently authorizing a later submission.

## ADDED Requirements

### Requirement: Every targeted submit attempt invalidates its receipt

When gate evaluation is enabled, each task submission with a task UUID and each proposal submission SHALL evaluate its verdict against the pre-attempt state, then consume the applicable receipts and advance the applicable mutation sequence before returning, regardless of whether the result is a verdict or permission to proceed. No change to task submission without a UUID is required.

#### Scenario: Warned task submit rejects delayed status read
- **GIVEN** a task mutation followed by a task read that has not returned and no fresh receipt
- **WHEN** a task submit produces a verdict and proceeds in warn mode, then the earlier read returns `in_progress`
- **THEN** the delayed result SHALL NOT provide a usable receipt and another submit without a newer read SHALL produce a verdict

#### Scenario: Warned proposal submit rejects delayed validation
- **GIVEN** a proposal draft mutation followed by validation that has not returned and no fresh receipt
- **WHEN** a proposal submit produces a verdict and proceeds in warn mode, then that validation returns `valid:true`
- **THEN** the delayed validation SHALL NOT authorize another submit

#### Scenario: Stale or unacceptable receipts also trigger invalidation
- **GIVEN** a stale task/proposal receipt, a task receipt with a status other than `in_progress`, or a proposal receipt reporting `valid:false`
- **WHEN** the corresponding UUID-scoped submit is evaluated
- **THEN** the verdict SHALL reflect the pre-attempt state, the receipt SHALL be consumed, and the mutation sequence SHALL advance
- **AND** an earlier in-flight successful read/validation SHALL NOT restore a usable receipt

### Requirement: Invalidation scope follows the submit target

A UUID-scoped submit SHALL invalidate only the corresponding object's receipts and pre-attempt pending results. A proposal submit without UUID SHALL clear all proposal receipts and advance the global proposal mutation sequence even if a verdict is returned.

#### Scenario: Other object remains readable
- **GIVEN** pending reads for objects A and B of the same kind
- **WHEN** A is submitted with its UUID and both reads subsequently complete
- **THEN** A's pre-attempt read SHALL be unusable but B's read SHALL remain eligible under the existing gate checks

#### Scenario: Unknown proposal submission invalidates globally
- **GIVEN** proposal validations pending before a proposal submit without UUID
- **WHEN** that submit is evaluated with no receipt, a stale receipt, an invalid receipt, or a valid receipt
- **THEN** all proposal receipts SHALL be cleared and the global proposal mutation sequence SHALL advance
- **AND** none of those earlier validations SHALL authorize a subsequent submit

### Requirement: Existing mode behavior and fresh-read recovery are preserved

The extension SHALL continue bypassing gate evaluation in off mode, notifying without blocking in warn mode, and blocking verdict-producing submits in block mode. Invalidation SHALL be conservative for both enabled modes, independent of eventual execution success. Fresh post-attempt reads SHALL remain eligible under the existing gate conditions, and an allowed submit SHALL consume its receipt.

#### Scenario: Blocked submit conservatively invalidates
- **WHEN** an enabled gate produces a verdict and block mode stops execution
- **THEN** the local submit-attempt invalidation SHALL still take effect without rollback

#### Scenario: New read restores eligibility once
- **GIVEN** an earlier submit attempt invalidated a task or proposal receipt
- **WHEN** a new read/validation starts after that attempt and returns acceptable data without intervening mutation
- **THEN** one subsequent submit SHALL be allowed and SHALL consume that new receipt
- **AND** another submit without a fresh read SHALL produce a verdict

#### Scenario: Gate disabled
- **WHEN** the configured gate mode is off
- **THEN** the extension SHALL continue to bypass evaluation without adding submit warnings or blocks
