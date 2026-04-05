function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: undefined };
  }
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneWithArguments(toolCall, nextArguments) {
  const nextFunction = { ...(toolCall.function || {}) };
  if (nextArguments === null) {
    delete nextFunction.arguments;
  } else {
    nextFunction.arguments = nextArguments;
  }

  if (Object.keys(nextFunction).length === 0) {
    const { function: _ignored, ...rest } = toolCall;
    return rest;
  }

  return { ...toolCall, function: nextFunction };
}

export class ToolCallArgumentRepair {
  constructor() {
    this.argumentState = new Map();
  }

  repairDelta(choiceIndex, toolCall) {
    const toolIndex = toolCall?.index ?? 0;
    const key = `${choiceIndex}:${toolIndex}`;
    const incoming = toolCall?.function?.arguments;

    if (typeof incoming !== "string") {
      return toolCall;
    }

    const existing = this.argumentState.get(key) ?? "";
    if (incoming === "") {
      return toolCall;
    }

    if (existing === "") {
      this.argumentState.set(key, incoming);
      return toolCall;
    }

    const standalone = tryParseJson(incoming);
    if (!standalone.ok) {
      this.argumentState.set(key, existing + incoming);
      return toolCall;
    }

    for (let start = incoming.length; start >= 0; start -= 1) {
      const suffix = incoming.slice(start);
      const candidate = existing + suffix;
      const parsedCandidate = tryParseJson(candidate);
      if (!parsedCandidate.ok) {
        continue;
      }

      if (!sameJsonValue(parsedCandidate.value, standalone.value)) {
        continue;
      }

      this.argumentState.set(key, candidate);
      if (suffix === incoming) {
        return toolCall;
      }
      if (suffix === "") {
        return cloneWithArguments(toolCall, null);
      }
      return cloneWithArguments(toolCall, suffix);
    }

    const parsedExisting = tryParseJson(existing);
    if (parsedExisting.ok && sameJsonValue(parsedExisting.value, standalone.value)) {
      return cloneWithArguments(toolCall, null);
    }

    this.argumentState.set(key, existing + incoming);
    return toolCall;
  }

  repairChunk(payload) {
    if (!payload || !Array.isArray(payload.choices)) {
      return payload;
    }

    let changed = false;
    const nextChoices = payload.choices.map((choice, choiceIndex) => {
      const toolCalls = choice?.delta?.tool_calls;
      if (!Array.isArray(toolCalls)) {
        return choice;
      }

      const nextToolCalls = toolCalls.map((toolCall) => {
        const repaired = this.repairDelta(choiceIndex, toolCall);
        if (repaired !== toolCall) {
          changed = true;
        }
        return repaired;
      });

      if (!changed) {
        return choice;
      }

      return {
        ...choice,
        delta: {
          ...choice.delta,
          tool_calls: nextToolCalls,
        },
      };
    });

    if (!changed) {
      return payload;
    }

    return {
      ...payload,
      choices: nextChoices,
    };
  }
}
