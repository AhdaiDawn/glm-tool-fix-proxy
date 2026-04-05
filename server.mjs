import http from "node:http";
import { randomUUID } from "node:crypto";
import { ChatCompletionRepairTransformer, isStreamingChatCompletion } from "./adapters/chat.mjs";
import {
  AnthropicMessagesStreamAdapter,
  anthropicToChatRequest,
  chatToAnthropicMessage,
} from "./adapters/messages.mjs";
import {
  OpenAIResponsesStreamAdapter,
  ResponseStore,
  buildResponsesObject,
  buildStoredConversation,
  responsesToChatRequest,
  shouldStoreResponse,
} from "./adapters/responses.mjs";
import { pipeTransformedSse } from "./core/sse.mjs";
import {
  HOST,
  PORT,
  buildChatCompletionsUrl,
  buildUpstreamUrl,
  copyResponseHeaders,
  fetchUpstream,
  parseJsonBody,
  proxyErrorPayload,
  readRequestBody,
  sendJson,
} from "./core/upstream.mjs";
import { resolveUpstreamModel } from "./core/model-routing.mjs";
import { UPSTREAM_MAX_TOKENS, clampMaxTokens, parseContextLimitRetry } from "./core/token-limits.mjs";

const responseStore = new ResponseStore();
const PROXY_LOG = process.env.PROXY_LOG === "1" || process.env.PROXY_LOG === "true";

function logEvent(event, fields = {}) {
  if (!PROXY_LOG) {
    return;
  }
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    }),
  );
}

function createRequestId() {
  return `req_${randomUUID().replace(/-/g, "")}`;
}

function incomingUrl(req) {
  return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
}

function createAbortController(req) {
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  return controller;
}

function summarizeRequest(bodyJson) {
  const requestedMaxTokens = bodyJson?.max_tokens ?? bodyJson?.max_output_tokens ?? null;
  return {
    requested_model: bodyJson?.model || null,
    stream: bodyJson?.stream === true,
    tool_count: Array.isArray(bodyJson?.tools) ? bodyJson.tools.length : 0,
    requested_max_tokens: requestedMaxTokens,
  };
}

function detectDownstreamApi(pathname) {
  if (pathname === "/v1/messages") {
    return "anthropic_messages";
  }
  if (pathname === "/v1/responses" || pathname.startsWith("/v1/responses/")) {
    return "openai_responses";
  }
  if (pathname === "/v1/chat/completions") {
    return "openai_chat_completions";
  }
  return "passthrough";
}

async function proxyRawJson(req, res, body, pathname, search, bodyJson, logContext) {
  const controller = createAbortController(req);
  const upstreamUrl = buildUpstreamUrl(pathname, search);
  logEvent("proxy_upstream_request", {
    ...logContext,
    upstream_url: upstreamUrl.toString(),
    upstream_api: "passthrough",
  });
  const upstreamResponse = await fetchUpstream(req, body, upstreamUrl, controller);
  logEvent("proxy_upstream_response", {
    ...logContext,
    upstream_status: upstreamResponse.status,
    upstream_status_text: upstreamResponse.statusText,
    upstream_api: "passthrough",
  });

  res.statusCode = upstreamResponse.status;
  res.statusMessage = upstreamResponse.statusText;
  copyResponseHeaders(upstreamResponse.headers, res);

  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  if (isStreamingChatCompletion(req, bodyJson, pathname)) {
    await pipeTransformedSse(upstreamResponse, res, new ChatCompletionRepairTransformer());
    logEvent("proxy_stream_complete", {
      ...logContext,
      downstream_api: "openai_chat_completions",
      upstream_api: "passthrough",
      stream: true,
    });
    res.end();
    return;
  }

  const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  logEvent("proxy_passthrough_complete", {
    ...logContext,
    downstream_api: detectDownstreamApi(pathname),
    upstream_api: "passthrough",
    response_bytes: responseBuffer.length,
  });
  res.end(responseBuffer);
}

function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

