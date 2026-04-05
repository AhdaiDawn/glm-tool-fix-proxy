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

function stringifyValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value);
}

function extractTextFromResponseContent(content) {
  if (typeof content === "string") {
    return content;
  }

  return arrayify(content)
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item?.type === "input_text" || item?.type === "output_text" || item?.type === "text") {
        return item.text || "";
      }
      return "";
    })
    .join("");
}

function mapResponseToolChoice(toolChoice) {
  if (!toolChoice) {
    return undefined;
  }
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto" || toolChoice === "required" || toolChoice === "none") {
      return toolChoice;
    }
    return undefined;
  }
  if (toolChoice.type === "function") {
    return {
      type: "function",
      function: {
        name: toolChoice.name || toolChoice.function?.name,
      },
    };
  }
  return undefined;
}

function mapResponseTools(tools) {
  return arrayify(tools)
    .filter((tool) => tool?.type === "function")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: "object", properties: {} },
      },
    }));
}

function responseInputItemToChatMessages(item) {
  if (!item) {
    return [];
  }

  if (item.role) {
    const role = item.role;
    const text = extractTextFromResponseContent(item.content);

    if (role === "user" || role === "system") {
      return [{ role, content: text }];
    }

    if (role === "assistant") {
      const toolCalls = arrayify(item.content)
        .filter((block) => block?.type === "function_call")
        .map((block) => ({
          id: block.call_id || block.id || makeId("call"),
          type: "function",
          function: {
            name: block.name || "",
            arguments: block.arguments || "",
          },
        }));

      return [
        {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      ];
    }

    return [];
  }

  if (item.type === "function_call_output") {
    return [
      {
        role: "tool",
        tool_call_id: item.call_id,
        content: stringifyValue(item.output),
      },
    ];
  }

  if (item.type === "function_call") {
    return [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id || item.id || makeId("call"),
            type: "function",
            function: {
              name: item.name || "",
              arguments: item.arguments || "",
            },
          },
        ],
      },
    ];
  }

  if (item.type === "input_text") {
    return [{ role: "user", content: item.text || "" }];
  }

  return [];
}

export function responsesToChatRequest(body, previousMessages = []) {
  const messages = previousMessages.map((message) => ({ ...message }));

  if (typeof body.instructions === "string" && body.instructions !== "") {
    messages.push({ role: "system", content: body.instructions });
  }

  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else {
    for (const item of arrayify(body.input)) {
      messages.push(...responseInputItemToChatMessages(item));
    }
  }

  const tools = mapResponseTools(body.tools);
  const toolChoice = mapResponseToolChoice(body.tool_choice);

  return {
    model: body.model,
    messages,
    stream: body.stream === true,
    ...(body.max_output_tokens ? { max_tokens: body.max_output_tokens } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
}

function buildAssistantChatMessage(chatResponse) {
  const choice = chatResponse?.choices?.[0] || {};
  const message = choice.message || {};
  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : "",
    ...(Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? { tool_calls: message.tool_calls }
      : {}),
  };
}

function buildResponseOutput(chatResponse) {
  const choice = chatResponse?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];

  if (typeof message.content === "string" && message.content !== "") {
    output.push({
      id: makeId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: message.content,
          annotations: [],
        },
      ],
    });
  }

  for (const toolCall of arrayify(message.tool_calls)) {
    output.push({
      id: makeId("fc"),
      type: "function_call",
      call_id: toolCall.id || makeId("call"),
      name: toolCall.function?.name || "",
      arguments: toolCall.function?.arguments || "",
      status: "completed",
    });
  }

  return output;
}

export function chatToResponsesOutput(chatResponse) {
  return buildResponseOutput(chatResponse);
}

