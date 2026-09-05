/**
 * Streaming-safe fetch built directly on `node:http`/`node:https`.
 *
 * Why this exists: gateways that only negotiate HTTP/1.1 (no h2 ALPN) hit an
 * undici behavior where the built-in `fetch` buffers the entire chunked
 * response before handing the body to the consumer — so SSE token deltas
 * arrive as one lump at the end of the generation. The OpenAI/Anthropic SDK
 * clients inside pi-ai accept an injected `fetch` (StreamOptions.fetch,
 * forwarded to `createClient()` by every adapter), so gateways with
 * `directHttpStreaming: true` route their streaming inference requests
 * through this implementation instead. Node's core http client emits
 * `IncomingMessage` data per network chunk, which we enqueue straight into a
 * Web ReadableStream — tokens surface as they arrive.
 *
 * Scope: this fetch is used only for provider request paths that already
 * thread a custom fetch through (stream / streamSimple / fetchDeferred /
 * cancelDeferred). Discovery GETs keep the global fetch (their responses are
 * small and fully read anyway). Like the global fetch, proxy environment
 * variables are NOT applied here — enable the flag for direct gateways.
 */

import { request as httpRequest, type IncomingMessage, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Agent as HttpAgent, type AgentOptions } from "node:http";
import { Agent as HttpsAgent } from "node:https";

/** Max redirects followed, matching fetch's default "follow" behavior. */
const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;

// Reused keep-alive agents (same behavior users expect from an HTTP client
// pool; one pair per process, unref'd so they never keep the process alive).
let httpAgent: HttpAgent | undefined;
let httpsAgent: HttpsAgent | undefined;

const AGENT_OPTIONS: AgentOptions = {
  keepAlive: true,
  keepAliveInitialDelay: 30_000,
  timeout: 0, // No socket idle timeout — SSE can stay silent for minutes.
};

function getAgent(isHttps: boolean): HttpAgent | HttpsAgent {
  if (isHttps) return (httpsAgent ??= new HttpsAgent(AGENT_OPTIONS));
  return (httpAgent ??= new HttpAgent(AGENT_OPTIONS));
}

// ---------------------------------------------------------------------------
// Request normalization (fetch accepts string | URL | Request)
// ---------------------------------------------------------------------------

interface NormalizedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
  signal?: AbortSignal;
}

function headersToRecord(
  source: FetchInit["headers"] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!source) return out;
  if (source instanceof Headers) {
    for (const [key, value] of source) out[key] = value;
    return out;
  }
  if (Array.isArray(source)) {
    for (const [key, value] of source as [string, string][]) out[key.toLowerCase()] = value;
    return out;
  }
  for (const [key, value] of Object.entries(source as Record<string, string | number | string[]>)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

async function bodyToBytes(
  body: FetchInit["body"] | Uint8Array | undefined,
): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  // Async-iterable request bodies (rare — SDKs send strings): collect fully,
  // then send with an explicit content-length.
  const asyncIterable = body as AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;
  if (typeof (asyncIterable as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const parts: Buffer[] = [];
    for await (const chunk of asyncIterable as AsyncIterable<Uint8Array | string>) {
      parts.push(Buffer.from(typeof chunk === "string" ? chunk : chunk.slice()));
    }
    const joined = Buffer.concat(parts);
    return new Uint8Array(joined);
  }
  if (typeof (asyncIterable as Iterable<unknown>)[Symbol.iterator] === "function") {
    const parts: Buffer[] = [];
    for (const chunk of asyncIterable as Iterable<Uint8Array | string>) {
      parts.push(Buffer.from(typeof chunk === "string" ? chunk : chunk.slice()));
    }
    const joined = Buffer.concat(parts);
    return new Uint8Array(joined);
  }
  // Blob-like (has arrayBuffer()): stream() consumers never reach here in
  // practice, but keep the fallback cheap and correct.
  const blobLike = body as { arrayBuffer?(): Promise<ArrayBuffer> };
  if (typeof blobLike.arrayBuffer === "function") return new Uint8Array(await blobLike.arrayBuffer());
  throw new TypeError("Unsupported request body type for directHttpStreaming fetch");
}

function toAbsoluteUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// ---------------------------------------------------------------------------
// Single request/response pair
// ---------------------------------------------------------------------------

interface RawResponse {
  res: IncomingMessage;
  req: ClientRequest;
  statusCode: number;
  statusText: string;
  headers: Headers;
  /** Builds the final Response lazily, after redirect decisions are made. */
  toResponse(): Response;
}

function buildHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  const raw = res.rawHeaders ?? [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index]!;
    const value = raw[index + 1]!;
    try {
      headers.append(name, value);
    } catch {
      // Invalid header name/value characters — skip rather than fail the
      // whole response (undici would have rejected these server-side too).
    }
  }
  return headers;
}

