import http from "node:http";
import { ToolCallArgumentRepair } from "./repair.mjs";

const PORT = Number(process.env.PORT || 3401);
const HOST = process.env.HOST || "127.0.0.1";
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:3000/v1";
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || "";

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildUpstreamUrl(req) {
  const upstream = new URL(UPSTREAM_BASE_URL);
  const incoming = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const upstreamBasePath = upstream.pathname.replace(/\/$/, "");
  const incomingPath = incoming.pathname;

  if (
    upstreamBasePath &&
    (incomingPath === upstreamBasePath || incomingPath.startsWith(`${upstreamBasePath}/`))
  ) {
    upstream.pathname = incomingPath;
  } else {
    upstream.pathname = `${upstreamBasePath}${incomingPath === "/" ? "" : incomingPath}`;
  }

  upstream.search = incoming.search;
  return upstream;
}

function buildUpstreamHeaders(req, body) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (key === "host" || key === "content-length" || key === "accept-encoding") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    headers.set(key, value);
  }

  if (UPSTREAM_API_KEY) {
    headers.set("authorization", `Bearer ${UPSTREAM_API_KEY}`);
  }

  if (body.length > 0 && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return headers;
}

function parseJsonBody(buffer) {
  if (buffer.length === 0) {
    return null;
  }

  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function isStreamingChatCompletion(req, bodyJson, upstreamUrl) {
  if (req.method !== "POST") {
    return false;
  }
  if (!bodyJson || bodyJson.stream !== true) {
    return false;
  }
  return upstreamUrl.pathname.endsWith("/chat/completions");
}

function copyResponseHeaders(upstreamHeaders, res) {
  for (const [key, value] of upstreamHeaders.entries()) {
    if (key === "content-length" || key === "content-encoding") {
      continue;
    }
    res.setHeader(key, value);
  }
}

function splitSseBlocks(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  return {
    complete: parts.slice(0, -1),
    rest: parts.at(-1) || "",
  };
}

function rebuildEvent(lines, nextData) {
  const output = [];
  let dataWritten = false;

  for (const line of lines) {
    if (line.startsWith("data:")) {
      if (dataWritten) {
        continue;
      }
      output.push(`data: ${nextData}`);
      dataWritten = true;
      continue;
    }
    output.push(line);
  }

  if (!dataWritten) {
    output.push(`data: ${nextData}`);
  }

  return `${output.join("\n")}\n\n`;
}

function transformSseBlock(block, repair) {
  if (block.trim() === "") {
    return "\n\n";
  }

  const lines = block.split("\n");
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return `${block}\n\n`;
  }

  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    return `${block}\n\n`;
  }

  try {
    const parsed = JSON.parse(data);
    const repairedPayload = repair.repairChunk(parsed);
    return rebuildEvent(lines, JSON.stringify(repairedPayload));
  } catch {
    return `${block}\n\n`;
  }
}

async function pipeStreamingResponse(upstreamResponse, res) {
  const repair = new ToolCallArgumentRepair();
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    pending += decoder.decode(value, { stream: true });
    const { complete, rest } = splitSseBlocks(pending);
    pending = rest;

    for (const block of complete) {
      res.write(transformSseBlock(block, repair));
    }
  }

  pending += decoder.decode();
  if (pending !== "") {
    const { complete, rest } = splitSseBlocks(`${pending}\n\n`);
    for (const block of complete) {
      res.write(transformSseBlock(block, repair));
    }
    if (rest) {
      res.write(rest);
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const body = await readRequestBody(req);
    const bodyJson = parseJsonBody(body);
    const upstreamUrl = buildUpstreamUrl(req);
    const controller = new AbortController();

    req.on("close", () => controller.abort());

    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req, body),
      body: body.length > 0 ? body : undefined,
      signal: controller.signal,
      redirect: "manual",
    });

    res.statusCode = upstreamResponse.status;
    res.statusMessage = upstreamResponse.statusText;
    copyResponseHeaders(upstreamResponse.headers, res);

    if (!upstreamResponse.body) {
      res.end();
      return;
    }

    if (isStreamingChatCompletion(req, bodyJson, upstreamUrl)) {
      await pipeStreamingResponse(upstreamResponse, res);
      res.end();
      return;
    }

    const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
    res.end(responseBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.statusCode = 502;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: {
          message,
          type: "proxy_error",
        },
      }),
    );
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      message: "proxy_listening",
      host: HOST,
      port: PORT,
      upstream: UPSTREAM_BASE_URL,
    }),
  );
});