export function buildResponsesObject(body, chatResponse, responseId) {
  const output = buildResponseOutput(chatResponse);
  const outputText = output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content)
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");

  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    completed_at: Math.floor(Date.now() / 1000),
    error: null,
    incomplete_details: null,
    instructions: body.instructions || null,
    max_output_tokens: body.max_output_tokens || null,
    model: chatResponse.model || body.model,
    output,
    output_text: outputText,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id || null,
    reasoning: {
      effort: body.reasoning?.effort || null,
      summary: null,
    },
    store: body.store ?? true,
    temperature: body.temperature ?? 1.0,
    text: body.text || { format: { type: "text" } },
    tool_choice: body.tool_choice || "auto",
    tools: arrayify(body.tools),
    top_p: body.top_p ?? 1.0,
    truncation: body.truncation || "disabled",
    usage: {
      input_tokens: chatResponse.usage?.prompt_tokens || 0,
      input_tokens_details: {
        cached_tokens: 0,
      },
      output_tokens: chatResponse.usage?.completion_tokens || 0,
      output_tokens_details: {
        reasoning_tokens: 0,
      },
      total_tokens: chatResponse.usage?.total_tokens || 0,
    },
    user: body.user || null,
    metadata: body.metadata || {},
  };
}

export class ResponseStore {
  constructor() {
    this.responses = new Map();
  }

  get(responseId) {
    return this.responses.get(responseId);
  }

  set(responseId, value) {
    this.responses.set(responseId, value);
  }
}

export function shouldStoreResponse(body) {
  return body?.store !== false;
}

export class OpenAIResponsesStreamAdapter {
  constructor({ body, responseId, model }) {
    this.body = body;
    this.responseId = responseId;
    this.model = model || body.model || "";
    this.createdAt = Math.floor(Date.now() / 1000);
    this.repair = new ToolCallArgumentRepair();
    this.started = false;
    this.finished = false;
    this.outputItems = [];
    this.currentText = null;
    this.toolItems = new Map();
    this.outputText = "";
    this.usage = null;
  }

