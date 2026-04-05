import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenAIResponsesStreamAdapter,
  buildResponsesObject,
  buildStoredConversation,
  responsesToChatRequest,
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
