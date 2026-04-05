import test from "node:test";
import assert from "node:assert/strict";
import { parseModelMap, resolveUpstreamModel } from "../core/model-routing.mjs";

test("parseModelMap returns empty object for invalid input", () => {
  assert.deepEqual(parseModelMap(""), {});
  assert.deepEqual(parseModelMap("{"), {});
  assert.deepEqual(parseModelMap("[]"), {});
});

test("resolveUpstreamModel prefers UPSTREAM_MODEL override", () => {
  const model = resolveUpstreamModel("claude-opus-4-6", {
    UPSTREAM_MODEL: "glm-5",
    UPSTREAM_MODEL_MAP: "{\"claude-opus-4-6\":\"glm-4.5\"}",
  });

  assert.equal(model, "glm-5");
});

test("resolveUpstreamModel uses UPSTREAM_MODEL_MAP when present", () => {
  const model = resolveUpstreamModel("claude-opus-4-6", {
    UPSTREAM_MODEL: "",
    UPSTREAM_MODEL_MAP: "{\"claude-opus-4-6\":\"glm-5\"}",
  });

  assert.equal(model, "glm-5");
});

test("resolveUpstreamModel falls back to requested model", () => {
  const model = resolveUpstreamModel("glm-5", {
    UPSTREAM_MODEL: "",
    UPSTREAM_MODEL_MAP: "",
  });

  assert.equal(model, "glm-5");
});
