/**
 * Tests for src/streaming-fetch.ts — run with: node scripts/test-streaming-fetch.mjs
 * (Node >= 22.18 strips the TS types from the imported .ts file.)
 */

import { createServer } from "node:http";
import { setTimeout as originalSetTimeout } from "node:timers";

const { nodeHttpFetch } = await import("../src/streaming-fetch.ts");

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => originalSetTimeout(r, ms));

// ---------------------------------------------------------------------------
// Test server
// ---------------------------------------------------------------------------

const seen = []; // { method, url, headers, body } for every request received

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });

  if (req.url === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream", "x-trace": "a, b" });
    for (let i = 0; i < 5; i++) {
      res.write(`data: token-${i}\n\n`);
      await sleep(80);
    }
    res.end();
    return;
  }
  if (req.url === "/no-end") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    // Keep the socket open; client must abort.
    req.on("aborted", () => seen.push({ aborted: true }));
    return;
  }
  if (req.url === "/echo") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ gotBody: seen.at(-1).body, gotXTest: req.headers["x-test"] ?? null }));
    return;
  }
  if (req.url === "/redirect") {
    res.writeHead(302, { location: "/echo" });
    res.end("redirect body (should be drained, not returned)");
    return;
  }
  if (req.url === "/redirect-loop") {
    res.writeHead(302, { location: "/redirect-loop" });
    res.end();
    return;
  }
  if (req.url === "/status") {
    res.writeHead(404, { "content-type": "text/plain" }, "custom-not-found");
    res.end("nope");
    return;
  }
  if (req.url === "/setcookie") {
    res.writeHead(200, { "set-cookie": ["a=1; Path=/", "b=2; Path=/"] });
    res.end("ok");
    return;
  }
  res.writeHead(500);
  res.end("unhandled");
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// 1. Incremental SSE delivery (the actual bug being fixed)
// ---------------------------------------------------------------------------
{
  const t0 = Date.now();
  const res = await nodeHttpFetch(`${base}/sse`, { method: "GET" });
  check("sse: status 200", res.status === 200, String(res.status));
  check("sse: content-type header", res.headers.get("content-type") === "text/event-stream");
  check("sse: multi-value header joined", res.headers.get("x-trace") === "a, b");

  const arrivals = [];
  let text = "";
  for await (const chunk of res.body) {
    arrivals.push(Date.now() - t0);
    text += new TextDecoder().decode(chunk, { stream: true });
  }
  check("sse: all tokens received", text.split("data: "). length === 6, JSON.stringify(text));
  const spread = arrivals.at(-1) - arrivals[0];
  check("sse: streamed incrementally (spread >= 240ms)", spread >= 240, `spread=${spread}ms, arrivals=${JSON.stringify(arrivals)}`);
}

// ---------------------------------------------------------------------------
// 2. Async-iterator path on Response.body (OpenAI SDK style)
// ---------------------------------------------------------------------------
{
  const res = await nodeHttpFetch(`${base}/sse`);
  const reader = res.body.getReader();
  const first = await reader.read();
  check("reader: first chunk is Uint8Array", first.value instanceof Uint8Array);
  await reader.cancel("walk-away");
  check("reader: cancel resolves", true);
}

// ---------------------------------------------------------------------------
// 3. POST with string body + custom headers
// ---------------------------------------------------------------------------
{
  const res = await nodeHttpFetch(`${base}/echo`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test": "yes", authorization: "Bearer abc" },
    body: JSON.stringify({ hello: "world" }),
  });
  const json = await res.json();
  check("post: body sent verbatim", json.gotBody === JSON.stringify({ hello: "world" }), json.gotBody);
  check("post: custom header sent", json.gotXTest === "yes");
  const sent = seen.find((r) => r.url === "/echo" && r.method === "POST");
  check("post: content-length set", sent?.headers["content-length"] === String(sent.body.length), sent?.headers["content-length"]);
  check("post: authorization sent", sent?.headers["authorization"] === "Bearer abc");
}

// ---------------------------------------------------------------------------
// 4. Headers-instance init + Request-like inputs
// ---------------------------------------------------------------------------
{
  const res = await nodeHttpFetch(new URL(`${base}/echo`), {
    method: "POST",
    headers: new Headers({ "x-test": "from-headers" }),
    body: "ping",
  });
  const json = await res.json();
  check("URL input + Headers init", json.gotBody === "ping" && json.gotXTest === "from-headers", JSON.stringify(json));
}
{
  const req = new Request(`${base}/echo`, { method: "POST", headers: { "x-test": "from-request" }, body: "pong" });
  const res = await nodeHttpFetch(req);
  const json = await res.json();
  check("Request input", json.gotBody === "pong" && json.gotXTest === "from-request", JSON.stringify(json));
}

// ---------------------------------------------------------------------------
// 5. Redirects
// ---------------------------------------------------------------------------
{
  const res = await nodeHttpFetch(`${base}/redirect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{\"follow\":true}",
  });
  check("redirect: followed to /echo", res.status === 200);
  const json = await res.json();
  check("redirect: 302 POST downgraded to GET (no body)", json.gotBody === "", JSON.stringify(json));
}
{
  const res = await nodeHttpFetch(`${base}/redirect-loop`);
  check("redirect: loop stops at MAX_REDIRECTS with 302", res.status === 302, String(res.status));
}

// ---------------------------------------------------------------------------
// 6. Status/statusText/error-body
// ---------------------------------------------------------------------------
{
  const res = await nodeHttpFetch(`${base}/status`);
  check("status: 404 passthrough", res.status === 404);
  check("status: statusText passthrough (normalized by Node, same as global fetch)", typeof res.statusText === "string" && res.statusText.length > 0, JSON.stringify(res.statusText));
  check("status: body readable", (await res.text()) === "nope");
  check("status: ok=false", res.ok === false);
}

// ---------------------------------------------------------------------------
// 7. Abort mid-body errors the stream (fetch semantics)
// ---------------------------------------------------------------------------
{
  const controller = new AbortController();
  const res = await nodeHttpFetch(`${base}/no-end`, { signal: controller.signal });
  const reader = res.body.getReader();
  const first = await reader.read();
  check("abort: first chunk received", !first.done && new TextDecoder().decode(first.value).includes("first"));
  controller.abort();
  let errored = false;
  try {
    await reader.read();
  } catch {
    errored = true;
  }
  check("abort: pending read rejects", errored);
}

// ---------------------------------------------------------------------------
// 8. Abort before response rejects the fetch promise
// ---------------------------------------------------------------------------
{
  const controller = new AbortController();
  const pending = nodeHttpFetch(`${base}/no-end`, { signal: controller.signal });
  controller.abort();
  let rejected = false;
  try { await pending; } catch { rejected = true; }
  check("abort: pre-response fetch rejects", rejected);
}

// ---------------------------------------------------------------------------
// 9. Set-cookie preserved as two entries
// ---------------------------------------------------------------------------
{
  const res = await nodeHttpFetch(`${base}/setcookie`);
  const cookies = res.headers.getSetCookie();
  check("headers: set-cookie entries preserved", Array.isArray(cookies) && cookies.length === 2, JSON.stringify(cookies));
}

// ---------------------------------------------------------------------------
// 10. Unsupported protocol rejects
// ---------------------------------------------------------------------------
{
  let rejected = false;
  try { await nodeHttpFetch("ftp://example.com/x"); } catch { rejected = true; }
  check("protocol: non-http rejects", rejected);
}

server.close();
console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