  buildResponse(status) {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status,
      error: null,
      incomplete_details: null,
      instructions: this.body.instructions || null,
      max_output_tokens: this.body.max_output_tokens || null,
      model: this.model,
      output: this.outputItems,
      output_text: this.outputText,
      parallel_tool_calls: this.body.parallel_tool_calls ?? true,
      previous_response_id: this.body.previous_response_id || null,
      reasoning: {
        effort: this.body.reasoning?.effort || null,
        summary: null,
      },
      store: this.body.store ?? true,
      temperature: this.body.temperature ?? 1.0,
      text: this.body.text || { format: { type: "text" } },
      tool_choice: this.body.tool_choice || "auto",
      tools: arrayify(this.body.tools),
      top_p: this.body.top_p ?? 1.0,
      truncation: this.body.truncation || "disabled",
      usage: status === "completed" ? this.usage : null,
      user: this.body.user || null,
      metadata: this.body.metadata || {},
    };
  }

  startEvents() {
    return (
      formatSseEvent("response.created", {
        type: "response.created",
        response: this.buildResponse("in_progress"),
      }) +
      formatSseEvent("response.in_progress", {
        type: "response.in_progress",
        response: this.buildResponse("in_progress"),
      })
    );
  }

  ensureTextItem(chunks) {
    if (this.currentText) {
      return;
    }

    const item = {
      id: makeId("msg"),
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    const state = {
      outputIndex: this.outputItems.length,
      item,
      text: "",
    };
    this.outputItems.push(item);
    this.currentText = state;

    chunks.push(
      formatSseEvent("response.output_item.added", {
        type: "response.output_item.added",
        response_id: this.responseId,
        output_index: state.outputIndex,
        item,
      }),
    );
    chunks.push(
      formatSseEvent("response.content_part.added", {
        type: "response.content_part.added",
        response_id: this.responseId,
        item_id: item.id,
        output_index: state.outputIndex,
        content_index: 0,
        part: {
          type: "output_text",
          text: "",
          annotations: [],
        },
      }),
    );
  }

  closeTextItem(chunks) {
    if (!this.currentText) {
      return;
    }

    const { item, outputIndex, text } = this.currentText;
    const part = {
      type: "output_text",
      text,
      annotations: [],
    };
    item.status = "completed";
    item.content = [part];

    chunks.push(
      formatSseEvent("response.output_text.done", {
        type: "response.output_text.done",
        response_id: this.responseId,
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        text,
      }),
    );
    chunks.push(
      formatSseEvent("response.content_part.done", {
        type: "response.content_part.done",
        response_id: this.responseId,
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part,
      }),
    );
    chunks.push(
      formatSseEvent("response.output_item.done", {
        type: "response.output_item.done",
        response_id: this.responseId,
        output_index: outputIndex,
        item,
      }),
    );
    this.currentText = null;
  }

  ensureToolItem(toolCall, chunks) {
    const toolIndex = toolCall.index ?? 0;
    let state = this.toolItems.get(toolIndex);

    if (!state) {
      const item = {
        id: makeId("fc"),
        type: "function_call",
        call_id: toolCall.id || makeId("call"),
        name: toolCall.function?.name || "",
        arguments: "",
        status: "in_progress",
      };
      state = {
        outputIndex: this.outputItems.length,
        item,
      };
      this.outputItems.push(item);
      this.toolItems.set(toolIndex, state);

      chunks.push(
        formatSseEvent("response.output_item.added", {
          type: "response.output_item.added",
          response_id: this.responseId,
          output_index: state.outputIndex,
          item,
        }),
      );
    } else if (!state.item.name && toolCall.function?.name) {
      state.item.name = toolCall.function.name;
    }

    return state;
  }

  closeToolItems(chunks) {
    for (const state of this.toolItems.values()) {
      if (state.item.status === "completed") {
        continue;
      }
      state.item.status = "completed";
      chunks.push(
        formatSseEvent("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          response_id: this.responseId,
          item_id: state.item.id,
          output_index: state.outputIndex,
          arguments: state.item.arguments,
        }),
      );
      chunks.push(
        formatSseEvent("response.output_item.done", {
          type: "response.output_item.done",
          response_id: this.responseId,
          output_index: state.outputIndex,
          item: state.item,
        }),
      );
    }
  }

  finish(chunks) {
    if (this.finished) {
      return "";
    }

    this.closeTextItem(chunks);
    this.closeToolItems(chunks);

    chunks.push(
      formatSseEvent("response.completed", {
        type: "response.completed",
        response: this.buildResponse("completed"),
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
      return "";
    }

    let payload;
    try {
      payload = this.repair.repairChunk(JSON.parse(parsedBlock.data));
    } catch {
      return `${block}\n\n`;
    }

    const chunks = [];
    if (!this.started) {
      chunks.push(this.startEvents());
      this.started = true;
    }

    const choice = payload?.choices?.[0] || {};
    const delta = choice.delta || {};

    if (typeof delta.content === "string") {
      this.ensureTextItem(chunks);
      this.currentText.text += delta.content;
      this.outputText += delta.content;
      chunks.push(
        formatSseEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          response_id: this.responseId,
          item_id: this.currentText.item.id,
          output_index: this.currentText.outputIndex,
          content_index: 0,
          delta: delta.content,
        }),
      );
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      this.closeTextItem(chunks);
      for (const toolCall of delta.tool_calls) {
        const state = this.ensureToolItem(toolCall, chunks);
        const fragment = toolCall.function?.arguments;
        if (typeof fragment === "string") {
          state.item.arguments += fragment;
          chunks.push(
            formatSseEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              response_id: this.responseId,
              item_id: state.item.id,
              output_index: state.outputIndex,
              delta: fragment,
            }),
          );
        }
      }
    }

    if (payload.usage) {
      this.usage = {
        input_tokens: payload.usage.prompt_tokens || 0,
        input_tokens_details: {
          cached_tokens: 0,
        },
        output_tokens: payload.usage.completion_tokens || 0,
        output_tokens_details: {
          reasoning_tokens: 0,
        },
        total_tokens: payload.usage.total_tokens || 0,
      };
    }

    if (choice.finish_reason) {
      return this.finish(chunks);
    }

    return chunks.join("");
  }

  flush() {
    return "";
  }
}

export function buildStoredConversation(previousMessages, requestMessages, chatResponse) {
  return [
    ...previousMessages.map((message) => ({ ...message })),
    ...requestMessages.map((message) => ({ ...message })),
    buildAssistantChatMessage(chatResponse),
  ];
}
