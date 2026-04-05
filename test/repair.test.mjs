import test from "node:test";
import assert from "node:assert/strict";
import { ToolCallArgumentRepair } from "../repair.mjs";

function chunk(argumentsText) {
  return {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: argumentsText,
              },
            },
          ],
        },
      },
    ],
  };
}

test("keeps normal incremental argument chunks unchanged", () => {
  const repair = new ToolCallArgumentRepair();

  const a = repair.repairChunk(chunk('{"filePath":"'));
  const b = repair.repairChunk(chunk("/tmp/test"));
  const c = repair.repairChunk(chunk('"}'));

  assert.equal(a.choices[0].delta.tool_calls[0].function.arguments, '{"filePath":"');
  assert.equal(b.choices[0].delta.tool_calls[0].function.arguments, "/tmp/test");
  assert.equal(c.choices[0].delta.tool_calls[0].function.arguments, '"}');
});

test("rewrites duplicated final full JSON into only the missing suffix", () => {
  const repair = new ToolCallArgumentRepair();

  repair.repairChunk(chunk('{"filePath":"'));
  repair.repairChunk(chunk("/home/ahdai/.config/opencode/opencode.json"));
  const quote = repair.repairChunk(chunk('"'));
  const duplicated = repair.repairChunk(
    chunk('{"filePath": "/home/ahdai/.config/opencode/opencode.json"}'),
  );

  assert.equal(quote.choices[0].delta.tool_calls[0].function.arguments, '"');
  assert.equal(duplicated.choices[0].delta.tool_calls[0].function.arguments, "}");
});

test("drops a repeated full JSON snapshot when downstream already has the full object", () => {
  const repair = new ToolCallArgumentRepair();

  repair.repairChunk(chunk('{"filePath":"/tmp/test"}'));
  const duplicated = repair.repairChunk(chunk('{"filePath":"/tmp/test"}'));
  const toolCall = duplicated.choices[0].delta.tool_calls[0];

  assert.equal(Object.hasOwn(toolCall, "function"), false);
});
