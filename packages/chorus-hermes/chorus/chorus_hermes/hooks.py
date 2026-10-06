"""Session lifecycle hooks (Codex parity) for the Chorus Hermes plugin.

| Codex hook | Hermes mechanism |
|---|---|
| ``SessionStart`` (startup/resume/clear/compact) | ``pre_llm_call`` returns ``{"context": block}`` |
| ``PostToolUse`` ``.*chorus_pm_submit_proposal`` / ``.*chorus_submit_for_verify`` / ``.*chorus_admin_verify_task`` | ``transform_tool_result`` appends a reminder |

Injection happens on ``is_first_turn``, on the first turn after
``on_session_reset`` and on the first turn after context compression, tracked
per ``session_id``. Compression is detected when the injected marker, once seen
in ``conversation_history``, is gone again, or when the history shrank since the
previous turn without the marker in it. A session id we have never seen with
history that lacks the marker (a resumed session, or one rotated by
compression) is injected as well — the Codex ``resume`` source.

``on_session_start`` only warms the check-in (its return value is ignored).
Every callback is wrapped: an exception logs and falls back to "no change", and
each Chorus call has a short timeout so the hooks stay well under
``plugins.hook_callback_timeout`` (default 30s).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

from . import reminders
from .config import ChorusConfig, ConfigError, load_config, terminal_cwd
from .mcp_client import ChorusMcpClient
from .spec_mode import SpecMode, resolve_spec_mode

logger = logging.getLogger(__name__)

MARKER = "[chorus-hermes:session-context]"
MAX_CONTEXT_CHARS = 5000
CHECKIN_TIMEOUT = 8.0          # seconds, per Chorus call from pre_llm_call
REMINDER_CALL_TIMEOUT = 5.0    # seconds, per Chorus call from transform_tool_result (<= 4 calls)
PREFETCH_MAX_AGE = 120.0       # a warmed check-in older than this is refetched
MAX_TRACKED_SESSIONS = 512

HOOK_NAMES = ("pre_llm_call", "on_session_start", "on_session_reset", "transform_tool_result")


@dataclass
class _SessionState:
    injected: bool = False
    marker_seen: bool = False
    last_len: int = 0
    pending_reset: bool = False


def _contains_marker(value: Any, depth: int = 0) -> bool:
    if isinstance(value, str):
        return MARKER in value
    if depth > 4:
        return False
    if isinstance(value, Mapping):
        return any(_contains_marker(v, depth + 1) for v in value.values())
    if isinstance(value, (list, tuple)):
        return any(_contains_marker(v, depth + 1) for v in value)
    return False


def history_has_marker(history: Any) -> bool:
    """True when any message (``content``, ``api_content`` sidecar, multimodal parts) carries the marker."""
    return isinstance(history, (list, tuple)) and any(_contains_marker(m) for m in history)


def _default_project_root() -> str:
    try:
        return terminal_cwd() or os.getcwd()
    except Exception:
        return os.getcwd()


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    suffix = "… (truncated)"
    return text[: max(0, limit - len(suffix))] + suffix


def build_context_block(url: str, checkin: Any, spec: SpecMode) -> str:
    """The ``## Checkin`` / ``## Spec Mode`` / ``## Quick Reference`` block, capped at 5000 chars."""
    head = (
        f"# Chorus Plugin — Active (Hermes port) {MARKER}\n\n"
        f"Chorus is connected at {url}. MCP tools are available under the `chorus` server "
        "(`mcp__chorus__chorus_*`).\n\n## Checkin\n\n"
    )
    tail = f"\n\n## Spec Mode\n\nCHORUS_SPEC_MODE={spec.mode} ({spec.reason})"
    if spec.mode == "lite":
        tail += (
            "\n\nRouting: lite → follow the spec-lite skill (`skill_view(\"chorus:spec-lite\")`). A capability's "
            "durable spec is `.chorus/specs/<slug>/spec.md` (edited in place, never synced); each change is a dated "
            "folder `.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` of Chorus-typed docs (`prd.md` required) "
            "mirrored 1:1 into Chorus Documents via `chorus mcp call … --arg-file content=<file>`. Put a "
            "`Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` line in the proposal description. Do NOT "
            "scaffold `openspec/changes/` or add an `OpenSpec change slug:` line."
        )
    elif spec.mode == "off":
        tail += (
            "\n\nRouting: off → free-form, no spec artifact. Do NOT create `.chorus/specs/` or `openspec/changes/` "
            "files; author document drafts inline via direct MCP."
        )
    elif spec.fail:
        tail += (
            f"\n\nRouting: openspec → **cannot be honored** — {spec.fail}. The proposal / yolo skill MUST halt after "
            "resolving the mode; do NOT silently fall back to lite/free-form. Surface this to the user."
        )
        if spec.hint:
            tail += f" Install hint: {spec.hint}."
    else:
        tail += (
            f"\n\nCHORUS_OPENSPEC_ACTIVE=1 ({spec.openspec_usable_reason})\n\n"
            "Routing: openspec → load the openspec-aware skill (`skill_view(\"chorus:openspec-aware\")`) and follow "
            "its OpenSpec authoring section — do NOT re-run its detection block, the answer is already known.\n\n"
            "Critical rule: document mirror calls (`chorus_pm_add_document_draft` / `chorus_pm_update_document_draft` "
            "/ `chorus_pm_update_document`) MUST fill `content` from the local file — `chorus mcp call <tool> "
            "'<json>' --arg-file content=<file>`. Do NOT invoke these MCP tools directly with hand-typed `content` "
            "in OpenSpec mode."
        )
    tail += (
        "\n\n## Quick Reference\n\n"
        "- **Long-horizon work**: follow AI-DLC via the Chorus skill (idea → proposal → task → verify) rather than "
        "coding ad hoc, and use chorus_search to locate the work the user refers to.\n"
        "- **Notifications**: `chorus_get_notifications()` fetches and auto-marks read.\n"
        "- **Skills**: Chorus skills are not listed in <available_skills>; load one with "
        "`skill_view(\"chorus:<name>\")` — e.g. `chorus:chorus`, `chorus:idea`, `chorus:proposal`, "
        "`chorus:develop`, `chorus:review`, `chorus:quick-dev`, `chorus:yolo`.\n"
        "- **Reviewer sub-agents**: after `chorus_pm_submit_proposal` / `chorus_submit_for_verify` the plugin "
        "reminds you to run the reviewer via `delegate_task` with `[chorus-reviewer:<kind>]` on the first line of "
        "`context` (kind: proposal | task | code) and the child told to `skill_view(\"chorus:chorus-<kind>-reviewer\")`. "
        "Reviewers are read-only (no terminal): pass evidence files (diff, test output) in `context`."
    )
    if isinstance(checkin, str):
        checkin_text = checkin
    else:
        checkin_text = json.dumps(checkin, ensure_ascii=False)
    budget = MAX_CONTEXT_CHARS - len(head) - len(tail)
    block = head + _clip(checkin_text, max(budget, 0)) + tail
    return _clip(block, MAX_CONTEXT_CHARS)


