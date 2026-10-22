---
title: "Chorus v0.23.0: Bring the Team In. Keep the Work Straight."
description: "The server is running. How do coworkers join, and who changed that task? Working with agents shouldn't mean tracking every account, notification, and handoff by hand."
date: 2026-10-22
lang: en
postSlug: chorus-v0.23.0-release
---

# Chorus v0.23.0: Bring the Team In. Keep the Work Straight.

One host, a few agents, and Chorus is running. Then a coworker needs access. The questions shift from starting the service to creating accounts, setting passwords, and revoking access when someone leaves. Without a central identity provider, those jobs still need a home.

Once work starts, smaller problems surface. An activity entry names the wrong actor. Editing a description notifies people who were already mentioned. A proposal lists all the work, but one task depends on a draft that no longer exists.

Chorus v0.23.0 adds workspace-local account management and tightens up identity records, notifications, and submission checks for people and agents working together.

## Give everyone their own account

v0.22.2 added a local self-hosting path. v0.23.0 takes the next step: managing local users within a workspace without connecting an OIDC provider.

A super admin can create a local-auth workspace and set up its first workspace admin. Workspace admins can then invite members, generate password-reset links, and disable or remove accounts. Members set their own passwords through invitation links. No administrator needs to choose a password and pass it along.

Account management is separate from project access. A workspace account does not grant access to every private project. Projects and project groups keep their own access rules.

Revoking access also does more than change a label in a user list. Account-management changes invalidate old sessions and credential links, and existing event streams recheck access. Chorus also prevents removal of the last active workspace admin, so the workspace is not left without someone who can manage it.

## Make people recognizable and actions traceable

In settings, users can choose a display name and generate a Personas avatar, previewing it before saving. Both choices survive page reloads and future logins. Once a display name is customized, login-time name syncing no longer overwrites it.

Previewing an avatar does not change the saved one. Try a few, save one, or cancel to return to the current avatar.

Names and avatars help identify people. Activity records need to answer a different question: who took this action? This release fixes actor attribution for task status changes, preserving the user or agent that performed the operation and displaying Admin identities correctly.

Task-description `@mention` notifications are quieter, too. Editing a description notifies only newly mentioned recipients. Adding one name no longer sends another notification to everyone already in the text.

## A complete proposal can still contain impossible work

A proposal can have a detailed explanation and a full task list without having a workable execution order. Task A waits for B, while B waits for A. Or A depends on a draft that was deleted.

Proposal validation now checks for missing dependencies, self-dependencies, and dependency cycles. These are errors that block submission until they are fixed.

Task drafts can also declare their purpose: implementation, verification, documentation, or other work. That makes it possible to ask a separate question: does this proposal include anyone doing the implementation?

The check does not guess from task titles or reject older proposals for missing metadata. If no draft declares a kind, it reports that implementation coverage cannot be checked. If kinds are declared but none is implementation, it warns the author to confirm whether an existing task covers that work. Both are advisory, not submission-blocking errors.

## Read the current state before submitting

An agent finishes the code, reports progress, and submits the task for verification. That sequence sounds straightforward. But if the progress report already moves the task to `to_verify`, the subsequent submission fails because the task is no longer in the required state.

This release aligns the workflow skills across hosts: progress reports should not move the task to verification ahead of the submission step. Let submission make that transition.

Pi also gains an optional pre-submit check. Set `CHORUS_SUBMIT_GATE=warn` for reminders, or `CHORUS_SUBMIT_GATE=block` to stop submissions that lack a fresh task read or a valid proposal-validation result. It is off by default, leaving existing behavior unchanged.

This is a call-order check, not a replacement for server-side validation. Read the specific task's current state before submitting it. If a proposal draft changes after validation, validate again rather than relying on the previous result.

## Share login limits across instances

When a deployment grows beyond one instance, process-local login counters stop describing the whole picture. Requests routed to different instances hit different counters.

v0.23.0 shares authentication rate-limit counters through Redis when configured. If Redis is unavailable or stops responding, requests fall back to per-instance in-memory limits with a warning rather than waiting indefinitely. Timed-out commands are not replayed after reconnection, avoiding duplicate counts for the same attempt.

Deployments without Redis continue to use in-memory limits. That works for a single instance but does not provide one shared allowance across multiple instances.

---

All seven plugins and four npm release packages move to **0.23.0**. TRAE continues to share the Codex plugin package.

Inviting coworkers, identifying who acted, checking a proposal, and submitting a result are routine parts of collaboration. This release makes those steps require less manual checking. Once the service is running, people can join under their own identities, the record can show who did what, and agents can check the current state before handing work over.
