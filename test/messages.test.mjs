import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicMessagesStreamAdapter,
  anthropicToChatRequest,
  chatToAnthropicMessage,
} from "../adapters/messages.mjs";

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test("maps anthropic messages request into chat completions request", () => {
  const request = anthropicToChatRequest({
    model: "glm-5",
    system: "Be precise.",
    stream: false,
    max_tokens: 256,
    tools: [
      {
        name: "read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: {
            filePath: { type: "string" },
          },
          required: ["filePath"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "read" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "read this file" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "read",
            input: { filePath: "/tmp/test" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "file contents",
          },
        ],
      },
    ],
  });

  assert.deepEqual(request.messages, [
    { role: "system", content: "Be precise." },
    { role: "user", content: "read this file" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: {
            name: "read",
            arguments: "{\"filePath\":\"/tmp/test\"}",
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "toolu_1",
      content: "file contents",
    },
  ]);
  assert.equal(request.tool_choice.function.name, "read");
  assert.equal(request.tools[0].function.parameters.required[0], "filePath");
});

test("maps chat completion response into anthropic message", () => {
  const response = chatToAnthropicMessage({
    id: "chatcmpl_1",
    model: "glm-5",
    usage: {
      prompt_tokens: 12,
      completion_tokens: 7,
    },
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: "Need a tool.",
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
  }, "glm-5");

  assert.equal(response.type, "message");
  assert.equal(response.stop_reason, "tool_use");
  assert.equal(response.content[0].text, "Need a tool.");
  assert.deepEqual(response.content[1], {
    type: "tool_use",
    id: "call_1",
    name: "read",
    input: { filePath: "/tmp/test" },
  });
});

test("streams anthropic tool_use events from chat tool_call deltas", () => {
  const adapter = new AnthropicMessagesStreamAdapter({ model: "glm-5" });

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

  assert.match(start, /event: message_start/);
  assert.match(start, /event: content_block_start/);
  assert.match(start, /"type":"tool_use"/);
  assert.match(start, /"partial_json":"\{\\\"filePath\\\":\\\""/);

  assert.match(end, /"partial_json":"\/tmp\/test\\\"\}"/);
  assert.match(end, /event: content_block_stop/);
  assert.match(end, /"stop_reason":"tool_use"/);
  assert.match(end, /event: message_stop/);
});

test("does not synthesize anthropic completion events for an incomplete upstream stream", () => {
  const adapter = new AnthropicMessagesStreamAdapter({ model: "glm-5" });

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