def not_configured_notice() -> str:
    return (f"{MARKER} Chorus plugin: not configured (set CHORUS_URL and CHORUS_API_KEY to enable "
            "Chorus integration).")


def checkin_failed_notice(url: str) -> str:
    return (f"{MARKER} WARNING: Chorus check-in failed — unable to reach Chorus at {url}. MCP tools may still "
            "work if Chorus becomes reachable during the session.")


def _parse_tool_result(result: str) -> tuple[Any, Any]:
    """``(outer, inner)``: Hermes' JSON envelope and the decoded Chorus payload (either may be ``None``)."""
    try:
        outer = json.loads(result)
    except (TypeError, ValueError):
        return None, None
    inner = None
    if isinstance(outer, Mapping):
        inner = outer.get("structuredContent")
        body = outer.get("result")
        if isinstance(body, str):
            try:
                inner = json.loads(body)
            except ValueError:
                pass
        elif isinstance(body, Mapping) and inner is None:
            inner = body
    return outer, inner


def tool_succeeded(result: Any, status: Optional[str]) -> bool:
    if not isinstance(result, str) or status == "error":
        return False
    outer, _ = _parse_tool_result(result)
    return not (isinstance(outer, Mapping) and outer.get("error"))


def _extract_uuid(result: str, args: Any, keys: tuple) -> Optional[str]:
    _, inner = _parse_tool_result(result)
    if isinstance(inner, Mapping):
        for key in keys:
            value = inner.get(key)
            if isinstance(value, str) and value:
                return value
    if isinstance(args, Mapping):
        value = args.get(keys[0])
        if isinstance(value, str) and value:
            return value
    return None


