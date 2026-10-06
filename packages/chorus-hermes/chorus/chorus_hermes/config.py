"""Configuration for the Chorus Hermes plugin.

Credentials come only from the environment (``CHORUS_URL``, ``CHORUS_API_KEY``);
nothing is ever written to disk by this module. The working directory the
gateway reports to Chorus is ``realpath(terminal.cwd)`` from the Hermes config.
Placeholder values (``.``, ``auto``, ``cwd``) and an unset key mean "unknown":
the caller must refuse to connect rather than silently report ``$HOME``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

ENV_URL = "CHORUS_URL"
ENV_API_KEY = "CHORUS_API_KEY"
ENV_ALLOWED_USERS = "CHORUS_ALLOWED_USERS"

# Mirrors gateway/cwd_placeholder.py CWD_PLACEHOLDERS at Hermes 2b52acc2d.
CWD_PLACEHOLDERS = frozenset({".", "auto", "cwd"})


class ConfigError(ValueError):
    """Raised when required Chorus configuration is missing or invalid."""


@dataclass(frozen=True)
class ChorusConfig:
    url: str
    api_key: str = field(repr=False)
    allowed_users: tuple[str, ...] = ()

    @property
    def mcp_url(self) -> str:
        return f"{self.url}/api/mcp"

    def __repr__(self) -> str:  # never leak the key into logs
        return f"ChorusConfig(url={self.url!r}, api_key=<redacted>, allowed_users={self.allowed_users!r})"


def _clean(value: Optional[str]) -> str:
    return (value or "").strip()


def normalize_url(url: str) -> str:
    url = _clean(url).rstrip("/")
    if url.endswith("/api/mcp"):
        url = url[: -len("/api/mcp")]
    if not url.startswith(("http://", "https://")):
        raise ConfigError(f"{ENV_URL} must be an absolute http(s) URL")
    return url


def is_configured(env: Optional[Mapping[str, str]] = None) -> bool:
    env = os.environ if env is None else env
    return bool(_clean(env.get(ENV_URL)) and _clean(env.get(ENV_API_KEY)))


def load_config(env: Optional[Mapping[str, str]] = None) -> ChorusConfig:
    """Build a :class:`ChorusConfig` from the environment, or raise :class:`ConfigError`."""
    env = os.environ if env is None else env
    url, key = _clean(env.get(ENV_URL)), _clean(env.get(ENV_API_KEY))
    missing = [name for name, value in ((ENV_URL, url), (ENV_API_KEY, key)) if not value]
    if missing:
        raise ConfigError("missing environment variable(s): " + ", ".join(missing))
    allowed = tuple(u.strip() for u in _clean(env.get(ENV_ALLOWED_USERS)).split(",") if u.strip())
    return ChorusConfig(url=normalize_url(url), api_key=key, allowed_users=allowed)


def hermes_home(env: Optional[Mapping[str, str]] = None) -> Path:
    env = os.environ if env is None else env
    home = _clean(env.get("HERMES_HOME"))
    return Path(home).expanduser() if home else Path.home() / ".hermes"


def load_hermes_config(env: Optional[Mapping[str, str]] = None) -> Mapping[str, Any]:
    """Read the active profile's Hermes config.

    Prefers Hermes' own read-only loader (merges managed config); falls back to
    parsing ``$HERMES_HOME/config.yaml`` so the module works outside Hermes too.
    """
    try:
        from hermes_cli.config import load_config_readonly  # type: ignore[import-not-found]
    except Exception:
        load_config_readonly = None
    if load_config_readonly is not None:
        try:
            return load_config_readonly() or {}
        except Exception:
            pass
    path = hermes_home(env) / "config.yaml"
    try:
        import yaml

        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, Mapping) else {}


def terminal_cwd(
    hermes_config: Optional[Mapping[str, Any]] = None,
    *,
    loader: Callable[[], Mapping[str, Any]] = load_hermes_config,
) -> Optional[str]:
    """``realpath(terminal.cwd)`` or ``None`` when unset / a placeholder / not a directory."""
    cfg = loader() if hermes_config is None else hermes_config
    terminal = cfg.get("terminal") if isinstance(cfg, Mapping) else None
    raw = terminal.get("cwd") if isinstance(terminal, Mapping) else None
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw or raw in CWD_PLACEHOLDERS:
        return None
    resolved = os.path.realpath(os.path.expanduser(raw))
    return resolved if os.path.isdir(resolved) else None
