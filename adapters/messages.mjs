import { randomUUID } from "node:crypto";
import { ToolCallArgumentRepair } from "../core/repair.mjs";
import { formatSseEvent, parseSseBlock } from "../core/sse.mjs";

function makeId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function arrayify(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function parseArguments(text) {
  if (typeof text !== "string" || text === "") {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function formatToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item?.type === "text") {
          return item.text || "";
        }
        return JSON.stringify(item);
      })
      .join("");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

function normalizeAnthropicContent(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content) ? content : [];
}

function normalizeAnthropicSystem(system) {
  if (typeof system === "string") {
    return system;
  }
  return arrayify(system)
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function validateAnthropicContent(message) {
  const content = normalizeAnthropicContent(message?.content);
  const role = message?.role;

  for (const block of content) {
    if (block?.type === "text") {
      continue;
    }
    if (role === "user" && block?.type === "tool_result") {
      continue;
    }
    if (role === "assistant" && block?.type === "tool_use") {
      continue;
    }
    return `Unsupported anthropic ${role || "unknown"} content type: ${block?.type || "unknown"}. Upstream only supports text and tool calls.`;
  }

  return null;
}

export function validateAnthropicRequest(body) {
  for (const message of arrayify(body?.messages)) {
    if (message?.role !== "user" && message?.role !== "assistant") {
      return `Unsupported anthropic role: ${message?.role || "unknown"}.`;
    }

    const contentError = validateAnthropicContent(message);
    if (contentError) {
      return contentError;
    }
  }

  return null;
}

export function anthropicToChatRequest(body) {
  const messages = [];
  const systemText = normalizeAnthropicSystem(body.system);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }

  for (const message of arrayify(body.messages)) {
    const role = message?.role;
    const content = normalizeAnthropicContent(message?.content);

    if (role === "user") {
      let textBuffer = "";

      for (const block of content) {
        if (block?.type === "text") {
          textBuffer += block.text || "";
          continue;
        }

        if (block?.type === "tool_result") {
          if (textBuffer) {
            messages.push({ role: "user", content: textBuffer });
            textBuffer = "";
          }

          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id || block.id || makeId("call"),
            content: formatToolResultContent(block.content),
          });
        }
      }

      if (textBuffer || content.length === 0) {
        messages.push({ role: "user", content: textBuffer });
      }
      continue;
    }

    if (role === "assistant") {
      const textParts = [];
      const toolCalls = [];

      for (const block of content) {
        if (block?.type === "text") {
          textParts.push(block.text || "");
          continue;
        }

        if (block?.type === "tool_use") {
          toolCalls.push({
            id: block.id || makeId("call"),
            type: "function",
            function: {
              name: block.name || "",
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }

      if (textParts.length > 0 || toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: textParts.join(""),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    }
  }

  const tools = arrayify(body.tools).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  }));

  let toolChoice;
  if (body.tool_choice?.type === "any") {
    toolChoice = "required";
  } else if (body.tool_choice?.type === "tool") {
    toolChoice = {
      type: "function",
      function: { name: body.tool_choice.name },
    };
  } else if (body.tool_choice?.type === "auto") {
    toolChoice = "auto";
  }

  return {
    model: body.model,
    messages,
    stream: body.stream === true,
    ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

function mapStopReason(finishReason) {
  if (finishReason === "tool_calls") {
    return "tool_use";
  }
  if (finishReason === "length") {
    return "max_tokens";
  }
  return "end_turn";
}

export function chatToAnthropicMessage(chatResponse, fallbackModel) {
  const choice = chatResponse?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (typeof message.content === "string" && message.content !== "") {
    content.push({ type: "text", text: message.content });
  }

  for (const toolCall of arrayify(message.tool_calls)) {
    content.push({
      type: "tool_use",
      id: toolCall.id || makeId("toolu"),
      name: toolCall.function?.name || "",
      input: parseArguments(toolCall.function?.arguments),
    });
  }

  return {
    id: makeId("msg"),
    type: "message",
    role: "assistant",
    model: chatResponse.model || fallbackModel || "",
    content,
    stop_reason: mapStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: chatResponse.usage?.prompt_tokens || 0,
      output_tokens: chatResponse.usage?.completion_tokens || 0,
    },
  };
}

export class AnthropicMessagesStreamAdapter {
  constructor({ model }) {
    this.model = model || "";
    this.messageId = makeId("msg");
    this.repair = new ToolCallArgumentRepair();
    this.started = false;
    this.finished = false;
    this.textBlock = null;
    this.toolBlocks = new Map();
    this.nextIndex = 0;
    this.stopReason = "end_turn";
    this.outputTokens = 0;
  }

  emitMessageStart() {
    return formatSseEvent("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    });
  }

  ensureTextBlock(chunks) {
    if (this.textBlock) {
      return;
    }

    this.textBlock = {
      index: this.nextIndex,
      text: "",
    };
    this.nextIndex += 1;

    chunks.push(
      formatSseEvent("content_block_start", {
        type: "content_block_start",
        index: this.textBlock.index,
        content_block: {
          type: "text",
          text: "",
        },
      }),
    );
  }

  closeTextBlock(chunks) {
    if (!this.textBlock) {
      return;
    }

    chunks.push(
      formatSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.textBlock.index,
      }),
    );
    this.textBlock = null;
  }

  ensureToolBlock(toolCall, chunks) {
    const toolIndex = toolCall.index ?? 0;
    let state = this.toolBlocks.get(toolIndex);

    if (!state) {
      state = {
        index: this.nextIndex,
        id: toolCall.id || makeId("toolu"),
        name: toolCall.function?.name || "",
        partialJson: "",
        closed: false,
      };
      this.nextIndex += 1;
      this.toolBlocks.set(toolIndex, state);

      chunks.push(
        formatSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.index,
          content_block: {
            type: "tool_use",
            id: state.id,
            name: state.name,
            input: {},
          },
        }),
      );
    } else if (!state.name && toolCall.function?.name) {
      state.name = toolCall.function.name;
    }

    return state;
  }

  closeToolBlocks(chunks) {
    for (const state of this.toolBlocks.values()) {
      if (state.closed) {
        continue;
      }
      state.closed = true;
      chunks.push(
        formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.index,
        }),
      );
    }
  }

  finish(chunks) {
    if (this.finished) {
      return "";
    }

    this.closeTextBlock(chunks);
    this.closeToolBlocks(chunks);

    chunks.push(
      formatSseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: this.stopReason,
          stop_sequence: null,
        },
        usage: {
          output_tokens: this.outputTokens,
        },
      }),
    );
    chunks.push(
      formatSseEvent("message_stop", {
        type: "message_stop",
      }),
    );
    this.finished = true;
    return chunks.join("");
  }

  handleBlock(block) {
    if (block.trim() === "") {
      return "\n\n";
    }

    const parsedBlock = parseSseBlock(block);
    if (!parsedBlock.hasData) {
      return `${block}\n\n`;
    }

    if (parsedBlock.data === "[DONE]") {
      return this.started && !this.finished ? this.finish([]) : "";
    }

    let payload;
    try {
      payload = this.repair.repairChunk(JSON.parse(parsedBlock.data));
    } catch {
      return `${block}\n\n`;
    }

    const chunks = [];
    if (!this.started) {
      chunks.push(this.emitMessageStart());
      this.started = true;
    }

    const choice = payload?.choices?.[0] || {};
    const delta = choice.delta || {};

    if (typeof delta.content === "string") {
      this.ensureTextBlock(chunks);
      this.textBlock.text += delta.content;
      chunks.push(
        formatSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.textBlock.index,
          delta: {
            type: "text_delta",
            text: delta.content,
          },
        }),
      );
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      this.closeTextBlock(chunks);
      for (const toolCall of delta.tool_calls) {
        const state = this.ensureToolBlock(toolCall, chunks);
        const fragment = toolCall.function?.arguments;
        if (typeof fragment === "string") {
          state.partialJson += fragment;
          chunks.push(
            formatSseEvent("content_block_delta", {
              type: "content_block_delta",
              index: state.index,
              delta: {
                type: "input_json_delta",
                partial_json: fragment,
              },
            }),
          );
        }
      }
    }

    if (payload.usage?.completion_tokens) {
      this.outputTokens = payload.usage.completion_tokens;
    }

    if (choice.finish_reason) {
      this.stopReason = mapStopReason(choice.finish_reason);
      return this.finish(chunks);
    }

    return chunks.join("");
  }

  flush() {
    return "";
  }
}
