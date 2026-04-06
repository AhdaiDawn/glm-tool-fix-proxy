import { once } from "node:events";

export function splitSseBlocks(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  return {
    complete: parts.slice(0, -1),
    rest: parts.at(-1) || "",
  };
}

export function parseSseBlock(block) {
  const lines = block.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event:"));
  const event = eventLine ? eventLine.slice(6).trimStart() : null;
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  return {
    block,
    event,
    lines,
    data: dataLines.join("\n"),
    hasData: dataLines.length > 0,
  };
}

export function formatSseEvent(event, payload) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (event) {
    return `event: ${event}\ndata: ${body}\n\n`;
  }
  return `data: ${body}\n\n`;
}

export function formatSseData(payload) {
  return formatSseEvent(null, payload);
}

async function writeSseOutput(res, output, stats, startedAt) {
  if (!output) {
    return;
  }

  if (stats.firstWriteMs === null) {
    stats.firstWriteMs = Date.now() - startedAt;
  }
  stats.writes += 1;

  if (!res.write(output)) {
    await once(res, "drain");
  }
}

export async function pipeTransformedSse(upstreamResponse, res, transformer) {
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const startedAt = Date.now();
  const stats = {
    upstreamChunks: 0,
    transformedBlocks: 0,
    writes: 0,
    firstWriteMs: null,
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    stats.upstreamChunks += 1;
    pending += decoder.decode(value, { stream: true });
    const { complete, rest } = splitSseBlocks(pending);
    pending = rest;

    for (const block of complete) {
      const output = transformer.handleBlock(block);
      stats.transformedBlocks += 1;
      await writeSseOutput(res, output, stats, startedAt);
    }
  }

  pending += decoder.decode();
  if (pending !== "") {
    const { complete, rest } = splitSseBlocks(`${pending}\n\n`);
    for (const block of complete) {
      const output = transformer.handleBlock(block);
      stats.transformedBlocks += 1;
      await writeSseOutput(res, output, stats, startedAt);
    }
    if (rest) {
      const output = transformer.handleBlock(rest);
      stats.transformedBlocks += 1;
      await writeSseOutput(res, output, stats, startedAt);
    }
  }

  const flushed = transformer.flush();
  await writeSseOutput(res, flushed, stats, startedAt);
  return stats;
}