async function fetchWithContextRetry({
  req,
  controller,
  upstreamUrl,
  upstreamBody,
  requestedMaxTokens,
  rebuildUpstreamBody,
  logContext,
}) {
  let upstreamResponse = await fetchUpstream(req, upstreamBody, upstreamUrl, controller);
  logEvent("proxy_upstream_response", {
    ...logContext,
    upstream_status: upstreamResponse.status,
    upstream_status_text: upstreamResponse.statusText,
    upstream_api: "openai_chat_completions",
  });

  if (upstreamResponse.ok) {
    return { upstreamResponse };
  }

  const errorBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  const retry = parseContextLimitRetry(parseJsonBuffer(errorBuffer), requestedMaxTokens);
  if (!retry) {
    return {
      upstreamResponse: null,
      failure: {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: upstreamResponse.headers,
        bodyBuffer: errorBuffer,
      },
    };
  }

  const retriedBody = rebuildUpstreamBody(retry.retry_max_tokens);
  logEvent("proxy_upstream_retry", {
    ...logContext,
    upstream_api: "openai_chat_completions",
    retry_reason: "context_length",
    input_tokens: retry.input_tokens,
    requested_output_tokens: retry.requested_output_tokens,
    retry_max_tokens: retry.retry_max_tokens,
  });

  upstreamResponse = await fetchUpstream(req, retriedBody, upstreamUrl, controller);
  logEvent("proxy_upstream_response", {
    ...logContext,
    upstream_status: upstreamResponse.status,
    upstream_status_text: upstreamResponse.statusText,
    upstream_api: "openai_chat_completions",
    retried: true,
  });

  return {
    upstreamResponse,
    retry,
  };
}

async function handleMessagesRequest(req, res, bodyJson, logContext) {
  if (!bodyJson || req.method !== "POST") {
    sendJson(res, 400, {
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Expected a JSON body for POST /v1/messages.",
      },
    });
    return;
  }

  const upstreamModel = resolveUpstreamModel(bodyJson.model);
  const tokenLimit = clampMaxTokens(bodyJson.max_tokens);
  function buildMessagesUpstreamBody(maxTokensOverride) {
    const nextBody = anthropicToChatRequest({
      ...bodyJson,
      model: upstreamModel,
      ...((maxTokensOverride ?? tokenLimit.upstream) ? { max_tokens: maxTokensOverride ?? tokenLimit.upstream } : {}),
    });
    return {
      chatBody: nextBody,
      buffer: Buffer.from(JSON.stringify(nextBody)),
    };
  }

  const initialUpstream = buildMessagesUpstreamBody();
  const controller = createAbortController(req);
  const upstreamUrl = buildChatCompletionsUrl();
  logEvent("proxy_upstream_request", {
    ...logContext,
    requested_model: bodyJson.model || null,
    upstream_model: upstreamModel || null,
    requested_max_tokens: tokenLimit.requested,
    upstream_max_tokens: tokenLimit.upstream,
    max_tokens_clamped: tokenLimit.clamped,
    upstream_url: upstreamUrl.toString(),
    upstream_api: "openai_chat_completions",
    adapted_message_count: initialUpstream.chatBody.messages.length,
  });
  const { upstreamResponse, failure, retry } = await fetchWithContextRetry({
    req,
    controller,
    upstreamUrl,
    upstreamBody: initialUpstream.buffer,
    requestedMaxTokens: tokenLimit.upstream,
    rebuildUpstreamBody: (retryMaxTokens) => buildMessagesUpstreamBody(retryMaxTokens).buffer,
    logContext,
  });

  if (!upstreamResponse) {
    res.statusCode = failure.status;
    copyResponseHeaders(failure.headers, res);
    res.end(failure.bodyBuffer);
    return;
  }

  res.statusCode = upstreamResponse.status;
  res.statusMessage = upstreamResponse.statusText;
  res.setHeader("content-type", bodyJson.stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-cache");

  if (bodyJson.stream) {
    await pipeTransformedSse(
      upstreamResponse,
      res,
      new AnthropicMessagesStreamAdapter({ model: bodyJson.model }),
    );
    logEvent("proxy_adapter_complete", {
      ...logContext,
      downstream_api: "anthropic_messages",
      upstream_api: "openai_chat_completions",
      stream: true,
      retry_max_tokens: retry?.retry_max_tokens || null,
      result: "ok",
    });
    res.end();
    return;
  }

  const chatResponse = JSON.parse(Buffer.from(await upstreamResponse.arrayBuffer()).toString("utf8"));
  const anthropicResponse = chatToAnthropicMessage(chatResponse, bodyJson.model);
  logEvent("proxy_adapter_complete", {
    ...logContext,
    downstream_api: "anthropic_messages",
    upstream_api: "openai_chat_completions",
    stream: false,
    retry_max_tokens: retry?.retry_max_tokens || null,
    stop_reason: anthropicResponse.stop_reason,
    content_blocks: anthropicResponse.content.length,
    result: "ok",
  });
  sendJson(res, upstreamResponse.status, anthropicResponse);
}

