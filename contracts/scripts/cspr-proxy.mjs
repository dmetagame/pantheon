#!/usr/bin/env node
/**
 * Tiny pass-through proxy for the Odra Casper livenet client.
 *
 * Odra 2.7.2 reads CSPR_CLOUD_AUTH_TOKEN but never sends it as a header.
 * cspr.cloud requires the Authorization header for both the RPC node and the
 * SSE events stream — so we proxy locally and inject it.
 *
 * Listens on localhost:7777:
 *   POST /rpc      -> https://node.testnet.cspr.cloud/rpc
 *   GET  /events   -> https://node-sse.testnet.cspr.cloud/events/main (SSE)
 *
 * Usage (separate terminal):
 *   node scripts/cspr-proxy.mjs
 */
import http from "node:http";
import https from "node:https";

const PORT = parseInt(process.env.PROXY_PORT ?? "7777", 10);
const AUTH = process.env.CSPR_CLOUD_AUTH_TOKEN;
if (!AUTH) {
  console.error("CSPR_CLOUD_AUTH_TOKEN is required.");
  process.exit(1);
}

const TARGETS = {
  "/rpc": { host: "node.testnet.cspr.cloud", path: "/rpc", method: "POST" },
  "/events": {
    host: "node-sse.testnet.cspr.cloud",
    path: "/events/main",
    method: "GET",
  },
};

const server = http.createServer((clientReq, clientRes) => {
  const target = TARGETS[clientReq.url];
  if (!target) {
    clientRes.writeHead(404).end(`unknown route: ${clientReq.url}`);
    return;
  }

  const upstream = https.request(
    {
      host: target.host,
      path: target.path,
      method: target.method,
      headers: {
        ...filteredHeaders(clientReq.headers),
        host: target.host,
        authorization: AUTH,
      },
    },
    (upRes) => {
      clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(clientRes);
    },
  );

  upstream.on("error", (err) => {
    console.error("[proxy] upstream error", err.message);
    if (!clientRes.headersSent) clientRes.writeHead(502);
    clientRes.end(`upstream error: ${err.message}`);
  });

  clientReq.pipe(upstream);

  const logTime = new Date().toISOString().slice(11, 19);
  console.log(`[${logTime}] ${clientReq.method} ${clientReq.url} -> ${target.host}${target.path}`);
});

function filteredHeaders(headers) {
  const out = { ...headers };
  delete out.authorization;
  delete out.host;
  return out;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`cspr-proxy listening at http://127.0.0.1:${PORT}`);
  console.log(`  POST /rpc    -> https://node.testnet.cspr.cloud/rpc`);
  console.log(`  GET  /events -> https://node-sse.testnet.cspr.cloud/events/main`);
});
