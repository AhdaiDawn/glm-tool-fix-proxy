export function parseModelMap(text) {
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

export function resolveUpstreamModel(requestedModel, env = process.env) {
  const forcedModel = env.UPSTREAM_MODEL || "";
  if (forcedModel) {
    return forcedModel;
  }

  const modelMap = parseModelMap(env.UPSTREAM_MODEL_MAP || "");
  if (requestedModel && typeof modelMap[requestedModel] === "string" && modelMap[requestedModel] !== "") {
    return modelMap[requestedModel];
  }

  return requestedModel;
}
