export const PORT = Number(process.env.PORT || 3401);
export const HOST = process.env.HOST || "127.0.0.1";
export const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || "http://127.0.0.1:3000/v1";
export const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || "";

export function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function parseJsonBody(buffer) {
  if (buffer.length === 0) {
    return null;
  }

  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

export function buildUpstreamUrl(pathname, search = "") {
  const upstream = new URL(UPSTREAM_BASE_URL);
  const basePath = upstream.pathname.replace(/\/$/, "");

  if (basePath && (pathname === basePath || pathname.startsWith(`${basePath}/`))) {
    upstream.pathname = pathname;
  } else {
    upstream.pathname = `${basePath}${pathname === "/" ? "" : pathname}`;
  }

  upstream.search = search;
  return upstream;
}

export function buildChatCompletionsUrl(search = "") {
  return buildUpstreamUrl("/v1/chat/completions", search);
}

export function buildUpstreamHeaders(req, body) {
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

export async function fetchUpstream(req, body, upstreamUrl, controller) {
  return fetch(upstreamUrl, {
    method: req.method,
    headers: buildUpstreamHeaders(req, body),
    body: body.length > 0 ? body : undefined,
    signal: controller.signal,
    redirect: "manual",
  });
}

export function copyResponseHeaders(upstreamHeaders, res) {
  for (const [key, value] of upstreamHeaders.entries()) {
    if (key === "content-length" || key === "content-encoding") {
      continue;
    }
    res.setHeader(key, value);
  }
}

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function proxyErrorPayload(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: {
      message,
      type: "proxy_error",
    },
  };
}
