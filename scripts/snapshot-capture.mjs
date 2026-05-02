// scripts/snapshot-capture.mjs
//
// Capture HTTP responses from the running cryptoquant-ai server,
// normalize them to "shape skeletons" (replace leaf values with type tags),
// and emit a single JSON document to stdout for snapshot comparison.
//
// Usage:
//   node scripts/snapshot-capture.mjs > snapshots/baseline.json
//   node scripts/snapshot-capture.mjs > /tmp/current.json
//
// Behavior:
// - If 127.0.0.1:3000 is already listening, hit it directly.
// - Otherwise, spawn `npm run dev`, wait for "Listening on http", capture, then kill.
// - For each endpoint: 1 attempt + 1 retry on failure; on second failure record
//   "<endpoint-error: status message>" and continue.

import "dotenv/config";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";

const HOST = "127.0.0.1";
const PORT = 3000;
const BASE = `http://${HOST}:${PORT}`;
const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
const REQUEST_TIMEOUT_MS = 15000;

// --- Endpoint list ---
const ENDPOINTS = [
  // Auth/config/settings
  ["GET",  "/api/auth/session"],
  ["GET",  "/api/config/status"],
  ["GET",  "/api/settings/exchange"],
  // Audit/security/risk/orders
  ["GET",  "/api/audit/summary"],
  ["GET",  "/api/security/events"],
  ["GET",  "/api/orders/lifecycle"],
  ["GET",  "/api/risk/state"],
  // Auto-trading
  ["GET",  "/api/auto-trading/status"],
  ["GET",  "/api/auto-trading/config"],
  ["GET",  "/api/auto-trading/logs?limit=5"],
  ["GET",  "/api/auto-trading/cycles?limit=5"],
  ["GET",  "/api/auto-trading/traces?limit=5"],
  // Trades/signals/shadow
  ["GET",  "/api/trades"],
  ["GET",  "/api/strategy/signals"],
  ["GET",  "/api/shadow/orders"],
  ["GET",  "/api/shadow/summary"],
  // Portfolio/research/macro
  ["GET",  "/api/portfolio/returns"],
  ["GET",  "/api/research/weekly"],
  ["GET",  "/api/macro"],
  // OKX (private endpoints expected to 400 without creds — that error shape is captured)
  ["POST", "/api/okx/balance",        {}],
  ["GET",  "/api/okx/ticker/BTC-USDT-SWAP"],
  ["GET",  "/api/okx/orderbook/BTC-USDT-SWAP"],
  ["GET",  "/api/okx/tickers"],
  ["GET",  "/api/okx/ohlcv/BTC-USDT-SWAP?t=1h&limit=5"],
  ["GET",  "/api/okx/funding/BTC-USDT-SWAP"],
  ["POST", "/api/okx/positions",      {}],
  ["POST", "/api/okx/history",        {}],
  ["POST", "/api/okx/realized-pnl",   {}],
  // Binance
  ["POST", "/api/binance/balance",      {}],
  ["GET",  "/api/binance/ticker/BTC-USDT-SWAP"],
  ["GET",  "/api/binance/orderbook/BTC-USDT-SWAP"],
  ["GET",  "/api/binance/tickers"],
  ["GET",  "/api/binance/ohlcv/BTC-USDT-SWAP?t=1h&limit=5"],
  ["GET",  "/api/binance/funding/BTC-USDT-SWAP"],
  ["POST", "/api/binance/positions",    {}],
  ["POST", "/api/binance/history",      {}],
  ["POST", "/api/binance/realized-pnl", {}],
];
// NOT captured (intentionally): order placement, ai/analyze, notify, auto-trading start/stop/run-once.

// --- Port check + spawn helper ---
async function isPortListening() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: HOST, port: PORT, timeout: 1000 });
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error",   () => { resolve(false); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

async function spawnDevServer() {
  const child = spawn("npm", ["run", "dev"], {
    shell: true, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes("Listening on http")) {
        child.stdout.off("data", onData);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => { buf += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!buf.includes("Listening on http")) {
        reject(new Error(`dev server exited (code=${code}) before listening:\n${buf.slice(-400)}`));
      }
    });
    setTimeout(() => reject(new Error("dev server startup timeout (60s)")), 60000);
  });
}

// --- Login + fetch ---
async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  const j = await r.json();
  return j.token;
}

async function callEndpoint(method, path, body, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

async function callWithRetry(method, path, body, token) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await callEndpoint(method, path, body, token);
    } catch (e) {
      if (attempt === 1) {
        return { status: 0, body: `<endpoint-error: ${e.message}>` };
      }
      await delay(1000);
    }
  }
}

// --- Normalization ---
function shapeOf(value, keyPath = "") {
  if (value === null) return "<null>";
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const sample = shapeOf(value[0], `${keyPath}[]`);
    return [`<array len=${value.length}>`, sample];
  }
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = shapeOf(value[k], `${keyPath}.${k}`);
    }
    return out;
  }
  // Primitive leaf
  // Exception: error message strings preserve content (API contract)
  if (keyPath.endsWith(".error") && typeof value === "string") return value;
  if (typeof value === "string")  return "<string>";
  if (typeof value === "number")  return "<number>";
  if (typeof value === "boolean") return "<boolean>";
  return `<${typeof value}>`;
}

// --- Main ---
async function main() {
  const portWasOpen = await isPortListening();
  let child = null;
  if (!portWasOpen) {
    process.stderr.write("[snapshot] dev server not running; spawning...\n");
    child = await spawnDevServer();
    process.stderr.write("[snapshot] dev server up\n");
  }

  try {
    const token = await login();
    const results = {};
    for (const [method, path, body] of ENDPOINTS) {
      process.stderr.write(`[snapshot] ${method} ${path} ...\n`);
      const r = await callWithRetry(method, path, body, token);
      const key = `${method} ${path}`;
      results[key] = {
        status: r.status,
        body: shapeOf(r.body),
      };
    }
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  } finally {
    if (child) {
      child.kill("SIGTERM");
      await delay(500);
    }
  }
}

main().catch((e) => {
  process.stderr.write(`[snapshot] FATAL: ${e.stack || e.message}\n`);
  process.exit(2);
});