function createResponseId() {
  return `resp_${randomUUID().replace(/-/g, "")}`;
}

async function handleResponsesRequest(req, res, bodyJson, logContext) {
  if (!bodyJson || req.method !== "POST") {
    sendJson(res, 400, {
      error: {
        message: "Expected a JSON body for POST /v1/responses.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const previousEntry = bodyJson.previous_response_id
    ? responseStore.get(bodyJson.previous_response_id)
    : null;

  if (bodyJson.previous_response_id && !previousEntry) {
    sendJson(res, 404, {
      error: {
        message: `Unknown previous_response_id: ${bodyJson.previous_response_id}`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  const previousMessages = previousEntry?.messages || [];
  const upstreamModel = resolveUpstreamModel(bodyJson.model);
  const tokenLimit = clampMaxTokens(bodyJson.max_output_tokens);
  function buildResponsesUpstreamBody(maxTokensOverride) {
    const nextBody = responsesToChatRequest(
      {
        ...bodyJson,
        model: upstreamModel,
        ...((maxTokensOverride ?? tokenLimit.upstream) ? { max_output_tokens: maxTokensOverride ?? tokenLimit.upstream } : {}),
      },
      previousMessages,
    );
    return {
      chatBody: nextBody,
      buffer: Buffer.from(JSON.stringify(nextBody)),
    };
  }

  const initialUpstream = buildResponsesUpstreamBody();
  const requestMessages = initialUpstream.chatBody.messages.slice(previousMessages.length);
  const controller = createAbortController(req);
  const upstreamUrl = buildChatCompletionsUrl();
  logEvent("proxy_upstream_request", {
    ...logContext,
    requested_model: bodyJson.model || null,
    upstream_model: upstreamModel || null,
    requested_max_tokens: tokenLimit.requested,
    upstream_max_tokens: tokenLimit.upstream,
    max_tokens_clamped: tokenLimit.clamped,
    upstream_url: upstreamUrl.toString(),
    upstream_api: "openai_chat_completions",
    adapted_message_count: initialUpstream.chatBody.messages.length,
    previous_response_id: bodyJson.previous_response_id || null,
  });
  const { upstreamResponse, failure, retry } = await fetchWithContextRetry({
    req,
    controller,
    upstreamUrl,
    upstreamBody: initialUpstream.buffer,
    requestedMaxTokens: tokenLimit.upstream,
    rebuildUpstreamBody: (retryMaxTokens) => buildResponsesUpstreamBody(retryMaxTokens).buffer,
    logContext,
  });

  if (!upstreamResponse) {
    res.statusCode = failure.status;
    copyResponseHeaders(failure.headers, res);
    res.end(failure.bodyBuffer);
    return;
  }

  const responseId = createResponseId();
  res.statusCode = upstreamResponse.status;
  res.statusMessage = upstreamResponse.statusText;
  res.setHeader("content-type", bodyJson.stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-cache");

  if (bodyJson.stream) {
    const transformer = new OpenAIResponsesStreamAdapter({
      body: bodyJson,
      responseId,
      model: bodyJson.model,
    });
    await pipeTransformedSse(upstreamResponse, res, transformer);
    if (transformer.finished && shouldStoreResponse(bodyJson)) {
      responseStore.set(responseId, {
        response: transformer.buildResponse("completed"),
        messages: transformer.outputItems
          ? [
              ...previousMessages.map((message) => ({ ...message })),
              ...requestMessages.map((message) => ({ ...message })),
              {
                role: "assistant",
                content: transformer.outputText,
                ...(transformer.outputItems.some((item) => item.type === "function_call")
                  ? {
                      tool_calls: transformer.outputItems
                        .filter((item) => item.type === "function_call")
                        .map((item) => ({
                          id: item.call_id,
                          type: "function",
                          function: {
                            name: item.name,
                            arguments: item.arguments,
                          },
                        })),
                    }
                  : {}),
              },
            ]
          : [...previousMessages, ...requestMessages],
      });
    }
    logEvent("proxy_adapter_complete", {
      ...logContext,
      downstream_api: "openai_responses",
      upstream_api: "openai_chat_completions",
      stream: true,
      response_id: responseId,
      retry_max_tokens: retry?.retry_max_tokens || null,
      output_items: transformer.outputItems.length,
      output_text_chars: transformer.outputText.length,
      result: transformer.finished ? "ok" : "incomplete",
    });
    res.end();
    return;
  }

  const chatResponse = JSON.parse(Buffer.from(await upstreamResponse.arrayBuffer()).toString("utf8"));
  const responseObject = buildResponsesObject(bodyJson, chatResponse, responseId);
  if (shouldStoreResponse(bodyJson)) {
    responseStore.set(responseId, {
      response: responseObject,
      messages: buildStoredConversation(previousMessages, requestMessages, chatResponse),
    });
  }
  logEvent("proxy_adapter_complete", {
    ...logContext,
    downstream_api: "openai_responses",
    upstream_api: "openai_chat_completions",
    stream: false,
    response_id: responseId,
    retry_max_tokens: retry?.retry_max_tokens || null,
    output_items: responseObject.output.length,
    output_text_chars: responseObject.output_text.length,
    result: "ok",
  });
  sendJson(res, upstreamResponse.status, responseObject);
}

function handleGetResponse(req, res, pathname, logContext) {
  if (req.method !== "GET") {
    sendJson(res, 405, {
      error: {
        message: "Method not allowed.",
        type: "invalid_request_error",
      },
    });
    return;
  }

  const responseId = pathname.replace(/^\/v1\/responses\//, "");
  const entry = responseStore.get(responseId);
  if (!entry) {
    sendJson(res, 404, {
      error: {
        message: `Unknown response id: ${responseId}`,
        type: "invalid_request_error",
      },
    });
    return;
  }

  logEvent("proxy_response_lookup", {
    ...logContext,
    downstream_api: "openai_responses",
    response_id: responseId,
    found: true,
  });
  sendJson(res, 200, entry.response);
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  try {
    const body = await readRequestBody(req);
    const bodyJson = parseJsonBody(body);
    const url = incomingUrl(req);
    const requestId = createRequestId();
    const logContext = {
      request_id: requestId,
      method: req.method,
      path: url.pathname,
    };

    res.on("finish", () => {
      logEvent("proxy_request_complete", {
        ...logContext,
        downstream_api: detectDownstreamApi(url.pathname),
        status_code: res.statusCode,
        duration_ms: Date.now() - startedAt,
      });
    });

    logEvent("proxy_request_received", {
      ...logContext,
      downstream_api: detectDownstreamApi(url.pathname),
      body_bytes: body.length,
      ...summarizeRequest(bodyJson),
    });

    if (url.pathname === "/v1/messages") {
      await handleMessagesRequest(req, res, bodyJson, logContext);
      return;
    }

    if (url.pathname === "/v1/responses") {
      await handleResponsesRequest(req, res, bodyJson, logContext);
      return;
    }

    if (url.pathname.startsWith("/v1/responses/")) {
      handleGetResponse(req, res, url.pathname, logContext);
      return;
    }

    await proxyRawJson(req, res, body, url.pathname, url.search, bodyJson, logContext);
  } catch (error) {
    logEvent("proxy_request_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 502, proxyErrorPayload(error));
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    JSON.stringify({
      message: "proxy_listening",
      host: HOST,
      port: PORT,
      upstream: process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:3000/v1",
      upstream_model: process.env.UPSTREAM_MODEL || null,
      upstream_max_tokens: UPSTREAM_MAX_TOKENS,
      proxy_log: PROXY_LOG,
    }),
  );
});
