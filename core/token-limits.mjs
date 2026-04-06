function parsePositiveInteger(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export const DEFAULT_UPSTREAM_MAX_TOKENS = 8192;
export const UPSTREAM_MAX_TOKENS = parsePositiveInteger(
  process.env.UPSTREAM_MAX_TOKENS,
  DEFAULT_UPSTREAM_MAX_TOKENS,
);

export function clampMaxTokens(requestedMaxTokens) {
  const requested = parsePositiveInteger(requestedMaxTokens, null);
  if (requested === null) {
    return {
      requested: null,
      upstream: null,
      clamped: false,
    };
  }

  const upstream = Math.min(requested, UPSTREAM_MAX_TOKENS);
  return {
    requested,
    upstream,
    clamped: upstream !== requested,
  };
}

export function parseContextLimitRetry(errorPayload, requestedMaxTokens) {
  const message = errorPayload?.error?.message;
  if (typeof message !== "string") {
    return null;
  }

  const match = message.match(
    /You passed\s+(\d+)\s+input tokens and requested\s+(\d+)\s+output tokens\.[\s\S]*?context length is only\s+(\d+)/i,
  );
  if (!match) {
    return null;
  }

  const inputTokens = parsePositiveInteger(match[1], null);
  const requestedOutputTokens = parsePositiveInteger(match[2], null);
  const contextLength = parsePositiveInteger(match[3], null);
  const requested = parsePositiveInteger(requestedMaxTokens, requestedOutputTokens);

  if (inputTokens === null || requestedOutputTokens === null || contextLength === null || requested === null) {
    return null;
  }

  const retryMaxTokens = contextLength - inputTokens;
  if (retryMaxTokens <= 0 || retryMaxTokens >= requested) {
    return null;
  }

  return {
    input_tokens: inputTokens,
    requested_output_tokens: requestedOutputTokens,
    context_length: contextLength,
    retry_max_tokens: retryMaxTokens,
  };
}
