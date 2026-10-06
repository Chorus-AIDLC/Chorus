"""Chorus native plugin for Hermes Agent.

``register(ctx)`` is the Hermes entry point. Hooks, skills, the gateway platform
and the approval transport are wired in by later tasks; the skeleton only
records the plugin context so shared modules can be imported and tested.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def register(ctx) -> None:
    """Hermes plugin entry point (``plugin.yaml`` name: chorus)."""
    logger.debug("Chorus plugin registered (skeleton)")