function singleRequest(request: NormalizedRequest): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      reject(new TypeError(`Unsupported URL for directHttpStreaming fetch: ${request.url}`));
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(new TypeError(`directHttpStreaming fetch supports only http:// and https:// (${parsed.protocol})`));
      return;
    }
    const isHttps = parsed.protocol === "https:";

    const headers: Record<string, string> = { ...request.headers };
    if (request.body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
      headers["content-length"] = String(request.body.byteLength);
    }

    const send = isHttps ? httpsRequest : httpRequest;
    const req = send(parsed.toString(), {
      method: request.method,
      headers,
      agent: getAgent(isHttps),
      signal: request.signal,
    });

    let responded = false;
    let streamError: (error: Error) => void = () => {};

    req.on("error", (error) => {
      // Before the response: reject the fetch promise (AbortError on signal).
      // After: error the body stream, matching fetch semantics for a reset
      // socket mid-body.
      if (!responded) reject(error);
      else streamError(error);
    });

    req.on("response", (res) => {
      responded = true;
      const statusCode = res.statusCode ?? 0;
      const statusText = res.statusMessage ?? "";
      const headers = buildHeaders(res);

      req.on("error", (error) => streamError(error));

      res.on("aborted", () => streamError(new Error("HttpMessage was aborted (socket closed mid-body)")));

      const toResponse = (): Response => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamError = (error) => { try { controller.error(error); } catch { /* already closed */ } };
            res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            res.on("end", () => { try { controller.close(); } catch { /* already errored */ } });
            res.on("error", (error) => { try { controller.error(error); } catch { /* already closed */ } });
          },
          cancel(reason) {
            // Consumer walked away mid-stream: kill the socket so the
            // gateway sees the disconnect and stops generating.
            req.destroy(reason instanceof Error ? reason : undefined);
          },
        });
        return new Response(body, { status: statusCode, statusText, headers });
      };

      resolve({ res, req, statusCode, statusText, headers, toResponse });
    });

    if (request.body) req.end(Buffer.from(request.body));
    else req.end();
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * fetch-compatible function backed by node:http/node:https. Structurally
 * assignable to `FetchFunction`; pi-ai injects it into the provider SDKs
 * when the gateway opts in via `directHttpStreaming`.
 */
export async function nodeHttpFetch(
  input: string | URL | Request,
  init?: FetchInit,
): Promise<Response> {
  // Normalize without constructing a Request: SDK inits carry provider
  // fields (duplex, timeout markers) that Request validation may reject.
  const fromRequest = input instanceof Request ? input : undefined;
  const url = toAbsoluteUrl(input);
  const method = (init?.method ?? fromRequest?.method ?? "GET").toUpperCase();
  const headers = {
    ...(fromRequest ? headersToRecord(fromRequest.headers) : {}),
    ...headersToRecord(init?.headers),
  };
  const body = await bodyToBytes(init?.body ?? fromRequest?.body ?? undefined);
  const signal = init?.signal ?? fromRequest?.signal ?? undefined;

  let request: NormalizedRequest = { url, method, headers, body, signal };

  for (let redirectCount = 0; ; redirectCount++) {
    const response = await singleRequest(request);
    const location =
      REDIRECT_STATUSES.has(response.statusCode) ? response.headers.get("location") : undefined;

    if (!location || redirectCount >= MAX_REDIRECTS) return response.toResponse();

    // Drain/close the redirect body so the socket returns to the pool.
    response.res.resume();

    // fetch "follow" semantics: 301/302/303 downgrade POST to GET; 307/308
    // preserve method and body. Relative Location resolves against the
    // current URL.
    let nextMethod = request.method;
    let nextBody = request.body;
    if ((response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303) && nextMethod === "POST") {
      nextMethod = "GET";
      nextBody = undefined;
    }
    request = {
      url: new URL(location, request.url).toString(),
      method: nextMethod,
      headers: { ...request.headers },
      body: nextBody,
      signal: request.signal,
    };
    if (nextBody === undefined) delete request.headers["content-length"];
  }
}
