"""Shared pytest fixtures: a fake Hermes plugin ``ctx`` and httpx mock transports.

Tests never import Hermes. The plugin directory is put on ``sys.path`` so
``chorus_hermes`` imports as a top-level package, exactly as it is laid out
beside ``__init__.py`` in the installed plugin.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any, Callable, List

import httpx
import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
PACKAGE_DIR = PLUGIN_DIR.parent
REPO_ROOT = PACKAGE_DIR.parents[1]

if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

from chorus_hermes.config import ChorusConfig  # noqa: E402

# Obviously fake: does not match the cho_[A-Za-z0-9_-]{16,} secret pattern.
FAKE_KEY = "cho_test"
FAKE_URL = "https://chorus.test"


class FakeCtx:
    """Records every ``register_*`` call a plugin makes, like Hermes' PluginContext."""

    def __init__(self) -> None:
        self.calls: List[tuple] = []
        self.hooks: dict = {}
        self.platforms: dict = {}
        self.skills: dict = {}
        self.approval_transports: dict = {}
        self.tasks: list = []

    def register_hook(self, name: str, callback: Callable) -> None:
        self.calls.append(("hook", name))
        self.hooks.setdefault(name, []).append(callback)

    def register_platform(self, name: str, label: str, adapter_factory: Callable, check_fn: Callable,
                          **kwargs: Any) -> None:
        self.calls.append(("platform", name))
        self.platforms[name] = dict(label=label, adapter_factory=adapter_factory, check_fn=check_fn, **kwargs)

    def register_skill(self, name: str, path: Any, description: str = "") -> None:
        self.calls.append(("skill", name))
        self.skills[name] = dict(path=path, description=description)

    def register_approval_transport(self, name: str, present_fn: Callable) -> None:
        self.calls.append(("approval_transport", name))
        self.approval_transports[name] = present_fn

    def spawn_task(self, coro, *, name=None):
        self.tasks.append((name, coro))
        coro.close()


@pytest.fixture
def fake_ctx() -> FakeCtx:
    return FakeCtx()


@pytest.fixture
def cfg() -> ChorusConfig:
    return ChorusConfig(url=FAKE_URL, api_key=FAKE_KEY)


class Recorder:
    """httpx MockTransport handler that records requests and replies from a queue/callable."""

    def __init__(self, responder: Callable[[httpx.Request], httpx.Response]):
        self.requests: List[httpx.Request] = []
        self._responder = responder

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self._responder(request)

    @property
    def last_json(self) -> Any:
        return json.loads(self.requests[-1].content)


@pytest.fixture
def mock_http():
    """``mock_http(responder) -> (recorder, sync_transport, async_transport)``."""

    def _make(responder: Callable[[httpx.Request], httpx.Response]):
        rec = Recorder(responder)
        return rec, httpx.MockTransport(rec), httpx.MockTransport(rec)

    return _make


def load_plugin_module():
    """Import the plugin's ``__init__.py`` as a package, like Hermes' loader does."""
    spec = importlib.util.spec_from_file_location(
        "hermes_test_plugin_chorus", PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
