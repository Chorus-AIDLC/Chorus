"""Package-level checks: layout, version sync, no secrets, register() contract."""

import json
import re

import yaml

from tests.conftest import PACKAGE_DIR, REPO_ROOT, load_plugin_module

SECRET_RE = re.compile(r"cho_[A-Za-z0-9_-]{16,}")
SHA_RE = re.compile(r"\b[0-9a-f]{40}\b")


def _root_version() -> str:
    return json.loads((REPO_ROOT / "package.json").read_text())["version"]


def _versions():
    plugin_yaml = yaml.safe_load((PACKAGE_DIR / "chorus" / "plugin.yaml").read_text())
    plugin_json = json.loads((PACKAGE_DIR / "chorus-mcp" / "plugin.json").read_text())
    return plugin_yaml["version"], plugin_json["version"]


def check_versions(root: str, yaml_version: str, json_version: str) -> list:
    return [name for name, v in (("chorus/plugin.yaml", yaml_version), ("chorus-mcp/plugin.json", json_version))
            if str(v) != root]


def test_versions_match_root_package_json():
    y, j = _versions()
    assert check_versions(_root_version(), y, j) == []


def test_version_check_detects_drift():
    assert check_versions("9.9.9", "9.9.9", "1.0.0") == ["chorus-mcp/plugin.json"]
    assert check_versions("9.9.9", "1.0.0", "9.9.9") == ["chorus/plugin.yaml"]


def test_manifest_shape():
    y = yaml.safe_load((PACKAGE_DIR / "chorus" / "plugin.yaml").read_text())
    assert y["name"] == "chorus"
    assert y["kind"] in {"standalone", "backend", "exclusive", "platform", "model-provider"}
    j = json.loads((PACKAGE_DIR / "chorus-mcp" / "plugin.json").read_text())
    assert j["$schema"] == "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    assert j["name"] == "chorus-mcp"


def test_mcp_declared_only_in_portable_package():
    assert not (PACKAGE_DIR / "chorus" / "mcp.json").exists()
    assert not list((PACKAGE_DIR / "chorus-mcp").glob("**/*.py"))
    mcp = json.loads((PACKAGE_DIR / "chorus-mcp" / "mcp.json").read_text())
    assert mcp["$schema"] == "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
    server = mcp["mcpServers"]["chorus"]
    assert server["type"] == "streamable-http"
    assert server["url"].endswith("/api/mcp")
    assert server["headers"] == {"Authorization": "Bearer ${CHORUS_API_KEY}"}


def _package_files():
    for path in PACKAGE_DIR.rglob("*"):
        if path.is_file() and "__pycache__" not in path.parts and ".pytest_cache" not in path.parts:
            yield path


def test_no_secrets_in_package():
    hits = [str(p) for p in _package_files() if SECRET_RE.search(p.read_text(errors="ignore"))]
    assert hits == []


def test_no_commit_sha_committed():
    hits = [str(p) for p in _package_files() if p.suffix in {".yaml", ".json", ".py"}
            and SHA_RE.search(p.read_text(errors="ignore"))]
    assert hits == []


def test_register_runs_against_fake_ctx(fake_ctx):
    module = load_plugin_module()
    assert callable(module.register)
    module.register(fake_ctx)
