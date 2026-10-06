"""Packaged Chorus skills and the read-only reviewer guard.

``register(ctx)`` does two things:

1. Registers every ``skills/<name>/SKILL.md`` shipped beside this package with
   ``ctx.register_skill`` so Hermes resolves it as ``chorus:<name>`` via
   ``skill_view``.
2. Registers the reviewer guard hooks (``pre_tool_call``, ``subagent_start``,
   ``subagent_stop``) that make reviewer children read-only.

Reviewer detection
------------------
The post-tool reminders tell the parent to run a reviewer with
``delegate_task`` whose ``context`` starts with ``[chorus-reviewer:<kind>]``
(kind: proposal, task, code). Hermes' ``subagent_start`` hook only carries
``child_goal``, not ``context``. The guard therefore also watches the parent's own
``delegate_task`` call in ``pre_tool_call``. It records ``(parent session, goal)``
for every task whose goal or context carries the marker, and ``subagent_start``
marks the child whose goal matches. A marker directly in ``child_goal`` also
counts. ``subagent_stop`` clears the record.

While a session is marked, ``pre_tool_call`` allows only an explicit read
allowlist plus ``chorus_add_comment``. Everything else is blocked fail-closed,
including terminal, file writes, code execution, nested delegation and every
other Chorus tool. Unknown tools are blocked too.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"

REVIEWER_SKILLS = ("chorus-proposal-reviewer", "chorus-task-reviewer", "chorus-code-reviewer")

# Any [chorus-reviewer:<word>] marker makes a session read-only. Unknown kinds are
# still treated as reviewers because being more restrictive is the safe direction.
MARKER_RE = re.compile(r"\[chorus-reviewer:([A-Za-z0-9_-]+)\]")

# Built-in Hermes tools a reviewer may use (all read-only).
ALLOWED_BUILTIN_TOOLS = frozenset({
    "read_file", "search_files", "skill_view", "skills_list",
    "web_search", "web_extract", "session_search", "todo_list",
})
# Chorus operations a reviewer may call: reads plus the single verdict comment.
ALLOWED_CHORUS_EXACT = frozenset({"chorus_add_comment", "chorus_checkin"})
ALLOWED_CHORUS_PREFIXES = ("chorus_get_", "chorus_list_", "chorus_search")
# Per-server MCP utility tools (mcp__<server>__<op>): read-only.
ALLOWED_MCP_UTILITIES = frozenset({"list_resources", "read_resource", "list_prompts", "get_prompt"})

PENDING_TTL_SECONDS = 600.0
PENDING_MAX = 256


def find_marker(*texts: Any) -> Optional[str]:
    """Return the reviewer kind of the first ``[chorus-reviewer:<kind>]`` marker in ``texts``."""
    for text in texts:
        if isinstance(text, str):
            match = MARKER_RE.search(text)
            if match:
                return match.group(1).lower()
    return None


def base_tool_name(tool_name: str) -> Tuple[str, bool]:
    """``("chorus_get_task", True)`` for ``mcp__chorus__chorus_get_task``; bare names pass through."""
    name = tool_name or ""
    if name.startswith("mcp__"):
        parts = name.split("__", 2)
        if len(parts) == 3 and parts[2]:
            return parts[2], True
    return name, False


def is_reviewer_allowed(tool_name: str) -> bool:
    base, via_mcp = base_tool_name(tool_name)
    if base in ALLOWED_CHORUS_EXACT or base.startswith(ALLOWED_CHORUS_PREFIXES):
        return True
    if via_mcp:
        return base in ALLOWED_MCP_UTILITIES
    return base in ALLOWED_BUILTIN_TOOLS


def block_message(tool_name: str, kind: str) -> str:
    return (
        f"Blocked: Chorus {kind} reviewers are read-only, so '{tool_name}' is not allowed in this "
        "reviewer session. Allowed: read_file, search_files, skill_view, Chorus get/list/search tools, "
        "and one VERDICT comment via chorus_add_comment. Do not retry; review from the evidence bundle "
        "passed in your context and report anything you could not verify in the VERDICT comment."
    )


def _delegate_goals(args: Any) -> Iterable[Tuple[str, Optional[str]]]:
    """Yield ``(goal, kind)`` for every child a ``delegate_task`` call will start."""
    if not isinstance(args, dict):
        return
    tasks = args.get("tasks")
    if isinstance(tasks, str):  # Hermes also accepts a JSON-encoded list
        try:
            tasks = json.loads(tasks)
        except ValueError:
            tasks = None
    if isinstance(tasks, list) and tasks:
        for task in tasks:
            if isinstance(task, dict) and isinstance(task.get("goal"), str):
                yield task["goal"], find_marker(task.get("goal"), task.get("context"))
        return
    goal = args.get("goal")
    if isinstance(goal, str) and goal.strip():
        yield goal, find_marker(goal, args.get("context"))


class ReviewerGuard:
    """Tracks reviewer child sessions and blocks their write tools."""

    def __init__(self, clock=time.monotonic) -> None:
        self._lock = threading.Lock()
        self._clock = clock
        self._pending: Dict[Tuple[str, str], Tuple[str, float]] = {}
        self._reviewers: Dict[str, str] = {}

    # -- state helpers -----------------------------------------------------------------------
    def reviewer_kind(self, session_id: Any) -> Optional[str]:
        if not session_id:
            return None
        with self._lock:
            return self._reviewers.get(str(session_id))

    def _prune(self, now: float) -> None:
        expired = [k for k, (_, ts) in self._pending.items() if now - ts > PENDING_TTL_SECONDS]
        for key in expired:
            self._pending.pop(key, None)
        while len(self._pending) > PENDING_MAX:
            self._pending.pop(next(iter(self._pending)))

    # -- hooks -------------------------------------------------------------------------------
    def on_pre_tool_call(self, tool_name: str = "", args: Any = None, session_id: Any = "",
                         **_: Any) -> Optional[Dict[str, str]]:
        try:
            kind = self.reviewer_kind(session_id)
            if kind is not None:
                if is_reviewer_allowed(tool_name):
                    return None
                return {"action": "block", "message": block_message(tool_name, kind)}
            if tool_name == "delegate_task" and session_id:
                now = self._clock()
                with self._lock:
                    for goal, marker_kind in _delegate_goals(args):
                        if marker_kind:
                            self._pending[(str(session_id), goal.strip())] = (marker_kind, now)
                    self._prune(now)
        except Exception:
            logger.exception("Chorus reviewer guard: pre_tool_call failed")
            # Fail closed for a known reviewer session; fail open otherwise.
            if self.reviewer_kind(session_id) is not None:
                return {"action": "block", "message": block_message(tool_name, "reviewer")}
        return None

    def on_subagent_start(self, parent_session_id: Any = None, child_session_id: Any = None,
                          child_goal: Any = "", **_: Any) -> None:
        try:
            if not child_session_id:
                return
            goal = child_goal if isinstance(child_goal, str) else ""
            kind = find_marker(goal)
            with self._lock:
                pending = self._pending.pop((str(parent_session_id or ""), goal.strip()), None)
                if kind is None and pending is not None:
                    kind = pending[0]
                # A child of a reviewer is a reviewer too (delegation is blocked, but be safe).
                if kind is None and parent_session_id and str(parent_session_id) in self._reviewers:
                    kind = self._reviewers[str(parent_session_id)]
                if kind is not None:
                    self._reviewers[str(child_session_id)] = kind
        except Exception:
            logger.exception("Chorus reviewer guard: subagent_start failed")

    def on_subagent_stop(self, child_session_id: Any = None, **_: Any) -> None:
        try:
            if child_session_id:
                with self._lock:
                    self._reviewers.pop(str(child_session_id), None)
        except Exception:
            logger.exception("Chorus reviewer guard: subagent_stop failed")


# -- skill discovery -------------------------------------------------------------------------

def _frontmatter(text: str) -> Dict[str, Any]:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    block = text[3:end]
    try:
        import yaml  # Hermes depends on PyYAML
        data = yaml.safe_load(block)
        return data if isinstance(data, dict) else {}
    except Exception:
        data: Dict[str, Any] = {}
        for line in block.splitlines():
            if ":" in line and not line.startswith((" ", "\t")):
                key, _, value = line.partition(":")
                data[key.strip()] = value.strip().strip("'\"")
        return data


def discover_skills(root: Path = SKILLS_DIR) -> List[Tuple[str, Path, str]]:
    """``[(name, SKILL.md path, description)]`` for every packaged skill, sorted by name."""
    found = []
    if not root.is_dir():
        return found
    for skill_md in sorted(root.glob("*/SKILL.md")):
        name = skill_md.parent.name
        try:
            description = str(_frontmatter(skill_md.read_text(encoding="utf-8")).get("description") or "")
        except Exception:
            description = ""
        found.append((name, skill_md, description))
    return found


_GUARD = ReviewerGuard()


def register(ctx, *, guard: Optional[ReviewerGuard] = None, skills_root: Path = SKILLS_DIR) -> None:
    guard = guard or _GUARD
    for name, path, description in discover_skills(skills_root):
        try:
            ctx.register_skill(name, path, description=description)
        except Exception:
            logger.exception("Chorus: failed to register skill %s", name)
    ctx.register_hook("pre_tool_call", guard.on_pre_tool_call)
    ctx.register_hook("subagent_start", guard.on_subagent_start)
    ctx.register_hook("subagent_stop", guard.on_subagent_stop)
