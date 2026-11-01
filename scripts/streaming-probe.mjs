/**
 * Streaming probe: which HTTP client streams which framing, live or synthetic?
 *
 * Synthetic (default): raw-socket servers write an SSE body piecewise, then
 * HOLD the connection without the body terminator; a buffering client sees
 * nothing until the hold ends.
 *
 * Live:      node framing-matrix.mjs --url URL [--model M] [--key-env ENVVAR]
 *                                   [--header "name=value"]...
 *            POSTs a chat-completions streaming request (OpenAI shape) with
 *            each client and reports per-chunk arrival statistics.
 */

import { createServer } from "node:net";
import { createGzip } from "node:zlib";
const { nodeHttpFetch } = await import(new URL("../src/streaming-fetch.ts", import.meta.url).href);

// npm undici is optional (devDependency) — rows are skipped when absent.
let Client = null; let Agent = null; let undiciFetch = null;
try { ({ Client, Agent, fetch: undiciFetch } = await import("undici")); } catch { }

const GAP = 50;
const HOLD = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Consumers — all record arrival timestamps of body chunks
// ---------------------------------------------------------------------------

function observe() {
  const t0 = Date.now();
  const arrivals = [];
  return {
    feed() { arrivals.push(Date.now() - t0); },
    stats: () => {
      const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
      return {
        count: arrivals.length,
        firstMs: arrivals[0] ?? -1,
        totalMs: arrivals.length ? arrivals.at(-1) : -1,
        maxGap: gaps.length ? Math.max(...gaps) : 0,
      };
    },
  };
}

async function viaGlobalFetch(url, init) {
  const o = observe();
  const res = await fetch(url, init);
  try { for await (const _c of res.body) o.feed(); } catch { o.lastError = true; }
  return o.stats();
}

async function viaUndiciPkgFetch(url, init) {
  const o = observe();
  const res = await undiciFetch(url, init);
  try { for await (const _c of res.body) o.feed(); } catch { o.lastError = true; }
  return o.stats();
}

async function viaUndiciRequest(url, init) {
  const o = observe();
  const client = new Client(new URL(url).origin);
  try {
    const { body } = await client.request({
      path: new URL(url).pathname + new URL(url).search,
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
    });
    await new Promise((resolve) => {
      body.on("data", () => o.feed());
      body.on("end", resolve);
      body.on("error", () => { o.lastError = true; resolve(); });
      body.on("close", resolve);
    });
  } finally {
    await client.close().catch(() => {});
  }
  return o.stats();
}

let dispatcherSupported;
async function viaGlobalFetchDispatcher(url, init) {
  const o = observe();
  const agent = new Agent();
  try {
    const res = await fetch(url, { ...init, dispatcher: agent });
    try { for await (const _c of res.body) o.feed(); } catch { o.lastError = true; }
    dispatcherSupported ??= true;
  } catch (error) {
    const blob = `${String(error?.message ?? error)} ${String(error?.cause?.message ?? error?.cause ?? "")}`;
    if (/dispatcher/iu.test(blob)) dispatcherSupported ??= false;
    throw error;
  } finally {
    await agent.close().catch(() => {});
  }
  return o.stats();
}

async function viaNodeHttpShim(url, init) {
  const o = observe();
  const res = await nodeHttpFetch(url, init);
  try { for await (const _c of res.body) o.feed(); } catch { o.lastError = true; }
  return o.stats();
}

const consumers = {
  "global fetch": viaGlobalFetch,
  "node:http shim": viaNodeHttpShim,
};
if (Agent) consumers["fetch+dispatcher"] = viaGlobalFetchDispatcher;
if (undiciFetch) consumers["undici pkg fetch"] = viaUndiciPkgFetch;
if (Client) consumers["undici Client.request"] = viaUndiciRequest;

function fmt(name, s, verdict) {
  const err = s.lastError ? " (body error)" : "";
  return `${name.padEnd(24)} chunks=${String(s.count).padStart(3)} first=${String(s.firstMs).padStart(5)}ms total=${String(s.totalMs).padStart(5)}ms maxGap=${String(s.maxGap).padStart(5)}ms  ${verdict}${err}`;
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function opt(name) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; }

