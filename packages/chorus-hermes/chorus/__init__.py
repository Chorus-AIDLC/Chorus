"""Chorus native plugin for Hermes Agent.

``register(ctx)`` is the Hermes entry point. Each feature lives in its own
``chorus_hermes`` module exposing ``register(ctx)``; this file only wires them
in order so one failing feature never prevents the others from loading.
"""

from __future__ import annotations

import importlib
import logging

logger = logging.getLogger(__name__)

# Feature modules, in registration order. Each must expose register(ctx).
FEATURE_MODULES = (
    "hooks",        # session lifecycle: check-in context + post-tool reminders
    "skills",       # packaged Chorus skills + read-only reviewer guard
    "adapter",      # gateway platform: online scheduling
    "approval",     # approval transport routed through Chorus comments
)


def register(ctx) -> None:
    """Hermes plugin entry point (``plugin.yaml`` name: chorus)."""
    for name in FEATURE_MODULES:
        try:
            module = importlib.import_module(f"{__name__}.chorus_hermes.{name}")
        except ModuleNotFoundError as exc:
            if exc.name == f"{__name__}.chorus_hermes.{name}":
                continue  # feature not shipped in this build
            logger.exception("Chorus: failed to import feature %s", name)
            continue
        except Exception:
            logger.exception("Chorus: failed to import feature %s", name)
            continue
        try:
            module.register(ctx)
        except Exception:
            logger.exception("Chorus: feature %s failed to register", name)
