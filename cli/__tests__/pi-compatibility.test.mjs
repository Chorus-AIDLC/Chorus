import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PI_SUPPORTED_RANGE, PI_MIN_SUPPORTED_VERSION, PI_MAX_SUPPORTED_MAJOR,
  PI_NATIVE_MCP_MIN_VERSION, PI_LEGACY_ADAPTER_SPEC,
} from "../init/pi-compatibility.mjs";

test("Pi package and installer share the verified host and adapter policy", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../packages/chorus-pi/package.json", import.meta.url)));
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], PI_SUPPORTED_RANGE);
  assert.deepEqual(PI_MIN_SUPPORTED_VERSION, [0, 84, 4]);
  assert.equal(PI_MAX_SUPPORTED_MAJOR, 2);
  assert.deepEqual(PI_NATIVE_MCP_MIN_VERSION, [0, 99, 0]);
  assert.equal(PI_LEGACY_ADAPTER_SPEC, "npm:pi-mcp-adapter@5.0.0");
});
