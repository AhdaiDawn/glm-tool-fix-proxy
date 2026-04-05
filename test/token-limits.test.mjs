import test from "node:test";
import assert from "node:assert/strict";
import { clampMaxTokens, parseContextLimitRetry } from "../core/token-limits.mjs";

test("clampMaxTokens leaves small values unchanged", () => {
  assert.deepEqual(clampMaxTokens(2048), {
    requested: 2048,
    upstream: 2048,
    clamped: false,
  });
});

test("clampMaxTokens reduces large values to the upstream cap", async () => {
  const original = process.env.UPSTREAM_MAX_TOKENS;
  process.env.UPSTREAM_MAX_TOKENS = "8192";
  const { clampMaxTokens: dynamicClampMaxTokens } = await import(`../core/token-limits.mjs?cap=8192`);

  assert.deepEqual(dynamicClampMaxTokens(64000), {
    requested: 64000,
    upstream: 8192,
    clamped: true,
  });

  process.env.UPSTREAM_MAX_TOKENS = original;
});

test("clampMaxTokens ignores missing values", () => {
  assert.deepEqual(clampMaxTokens(undefined), {
    requested: null,
    upstream: null,
    clamped: false,
  });
});

test("parseContextLimitRetry derives the retry max tokens from upstream error text", () => {
  const retry = parseContextLimitRetry(
    {
      error: {
        message:
          "You passed 67073 input tokens and requested 64000 output tokens. However, the model's context length is only 131072 tokens, resulting in a maximum input length of 67072 tokens.",
      },
    },
    64000,
  );

  assert.deepEqual(retry, {
    input_tokens: 67073,
    requested_output_tokens: 64000,
    context_length: 131072,
    retry_max_tokens: 63999,
  });
});
