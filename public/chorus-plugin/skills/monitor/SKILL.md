---
name: monitor
description: Start real-time Chorus AIDLC event notifications via SSE. The agent invokes Claude Code's Monitor tool to run a persistent background listener.
license: AGPL-3.0
metadata:
  author: chorus
  version: "0.7.5"
  category: project-management
  mcp_server: chorus
---

# Monitor Skill

Start a persistent SSE listener that delivers real-time Chorus event notifications to the agent via Claude Code's Monitor tool.

---

## Overview

`/chorus:monitor` starts a background process that connects to the Chorus SSE endpoint and outputs AIDLC events to stdout. Claude Code's Monitor tool reads each line and delivers it as a notification to the agent, enabling event-driven workflows without polling.

**Supported events (10 AIDLC lifecycle types):**

| Event | Agent action |
|-------|-------------|
| `task_assigned` | Claim and begin work |
| `task_verified` | Check for unblocked downstream tasks |
| `task_reopened` | Rework needed |
| `proposal_approved` | Tasks ready for claiming |
| `proposal_rejected` | Revision needed |
| `idea_claimed` | Begin elaboration |
| `elaboration_requested` | Review and answer questions |
| `elaboration_answered` | Validate answers |
| `mentioned` | Respond to @mention |
| `comment_added` | Review and respond |

---

## Prerequisites

- `CHORUS_URL` and `CHORUS_API_KEY` environment variables must be set
- `jq` and `curl` must be installed
- Claude Code Monitor tool must be available

---

## Workflow

### Step 1: Verify Environment

Check that Chorus is configured:

```
if CHORUS_URL and CHORUS_API_KEY are set:
  proceed
else:
  STOP: "Cannot start monitor. Set CHORUS_URL and CHORUS_API_KEY."
```

### Step 2: Start the Monitor

Invoke the Monitor tool to run the SSE listener as a persistent background process:

```json
{
  "command": "${CLAUDE_PLUGIN_ROOT}/bin/chorus-sse-monitor.sh",
  "description": "Chorus AIDLC event notifications",
  "persistent": true
}
```

If the Monitor tool is not available (feature-flagged or unsupported), report this to the user:

```
"Monitor tool is not available in this Claude Code version. 
 Real-time notifications require the Monitor tool. 
 You can still use Chorus normally — just without auto-wakeup on events."
```

### Step 3: Confirm

After the Monitor tool returns a task ID, confirm to the user:

```
"Chorus SSE monitor started. You will receive real-time notifications for:
 task assignments, proposal approvals/rejections, @mentions, comments, 
 elaboration events, and task verification/reopen events.
 
 Use TaskStop with the returned task ID to stop the monitor."
```

### Step 4: Optional Project Filtering

If the user wants to filter events to specific projects, set the `CHORUS_PROJECT_UUIDS` environment variable before invoking Monitor:

```
CHORUS_PROJECT_UUIDS="uuid-1,uuid-2" 
```

---

## Tips

- The monitor runs persistently until the session ends or you stop it with TaskStop
- Each event outputs one line to stdout, which wakes the agent as a notification
- Events from yourself (e.g., your own comments) do not trigger notifications
- If connection drops, the script auto-reconnects with exponential backoff (1s to 30s)

---

## Next

- For task development: `/chorus:develop`
- For proposal creation: `/chorus:proposal`
- For platform overview: `/chorus`
