import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenAIResponsesStreamAdapter,
  buildResponsesObject,
  buildStoredConversation,
  responsesToChatRequest,
  shouldStoreResponse,
  validateResponsesRequest,
  ResponseStore,
} from "../adapters/responses.mjs";

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test("maps responses request into chat completions request", () => {
  const request = responsesToChatRequest(
    {
      model: "glm-5",
      instructions: "Use tools when helpful.",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "read /tmp/test" },
          ],
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: { ok: true },
        },
      ],
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              filePath: { type: "string" },
            },
          },
        },
      ],
      tool_choice: { type: "function", name: "read" },
      max_output_tokens: 512,
    },
    [{ role: "system", content: "Earlier state." }],
  );

  assert.deepEqual(request.messages, [
    { role: "system", content: "Earlier state." },
    { role: "system", content: "Use tools when helpful." },
    { role: "user", content: "read /tmp/test" },
    { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" },
  ]);
  assert.equal(request.tool_choice.function.name, "read");
  assert.equal(request.max_tokens, 512);
});

test("maps responses developer role into a chat system message", () => {
  const request = responsesToChatRequest({
    model: "glm-5",
    input: [
      {
        role: "developer",
        content: [
          { type: "input_text", text: "Use terse answers." },
        ],
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "hi" },
        ],
      },
    ],
  });

  assert.deepEqual(request.messages, [
    { role: "system", content: "Use terse answers." },
    { role: "user", content: "hi" },
  ]);
});

test("preserves responses tool_choice none", () => {
  const request = responsesToChatRequest({
    model: "glm-5",
    input: "answer directly",
    tool_choice: "none",
  });

  assert.equal(request.tool_choice, "none");
});

test("drops hosted responses tools from the upstream chat request", () => {
  const request = responsesToChatRequest({
    model: "glm-5",
    input: "search for this",
    tools: [
      { type: "web_search" },
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
        },
      },
    ],
  });

  assert.deepEqual(request.tools, [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
        },
      },
    },
  ]);
});

test("accepts responses developer role with text input", () => {
  const error = validateResponsesRequest({
    model: "glm-5",
    input: [
      {
        role: "developer",
        content: [
          { type: "input_text", text: "Use tools only when necessary." },
        ],
      },
    ],
  });

  assert.equal(error, null);
});

test("rejects unsupported responses input item types", () => {
  const error = validateResponsesRequest({
    model: "glm-5",
    input: [
      { type: "input_text", text: "caption this" },
      { type: "input_image", image_url: "https://example.com/a.png" },
    ],
  });

  assert.equal(
    error,
    "Unsupported responses input item type: input_image. Upstream only supports text and function calls.",
  );
});

test("accepts hosted responses tools for compatibility", () => {
  const error = validateResponsesRequest({
    model: "glm-5",
    input: "search for this",
    tools: [{ type: "web_search" }, { type: "web_search_preview" }],
  });

  assert.equal(error, null);
});

test("drops unsupported responses tool_choice when no function tools remain", () => {
  const request = responsesToChatRequest({
    model: "glm-5",
    input: "search for this",
    tools: [{ type: "web_search" }],
    tool_choice: "required",
  });

  assert.equal(Object.hasOwn(request, "tool_choice"), false);
  assert.equal(Object.hasOwn(request, "tools"), false);
});

test("drops hosted responses tool_choice objects from the upstream chat request", () => {
  const request = responsesToChatRequest({
    model: "glm-5",
    input: "search for this",
    tools: [
      { type: "web_search" },
      {
        type: "function",
        name: "read",
        description: "Read a file",
      },
    ],
    tool_choice: { type: "web_search" },
  });

  assert.equal(Object.hasOwn(request, "tool_choice"), false);
  assert.equal(request.tools[0].function.name, "read");
});

