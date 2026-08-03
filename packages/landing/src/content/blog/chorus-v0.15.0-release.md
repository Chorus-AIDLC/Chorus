---
title: "Chorus v0.15.0: Project-level working directories for agents"
description: "When several projects and agents share the same daemons, what keeps each run on the right host and in the right repository?"
date: 2026-08-03
lang: en
postSlug: chorus-v0.15.0-release
---

# Chorus v0.15.0: Project-level working directories for agents

A development machine often holds several repositories. One agent may also work across several projects. In that setup, the directory where a daemon started is not always the directory a task should use. Picking a directory from the currently online instances, or asking for one at every dispatch, can produce different results across assignment, wake, and resume flows.

Chorus v0.15.0 adds project-level working directory settings for agents and carries the resolved location through dispatch, wake, resume, and later turns.

## Set a working directory for each agent in a project

Each user can now select a host and working directory for every agent in a project's settings. The preference is stored per user, project, and agent, so it does not overwrite another project member's setup. Claude Code, Codex, and Kiro can use different paths in the same project, and one agent can use different paths across projects.

Once configured, the directory becomes the fixed destination for new work assigned to that agent. The same preference is used when:

- creating or reassigning an Idea or Task;
- creating an Idea through a conversation;
- waking an agent through `@mention`;
- starting development or running Yolo;
- starting later workflow stages and agent sessions.

The selected host and directory are shown in the UI. When a fixed directory exists, these flows no longer ask for an online instance or a temporary path each time.

If the target host is offline, operations that require a live agent fail with a clear error. Recoverable wakes remain as notifications. Chorus does not silently move the work to another host or directory. Invalid or out-of-scope paths also return explicit validation errors.

Projects without a fixed directory keep the previous behavior. They can still select from online instances or browse to a temporary directory for one operation.

## Directory discovery stays under daemon control

Neither the browser nor the Chorus server reads an agent host's filesystem directly. The daemon exposes directory choices within its `browseRoots`. If no roots are configured, the daemon user's home directory is used by default.

Directory discovery has a narrow boundary:

- only configured roots can be accessed;
- one directory level is returned at a time;
- hidden directories, symlinks, and inaccessible paths are filtered out;
- requests outside the allowed roots are rejected;
- the path is validated again before it is saved or used.

Fixed project directories and temporary directories use the same selection and validation flow. The picker can complete path prefixes from the selected host and supports keyboard navigation with arrow keys, Tab, and Enter.

## Existing work stays in its original directory

Project settings determine where new work starts. Ideas and Tasks that already have an execution target keep their existing binding. An active daemon session continues to use its own `runtimeCwd`.

Changing a project's default directory therefore does not move an in-progress conversation to another repository on its next turn. Resume, continuation, and later turns return to the original host and directory. Only newly created work uses the updated preference.

Fixed project directories, one-off temporary paths, registered instances, and the unconfigured fallback now pass through the same target resolution logic.

## Codex integration updates

This release also includes two Codex fixes.

Chorus now stores the Codex backend thread ID separately from its internal session ID. The internal ID remains responsible for Chorus routing, while the backend ID is used by the copy action and `codex exec resume`. For older sessions without a backend ID, the copy action stays hidden instead of returning an ID that Codex cannot resume.

The Codex plugin also removes the Chorus session-management steps that were no longer required. Codex workflows can claim, execute, and submit tasks directly. Startup context refresh and structured hook error handling remain in place.

## Summary

v0.15.0 makes the agent host and working directory part of project configuration, then keeps that location consistent through assignment, wake, and session lifecycle. This reduces repeated directory selection and prevents new work or continued sessions from running in a different repository than intended.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@0.15.0
```

After release, see the complete changes on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.15.0).

Questions or feedback? Open an issue on [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or start a thread in [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.15.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.15.0)
