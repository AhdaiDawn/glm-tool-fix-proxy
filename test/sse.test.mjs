import test from "node:test";
import assert from "node:assert/strict";
import { pipeTransformedSse } from "../core/sse.mjs";

function createUpstreamResponse(chunks) {
  return {
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(Buffer.from(chunk));
        }
        controller.close();
      },
    }),
  };
}

test("pipeTransformedSse returns stream timing and write stats", async () => {
  const writes = [];
  const upstreamResponse = createUpstreamResponse([
    "data: one\n\n",
    "data: two\n\n",
    "data: [DONE]\n\n",
  ]);
  const transformer = {
    handleBlock(block) {
      return `${block}\n\n`;
    },
    flush() {
      return "";
    },
  };
  const res = {
    write(chunk) {
      writes.push(chunk);
      return true;
    },
  };

  const stats = await pipeTransformedSse(upstreamResponse, res, transformer);

  assert.deepEqual(writes, [
    "data: one\n\n",
    "data: two\n\n",
    "data: [DONE]\n\n",
  ]);
  assert.equal(stats.upstreamChunks, 3);
  assert.equal(stats.transformedBlocks, 3);
  assert.equal(stats.writes, 3);
  assert.equal(typeof stats.firstWriteMs, "number");
  assert.equal(stats.firstWriteMs >= 0, true);
});
