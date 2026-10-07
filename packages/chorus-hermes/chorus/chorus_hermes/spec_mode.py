"""Resolve the active Chorus spec mode for a repository.

Python port of ``plugins/chorus/hooks/resolve-spec-mode.sh`` (the Codex port's
single source of truth). Pure: reads only the environment, the filesystem and
``PATH``; no network.

Resolution: an explicit ``CHORUS_SPEC_MODE`` (``lite`` | ``openspec`` | ``off``)
wins. When it is unset (or unrecognized), OpenSpec is the default whenever it is
usable (``openspec/`` directory in the project root + ``openspec`` CLI on PATH +
not disabled) and ``lite`` is the fallback. An explicit ``openspec`` that cannot
be honored sets ``fail``: the stage skill MUST halt instead of silently falling
back.

Opt-outs: ``CHORUS_OPENSPEC_MODE=off`` (legacy, same as the shell resolver) and
``CHORUS_ENABLE_OPENSPEC=false`` (the Hermes equivalent of the Claude/Codex
``enableOpenSpec`` plugin option, ``CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC``).
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from typing import Callable, Mapping, Optional

ENV_SPEC_MODE = "CHORUS_SPEC_MODE"
ENV_OPENSPEC_MODE = "CHORUS_OPENSPEC_MODE"
ENV_ENABLE_OPENSPEC = "CHORUS_ENABLE_OPENSPEC"


@dataclass(frozen=True)
class SpecMode:
    mode: str                     # lite | openspec | off
    reason: str
    fail: str = ""                # non-empty => stage skill MUST halt
    openspec_usable: bool = False
    openspec_usable_reason: str = ""
    hint: str = ""                # install hint when OpenSpec is merely missing

    @property
    def openspec_active(self) -> bool:
        """``CHORUS_OPENSPEC_ACTIVE``: only a usable, resolved openspec."""
        return self.mode == "openspec" and not self.fail


def resolve_spec_mode(
    project_root: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    *,
    which: Callable[[str], Optional[str]] = shutil.which,
) -> SpecMode:
    env = os.environ if env is None else env
    root = project_root or os.getcwd()

    # --- Is OpenSpec usable? (needs openspec/ dir + CLI on PATH + not disabled) ---
    disabled_reason = ""
    if (env.get(ENV_ENABLE_OPENSPEC) or "true") != "true":
        disabled_reason = f"{ENV_ENABLE_OPENSPEC}=false (plugin-level opt-out)"
    elif env.get(ENV_OPENSPEC_MODE) == "off":
        disabled_reason = f"{ENV_OPENSPEC_MODE}=off (legacy opt-out)"

    usable, hint = False, ""
    openspec_dir = os.path.join(root, "openspec")
    if disabled_reason:
        usable_reason = disabled_reason
    elif not os.path.isdir(openspec_dir):
        usable_reason = f"no openspec/ directory at {openspec_dir}"
        hint = "npm i -g @fission-ai/openspec && openspec init"
    elif not which("openspec"):
        usable_reason = "openspec/ directory present but `openspec` CLI not on PATH"
        hint = "npm i -g @fission-ai/openspec"
    else:
        usable = True
        usable_reason = "openspec/ directory + openspec CLI both present"

    def make(mode: str, reason: str, fail: str = "") -> SpecMode:
        return SpecMode(mode=mode, reason=reason, fail=fail, openspec_usable=usable,
                        openspec_usable_reason=usable_reason, hint=hint)

    explicit = env.get(ENV_SPEC_MODE) or ""
    if explicit == "lite":
        return make("lite", "explicit — Chorus-native lightweight specs in .chorus/specs/<slug>/")
    if explicit == "off":
        return make("off", "explicit — free-form, no spec artifact")
    if explicit == "openspec":
        if usable:
            return make("openspec", f"explicit; {usable_reason}")
        if disabled_reason:
            return make(
                "openspec",
                f"explicit, but OpenSpec is disabled: {usable_reason}",
                f"config conflict — {ENV_SPEC_MODE}=openspec vs OpenSpec disabled ({usable_reason}); "
                f"re-enable OpenSpec or set {ENV_SPEC_MODE}=lite",
            )
        return make("openspec", f"explicit, but OpenSpec is not installed: {usable_reason}",
                    f"OpenSpec not usable ({usable_reason})")
    if explicit == "":
        if usable:
            return make("openspec", f"default — {usable_reason}; set {ENV_SPEC_MODE}=lite for "
                                    f"Chorus-native specs, =off to disable")
        return make("lite", f"default — OpenSpec not usable ({usable_reason}); using Chorus-native "
                            f"lightweight specs in .chorus/specs/<slug>/")
    # Unrecognized value: treat like unset (OpenSpec-if-usable, else lite).
    if usable:
        return make("openspec", f"{ENV_SPEC_MODE}='{explicit}' unrecognized; falling back to default "
                                f"({usable_reason})")
    return make("lite", f"{ENV_SPEC_MODE}='{explicit}' unrecognized; OpenSpec not usable, defaulting to lite")
