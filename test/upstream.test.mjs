import test from "node:test";
import assert from "node:assert/strict";
import { buildUpstreamHeaders, copyResponseHeaders, prepareStreamingResponse } from "../core/upstream.mjs";

test("buildUpstreamHeaders drops hop-by-hop request headers", () => {
  const headers = buildUpstreamHeaders(
    {
      headers: {
        host: "localhost:3401",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        trailer: "x-trace-id",
        "content-type": "application/json",
        authorization: "Bearer client-token",
      },
    },
    Buffer.from("{}"),
  );

  assert.equal(headers.has("connection"), false);
  assert.equal(headers.has("keep-alive"), false);
  assert.equal(headers.has("transfer-encoding"), false);
  assert.equal(headers.has("trailer"), false);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("authorization"), "Bearer client-token");
});

test("copyResponseHeaders drops hop-by-hop response headers", () => {
  const upstreamHeaders = new Headers({
    connection: "keep-alive",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    trailer: "x-trace-id",
    "content-type": "text/event-stream",
    "x-request-id": "req_123",
  });
  const recorded = new Map();
  const res = {
    setHeader(name, value) {
      recorded.set(name, value);
    },
  };

  copyResponseHeaders(upstreamHeaders, res);

  assert.equal(recorded.has("connection"), false);
  assert.equal(recorded.has("keep-alive"), false);
  assert.equal(recorded.has("transfer-encoding"), false);
  assert.equal(recorded.has("trailer"), false);
  assert.equal(recorded.get("content-type"), "text/event-stream");
  assert.equal(recorded.get("x-request-id"), "req_123");
});

test("prepareStreamingResponse flushes headers and disables proxy buffering", () => {
  const recorded = new Map();
  let flushed = false;
  let noDelay = null;
  const res = {
    socket: {
      setNoDelay(value) {
        noDelay = value;
      },
    },
    flushHeaders() {
      flushed = true;
    },
    setHeader(name, value) {
      recorded.set(name, value);
    },
  };

  prepareStreamingResponse(res);

  assert.equal(recorded.get("cache-control"), "no-cache");
  assert.equal(recorded.get("x-accel-buffering"), "no");
  assert.equal(flushed, true);
  assert.equal(noDelay, true);
});