class ChorusHooks:
    """Stateful hook callbacks; one instance per plugin load."""

    def __init__(
        self,
        *,
        env: Optional[Mapping[str, str]] = None,
        client_factory: Optional[Callable[[ChorusConfig, float], Any]] = None,
        project_root: Optional[Callable[[], str]] = None,
        resolve_spec: Callable[..., SpecMode] = resolve_spec_mode,
        verify_reminders: Callable[..., str] = reminders.verify_task_reminders,
        executor: Optional[Any] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._env = env
        self._client_factory = client_factory or (lambda cfg, timeout: ChorusMcpClient(cfg, timeout=timeout))
        self._project_root = project_root or _default_project_root
        self._resolve_spec = resolve_spec
        self._verify_reminders = verify_reminders
        self._executor = executor
        self._clock = clock
        self._lock = threading.Lock()
        self._sessions: "OrderedDict[str, _SessionState]" = OrderedDict()
        self._prefetch: dict = {}

    # ------------------------------------------------------------------ helpers

    def _config(self) -> ChorusConfig:
        return load_config(os.environ if self._env is None else self._env)

    def _spec_env(self) -> Mapping[str, str]:
        return os.environ if self._env is None else self._env

    def _fetch_checkin(self, cfg: ChorusConfig) -> Any:
        return self._client_factory(cfg, CHECKIN_TIMEOUT).call_tool("chorus_checkin", {})

    def _get_executor(self):
        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="chorus-checkin")
        return self._executor

    def _state(self, session_id: str) -> Optional[_SessionState]:
        return self._sessions.get(session_id)

    def _put_state(self, session_id: str, state: _SessionState) -> None:
        self._sessions[session_id] = state
        self._sessions.move_to_end(session_id)
        while len(self._sessions) > MAX_TRACKED_SESSIONS:
            self._sessions.popitem(last=False)

    def _take_prefetched(self, session_id: str) -> Optional[Future]:
        with self._lock:
            entry = self._prefetch.pop(session_id, None)
            # Drop stale entries for sessions that never reached a turn.
            now = self._clock()
            for sid in [s for s, (ts, _) in self._prefetch.items() if now - ts > PREFETCH_MAX_AGE]:
                self._prefetch.pop(sid, None)
        if entry is None:
            return None
        ts, fut = entry
        return fut if self._clock() - ts <= PREFETCH_MAX_AGE else None

    def build_context(self, session_id: str) -> str:
        try:
            cfg = self._config()
        except ConfigError:
            return not_configured_notice()
        try:
            fut = self._take_prefetched(session_id)
            checkin = fut.result(timeout=CHECKIN_TIMEOUT) if fut is not None else self._fetch_checkin(cfg)
        except Exception as exc:
            logger.warning("Chorus: check-in failed: %s", type(exc).__name__)
            return checkin_failed_notice(cfg.url)
        try:
            spec = self._resolve_spec(self._project_root(), self._spec_env())
        except Exception:
            logger.exception("Chorus: spec-mode resolution failed")
            spec = SpecMode(mode="lite", reason="spec-mode resolution failed; defaulting to lite")
        return build_context_block(cfg.url, checkin, spec)

    def _injection_reason(self, session_id: str, history: list, is_first_turn: bool) -> Optional[str]:
        present = history_has_marker(history)
        with self._lock:
            state = self._state(session_id)
            if is_first_turn:
                reason: Optional[str] = "startup"
            elif state is None:
                reason = None if present else "resume"
            elif state.pending_reset:
                reason = "clear"
            elif not present and (state.marker_seen or len(history) < state.last_len):
                reason = "compact"
            else:
                reason = None
            if state is None or reason == "startup":
                state = _SessionState()
            if reason is not None:
                state.injected = True
                state.marker_seen = False  # the fresh injection is only visible from the next turn on
            else:
                state.marker_seen = state.marker_seen or present
            state.pending_reset = False
            state.last_len = len(history)
            self._put_state(session_id, state)
        return reason

    # ------------------------------------------------------------------ hooks

    def on_session_start(self, session_id: str = "", **_: Any) -> None:
        """Warm the check-in for this session in the background (return value is ignored by Hermes)."""
        try:
            if not session_id:
                return None
            try:
                cfg = self._config()
            except ConfigError:
                return None
            fut = self._get_executor().submit(self._fetch_checkin, cfg)
            with self._lock:
                self._prefetch[session_id] = (self._clock(), fut)
        except Exception:
            logger.exception("Chorus: on_session_start failed")
        return None

    def on_session_reset(self, session_id: Any = None, old_session_id: Any = None,
                         new_session_id: Any = None, **_: Any) -> None:
        try:
            with self._lock:
                if old_session_id and old_session_id not in (session_id, new_session_id):
                    self._sessions.pop(old_session_id, None)
                for sid in {session_id, new_session_id}:
                    if sid:
                        state = self._sessions.get(sid) or _SessionState()
                        state.pending_reset = True
                        self._put_state(sid, state)
        except Exception:
            logger.exception("Chorus: on_session_reset failed")
        return None

    def pre_llm_call(self, session_id: str = "", conversation_history: Any = None,
                     is_first_turn: bool = False, **_: Any) -> Optional[dict]:
        try:
            history = list(conversation_history or [])
            reason = self._injection_reason(session_id or "", history, bool(is_first_turn))
            if reason is None:
                return None
            block = self.build_context(session_id or "")
            return {"context": _clip(block, MAX_CONTEXT_CHARS)}
        except Exception:
            logger.exception("Chorus: pre_llm_call failed")
            return None

    def transform_tool_result(self, tool_name: str = "", args: Any = None, result: Any = None,
                              status: Optional[str] = None, **_: Any) -> Optional[str]:
        try:
            op = reminders.match_operation(tool_name)
            if op is None or not tool_succeeded(result, status):
                return None
            if op == reminders.PROPOSAL_OP:
                text = reminders.proposal_submitted(
                    _extract_uuid(result, args, ("proposalUuid", "uuid")))
            elif op == reminders.SUBMIT_VERIFY_OP:
                text = reminders.task_submitted(_extract_uuid(result, args, ("taskUuid", "uuid")))
            else:
                text = self._verify_text(_extract_uuid(result, args, ("taskUuid", "uuid")))
            if not text:
                return None
            return f"{result}\n\n{text}"
        except Exception:
            logger.exception("Chorus: transform_tool_result failed")
            return None

    def _verify_text(self, task_uuid: Optional[str]) -> str:
        if not task_uuid:
            return ""
        try:
            cfg = self._config()
        except ConfigError:
            return ""
        client = self._client_factory(cfg, REMINDER_CALL_TIMEOUT)
        return self._verify_reminders(
            task_uuid, lambda name, arguments: client.call_tool(name, arguments),
            project_root=self._project_root(), env=self._spec_env())


def register(ctx) -> None:
    hooks = ChorusHooks()
    ctx.register_hook("pre_llm_call", hooks.pre_llm_call)
    ctx.register_hook("on_session_start", hooks.on_session_start)
    ctx.register_hook("on_session_reset", hooks.on_session_reset)
    ctx.register_hook("transform_tool_result", hooks.transform_tool_result)