const liveUrl = opt("url");
if (liveUrl) {
  const key = opt("key-env") ? process.env[opt("key-env")] : undefined;
  const model = opt("model") ?? "probe";
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  if (key) headers.authorization = `Bearer ${key}`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--header" && argv[i + 1]?.includes("=")) {
      const [k, ...rest] = argv[++i].split("=");
      headers[k.toLowerCase()] = rest.join("=");
    }
  }
  const baseInit = {
    method: "POST",
    headers,
    body: JSON.stringify({ model, stream: true, max_tokens: 96, messages: [{ role: "user", content: "Count slowly from 1 to 30, one number per line." }] }),
  };

  console.log(`LIVE PROBE ${liveUrl} (model=${model}) — expect maxGap to be LARGE and count to be LARGE for a truly streaming client\n`);
  const liveConsumers = {
    ...consumers,
    "fetch accept-encoding identity": (url) => viaGlobalFetch(url, { ...baseInit, headers: { ...baseInit.headers, "accept-encoding": "identity" } }),
  };
  for (const [consumerName, consumer] of Object.entries(liveConsumers)) {
    try {
      const s = await consumer(liveUrl, baseInit);
      const streamed = s.count >= 5 && s.maxGap >= 100;
      const lump = s.count <= 2 || (s.totalMs - s.firstMs) < 100 && s.count > 0 && s.maxGap < 100;
      console.log(fmt(consumerName, s, streamed ? "<-- STREAMS" : lump ? "<-- LUMP (single burst)" : ""));
    } catch (error) {
      console.log(`${consumerName.padEnd(24)} ERR ${String(error?.message ?? error).slice(0, 60)}`);
    }
  }
  console.log(`\ndispatcher option on bundled fetch: ${dispatcherSupported === undefined ? "unclear" : dispatcherSupported ? "ACCEPTED" : "REJECTED"}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Synthetic framing scenarios
// ---------------------------------------------------------------------------

const EVENTS = ["alpha", "beta", "gamma", "delta"].map((t) => `data: ${t}\n\n`);
const STREAM_IF = (GAP * EVENTS.length + HOLD) / 2;
function chunkFrame(text) { return `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`; }

const scenarios = {
  "A baseline chunked keep-alive": {
    head: "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n",
    events: (s) => s.write(EVENTS.map(chunkFrame).join("")),
    finish: (s) => { s.write("0\r\n\r\n"); },
  },
  "B Content-Length + Transfer-Encoding dup": {
    head: `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(EVENTS.join(""))}\r\nTransfer-Encoding: chunked\r\n\r\n`,
    events: (s) => s.write(EVENTS.map(chunkFrame).join("")),
    finish: (s) => { s.write("0\r\n\r\n"); },
  },
  "C EOF framing (Connection: close)": {
    head: "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
    events: (s) => s.write(EVENTS.join("")),
    finish: (s) => { s.end(); },
  },
  "D chunked + gzip (per-event flush, trailer after hold)": {
    head: "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n",
    events: async (s) => {
      const gz = createGzip();
      const pending = [];
      gz.on("data", (c) => pending.push(c));
      for (const e of EVENTS) {
        gz.write(e);
        gz.flush();
        await sleep(GAP);
        while (pending.length) {
          const c = pending.shift();
          s.write(`${Buffer.byteLength(c).toString(16)}\r\n`); s.write(c); s.write("\r\n");
        }
      }
      s._gz = gz;
    },
    finish: (s) => {
      const trailer = [];
      s._gz.on("data", (c) => trailer.push(c));
      s._gz.end();
      setImmediate(() => {
        const c = Buffer.concat(trailer);
        s.write(`${Buffer.byteLength(c).toString(16)}\r\n`); s.write(c); s.write("\r\n0\r\n\r\n");
      });
    },
  },
  "E 103 informational before 200 chunked": {
    pre: "HTTP/1.1 103 Early Data\r\nLink: </style.css>; rel=preload; as=style\r\n\r\n",
    head: "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
    events: (s) => s.write(EVENTS.map(chunkFrame).join("")),
    finish: (s) => { s.write("0\r\n\r\n"); },
  },
  "F duplicated Transfer-Encoding headers": {
    head: "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n",
    events: (s) => s.write(EVENTS.map(chunkFrame).join("")),
    finish: (s) => { s.write("0\r\n\r\n"); },
  },
  "G odd casing: Transfer-Encoding: Chunked": {
    head: "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: Chunked\r\n\r\n",
    events: (s) => s.write(EVENTS.map(chunkFrame).join("")),
    finish: (s) => { s.write("0\r\n\r\n"); },
  },
  "H chunked, trailers declared (trailer after hold)": {
    head: "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked, trailers\r\n\r\n",
    events: (s) => s.write(EVENTS.map(chunkFrame).join("")),
    finish: (s) => { s.write("0\r\nx-checksum: deadbeef\r\n\r\n"); },
  },
  "I micro-chunks (1 byte per chunk frame)": {
    head: "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
    events: async (s) => {
      for (const ch of EVENTS.join("")) {
        s.write(`${Buffer.byteLength(ch).toString(16)}\r\n${ch}\r\n`);
        await sleep(12);
      }
    },
    finish: (s) => { s.write("0\r\n\r\n"); },
  },
};

// ---------------------------------------------------------------------------
// Synthetic runner
// ---------------------------------------------------------------------------

console.log(`Node ${process.version} | npm undici: ${undiciFetch ? "loaded" : "not installed (npm i undici to enable extra rows)"} | STREAM if first chunk < ${STREAM_IF}ms\n`);
const CONSUMER_TIMEOUT = 6000;

for (const [name, sc] of Object.entries(scenarios)) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", async () => {
      try {
        if (sc.pre) socket.write(sc.pre);
        socket.write(sc.head);
        await sc.events(socket);
        await sleep(HOLD);
        sc.finish(socket);
      } catch { socket.destroy(); }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const cells = [];
  for (const [consumerName, consumer] of Object.entries(consumers)) {
    let cell;
    try {
      const s = await Promise.race([
        consumer(`http://127.0.0.1:${port}/`),
        sleep(CONSUMER_TIMEOUT).then(() => ({ count: 0, firstMs: CONSUMER_TIMEOUT, totalMs: CONSUMER_TIMEOUT, maxGap: 0 })),
      ]);
      cell = `${s.firstMs >= 0 && s.firstMs < STREAM_IF ? "STREAM" : "BUFFER"} ${s.firstMs}ms/${s.count}`;
    } catch (error) {
      cell = `ERR ${String(error?.message ?? error).slice(0, 12)}`;
    }
    cells.push(cell.padStart(14));
    for (const s of sockets) s.destroy();
    await sleep(30);
  }
  console.log(`${name.padEnd(54)} | ${cells.join(" | ")}`);
  server.close();
}

console.log(`\ndispatcher option on bundled fetch: ${dispatcherSupported === undefined ? "unclear" : dispatcherSupported ? "ACCEPTED" : "REJECTED"}`);