test("builds responses object from chat completion response", () => {
  const response = buildResponsesObject(
    {
      model: "glm-5",
      tools: [],
      tool_choice: "auto",
    },
    {
      model: "glm-5",
      usage: {
        prompt_tokens: 11,
        completion_tokens: 5,
        total_tokens: 16,
      },
      choices: [
        {
          message: {
            role: "assistant",
            content: "Done.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read",
                  arguments: "{\"filePath\":\"/tmp/test\"}",
                },
              },
            ],
          },
        },
      ],
    },
    "resp_1",
  );

  assert.equal(response.object, "response");
  assert.equal(response.output_text, "Done.");
  assert.equal(response.output[0].type, "message");
  assert.equal(response.output[1].type, "function_call");
  assert.equal(response.usage.total_tokens, 16);
});

test("stores previous conversation including assistant tool call", () => {
  const messages = buildStoredConversation(
    [{ role: "system", content: "Earlier" }],
    [{ role: "user", content: "read /tmp/test" }],
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "read",
                  arguments: "{\"filePath\":\"/tmp/test\"}",
                },
              },
            ],
          },
        },
      ],
    },
  );

  assert.equal(messages.length, 3);
  assert.equal(messages[2].tool_calls[0].function.name, "read");
});

test("streams responses function call argument deltas from chat deltas", () => {
  const adapter = new OpenAIResponsesStreamAdapter({
    body: {
      model: "glm-5",
      tools: [],
      tool_choice: "auto",
    },
    responseId: "resp_1",
    model: "glm-5",
  });

  const start = adapter.handleBlock(
    sseChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: {
                  name: "read",
                  arguments: "{\"filePath\":\"",
                },
              },
            ],
          },
        },
      ],
    }).trimEnd(),
  );

  const end = adapter.handleBlock(
    sseChunk({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
      },
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: "/tmp/test\"}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }).trimEnd(),
  );

  assert.match(start, /event: response.created/);
  assert.match(start, /event: response.output_item.added/);
  assert.match(start, /"type":"response.function_call_arguments.delta"/);
  assert.match(end, /"type":"response.function_call_arguments.done"/);
  assert.match(end, /"status":"completed"/);
  assert.match(end, /event: response.completed/);
});

test("does not synthesize a completed response for an incomplete upstream stream", () => {
  const adapter = new OpenAIResponsesStreamAdapter({
    body: {
      model: "glm-5",
    },
    responseId: "resp_1",
    model: "glm-5",
  });

  adapter.handleBlock(
    sseChunk({
      choices: [
        {
          delta: {
            content: "partial",
          },
        },
      ],
    }).trimEnd(),
  );

  assert.equal(adapter.finished, false);
  assert.equal(adapter.flush(), "");
});

test("finishes a responses stream when upstream ends with DONE", () => {
  const adapter = new OpenAIResponsesStreamAdapter({
    body: {
      model: "glm-5",
    },
    responseId: "resp_1",
    model: "glm-5",
  });

  adapter.handleBlock(
    sseChunk({
      choices: [
        {
          delta: {
            content: "partial",
          },
        },
      ],
    }).trimEnd(),
  );

  const done = adapter.handleBlock("data: [DONE]");
  const response = adapter.buildResponse("completed");

  assert.match(done, /event: response.completed/);
  assert.equal(adapter.finished, true);
  assert.equal(typeof response.completed_at, "number");
});

test("response store evicts the oldest completed response", () => {
  const store = new ResponseStore({ maxEntries: 2 });

  store.set("resp_1", { response: { id: "resp_1" } });
  store.set("resp_2", { response: { id: "resp_2" } });
  store.set("resp_3", { response: { id: "resp_3" } });

  assert.equal(store.get("resp_1"), undefined);
  assert.deepEqual(store.get("resp_2"), { response: { id: "resp_2" } });
  assert.deepEqual(store.get("resp_3"), { response: { id: "resp_3" } });
});

test("shouldStoreResponse respects store false", () => {
  assert.equal(shouldStoreResponse({ store: false }), false);
  assert.equal(shouldStoreResponse({ store: true }), true);
  assert.equal(shouldStoreResponse({}), true);
});
