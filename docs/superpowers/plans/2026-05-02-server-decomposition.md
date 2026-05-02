# server.ts Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the 7310-line `server.ts` monolith into ~30 focused files under `src-server/` with zero behavior change, validated by golden snapshot regression tests.

**Architecture:** Feature-grouped folders (`exchanges/`, `auto-trading/`, `routes/`, etc.) plus flat `core/` for shared utilities. Each module exposes state via getter/setter functions (no exported mutable singletons). Routes register via `register*Routes(app)` functions called explicitly from the new minimal `server.ts` entry point. A snapshot test (Phase 0) captures the response shape of ~30 endpoints; every phase must produce a clean diff before proceeding.

**Tech Stack:** TypeScript, Express 4, ccxt 4.5, SQLite (node:sqlite), tsx, Vitest, Vite. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-02-server-decomposition-design.md`

---

## File Structure (target)

```
src-server/
├── core/
│   ├── proxy.ts          retry.ts       cache.ts
│   ├── files.ts          crypto.ts      env.ts          sleep.ts
├── exchanges/
│   ├── factory.ts        symbols.ts     connectivity.ts
│   ├── okx/
│   │   ├── api.ts        normalize.ts   markets.ts      errors.ts      orders.ts
│   └── impls.ts
├── credentials/
│   ├── store.ts          resolve.ts     admin-password.ts
├── stores/
│   ├── audit.ts          operations.ts  risk.ts         trading-db.ts
├── auto-trading/
│   ├── types.ts          preflight.ts   tp-manager.ts   engine.ts
├── strategies/    (TBD per Phase 9 discovery)
├── backtest/      (TBD per Phase 9 discovery)
├── ai/
│   └── analyze.ts
├── routes/
│   ├── auth.ts           config.ts      settings.ts     audit.ts
│   ├── exchanges.ts      auto-trading.ts                trades.ts
│   ├── portfolio.ts      backtest.ts    ai.ts           notify.ts
├── middleware/
│   └── auth.ts
└── server.ts             (target ≤ 200 lines, hard cap 300)
```

**Old `server.ts`** (at repo root) stays as the entry tsx loads — it just re-exports from `src-server/server.ts` until the very last task swaps the entry point.

---

## Conventions for ALL Extraction Tasks

These apply to every task in Phase 1-11. Read once, follow throughout.

### Extraction pattern

For each file extraction:
1. Create the new file with extracted code, all needed imports added, and explicit `export` keywords on the public API
2. In `server.ts`, **delete** the original lines and add an `import { ... } from "./src-server/<path>"` line near the top
3. If the extracted code references file-level closure variables, those variables must EITHER be passed as parameters OR also extracted into the same module
4. If the extracted code mutates module-level state (e.g. updates `auditStore`), expose getters/setters from the new module instead of the variable directly. Pattern:

```ts
// In new module: stores/audit.ts
let auditStore: AuditStore = { ... };

export function getAuditStore(): AuditStore { return auditStore; }
export function setAuditStore(next: AuditStore) { auditStore = next; }
export function addToAudit<T>(list: T[], item: T, limit = 100) { ... }
export async function loadAuditStore(): Promise<void> { auditStore = await read(...); }
export async function persistAuditStore(): Promise<void> { await write(...); }
```

`server.ts` then calls `addToAudit(getAuditStore().aiSnapshots, ...)` — never reads `auditStore` directly.

### Per-task validation (run after EVERY task)

```bash
npm run lint                           # tsc --noEmit must exit 0
```

Lint clean is required for every commit. If lint fails, fix in the same task before committing.

### Per-phase validation (run after the last task of each phase)

```bash
npm run lint           && \
npx vitest run         && \
npm run build          && \
node scripts/snapshot-capture.mjs > /tmp/current.json && \
node scripts/snapshot-diff.mjs snapshots/baseline.json /tmp/current.json
```

All five MUST exit 0. If snapshot diff is non-empty, the phase is NOT complete — fix the divergence (almost always means an accidental behavior change in the extraction) and re-run.

### Commit messages

Per-task commits use this convention:
```
server: extract <module> to src-server/<path>
```

Per-phase verification commits (if any small fixes):
```
server: phase <N> verification fixes
```

### Git identity (no global config — use per-commit flags)

```bash
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "..."
```

### Branch

This plan executes on branch **`feat/server-decomposition`** (already created off `feat/binance-integration` tip).

---

## Phase 0: Snapshot Baseline

The snapshot system is the safety net for the entire refactor. Build it carefully and verify it works before extracting anything.

### Task 0.1: Create snapshot-capture.mjs

**Files:**
- Create: `scripts/snapshot-capture.mjs`

- [ ] **Step 1: Write the script**

```js
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
    // Skeletonize each element; record array length in a marker.
    if (value.length === 0) return [];
    const sample = shapeOf(value[0], `${keyPath}[]`);
    // Length descriptor: include it as the FIRST element so diff sees it.
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
      // Give it a moment to release the port
      await delay(500);
    }
  }
}

main().catch((e) => {
  process.stderr.write(`[snapshot] FATAL: ${e.stack || e.message}\n`);
  process.exit(2);
});
```

- [ ] **Step 2: Verify the script syntax loads**

Run: `node --check scripts/snapshot-capture.mjs`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add scripts/snapshot-capture.mjs
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "snapshot: add capture script (shape skeleton + dev-server auto-spawn)"
```

---

### Task 0.2: Create snapshot-diff.mjs

**Files:**
- Create: `scripts/snapshot-diff.mjs`

- [ ] **Step 1: Write the script**

```js
// scripts/snapshot-diff.mjs
//
// Compare two snapshot JSON files (baseline vs current).
// Exit 0 if shapes are identical; exit 1 with a human-readable diff otherwise.
//
// Tolerance:
// - Array length descriptors "<array len=N>" tolerate ±1 (market data drift).
// - All other differences are strict (key added/removed, type changed, error message changed).
//
// Usage:
//   node scripts/snapshot-diff.mjs snapshots/baseline.json /tmp/current.json

import { readFileSync } from "node:fs";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  process.stderr.write("usage: snapshot-diff.mjs <baseline.json> <current.json>\n");
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(a, "utf-8"));
const current  = JSON.parse(readFileSync(b, "utf-8"));

const diffs = [];

function pushDiff(path, msg) { diffs.push(`${path}: ${msg}`); }

function arrayLenTag(s) {
  const m = typeof s === "string" && s.match(/^<array len=(\d+)>$/);
  return m ? Number(m[1]) : null;
}

function compare(a, b, path) {
  // Both null
  if (a === null && b === null) return;
  if (a === null) return pushDiff(path, `null vs ${typeof b}`);
  if (b === null) return pushDiff(path, `${typeof a} vs null`);

  // Both arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    // Empty array vs non-empty
    if (a.length === 0 && b.length === 0) return;
    if (a.length === 0 || b.length === 0) {
      return pushDiff(path, `array length mismatch: ${a.length} vs ${b.length}`);
    }
    // First element should be the length descriptor "<array len=N>"
    const aLen = arrayLenTag(a[0]);
    const bLen = arrayLenTag(b[0]);
    if (aLen !== null && bLen !== null) {
      if (Math.abs(aLen - bLen) > 1) {
        pushDiff(path, `array length drift > 1: ${aLen} vs ${bLen}`);
      }
      // Compare sample element shape
      compare(a[1], b[1], `${path}[]`);
    } else {
      // Fallback: compare element-by-element
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) compare(a[i], b[i], `${path}[${i}]`);
      if (a.length !== b.length) pushDiff(path, `array length: ${a.length} vs ${b.length}`);
    }
    return;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    return pushDiff(path, `type mismatch: ${Array.isArray(a) ? "array" : typeof a} vs ${Array.isArray(b) ? "array" : typeof b}`);
  }

  // Both objects
  if (typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    const all = new Set([...keysA, ...keysB]);
    for (const k of all) {
      if (!(k in a)) pushDiff(`${path}.${k}`, `key added`);
      else if (!(k in b)) pushDiff(`${path}.${k}`, `key removed`);
      else compare(a[k], b[k], `${path}.${k}`);
    }
    return;
  }

  // Primitives (strings as type tags or error messages)
  if (a !== b) {
    pushDiff(path, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}

compare(baseline, current, "");

if (diffs.length === 0) {
  process.stderr.write(`[snapshot-diff] OK: ${a} ≡ ${b}\n`);
  process.exit(0);
} else {
  process.stderr.write(`[snapshot-diff] ${diffs.length} difference(s) between ${a} and ${b}:\n`);
  for (const d of diffs) process.stdout.write(d + "\n");
  process.exit(1);
}
```

- [ ] **Step 2: Verify the script syntax loads**

Run: `node --check scripts/snapshot-diff.mjs`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add scripts/snapshot-diff.mjs
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "snapshot: add diff script (strict comparison + array drift tolerance)"
```

---

### Task 0.3: Test the snapshot scripts roundtrip

**Files:** none (just verification)

- [ ] **Step 1: Capture two snapshots back-to-back**

Run:
```bash
node scripts/snapshot-capture.mjs > /tmp/snap1.json
node scripts/snapshot-capture.mjs > /tmp/snap2.json
```

Expected: Both succeed (exit 0). Each call takes 30-90 seconds depending on whether dev server needs to spawn.

- [ ] **Step 2: Diff the two captures**

Run: `node scripts/snapshot-diff.mjs /tmp/snap1.json /tmp/snap2.json`
Expected: `[snapshot-diff] OK: /tmp/snap1.json ≡ /tmp/snap2.json` and exit 0.

If non-zero: investigate. Most likely causes:
- Some endpoint has a key that appears/disappears between calls (caching, randomness) — add normalization
- Array length drift > ±1 — increase tolerance for that endpoint
- Some endpoint returned `<endpoint-error: ...>` once and a real response once — fix flakiness or accept

If you needed to fix the script, repeat Steps 1+2 until clean.

- [ ] **Step 3: Verify shape JSON is reasonable (manual sanity check)**

Run: `head -200 /tmp/snap1.json`

Confirm:
- Top-level keys are the endpoints from `ENDPOINTS` list
- Each value has `status` (number) and `body` (object/array/string)
- Leaf values look like `<string>`, `<number>`, `<boolean>`, `<null>`
- Nested objects preserve real key names
- `error` strings are preserved verbatim where present (e.g. `"Missing OKX credentials"`)

If the shape looks wrong (e.g., raw values leaking through), fix `shapeOf()` and re-run.

---

### Task 0.4: Capture and commit baseline

**Files:**
- Create: `snapshots/baseline.json`

- [ ] **Step 1: Capture the baseline**

Run: `mkdir -p snapshots && node scripts/snapshot-capture.mjs > snapshots/baseline.json`

Expected: file created, ~50-200 KB, contains JSON for all endpoints.

- [ ] **Step 2: Verify baseline is non-trivial**

Run: `wc -l snapshots/baseline.json`
Expected: at least several hundred lines (each endpoint contributes 5-30 lines).

- [ ] **Step 3: Commit**

```bash
git add snapshots/baseline.json
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "snapshot: capture baseline before server.ts decomposition"
```

---

## Phase 1: Extract `core/` utilities

These are leaf modules with no feature dependencies. Order: most independent first.

For ALL Phase 1 tasks, the per-task validation is `npm run lint` (must exit 0). The full per-phase validation runs at Task 1.8.

### Task 1.1: Extract `core/sleep.ts`

**Files:**
- Create: `src-server/core/sleep.ts`
- Modify: `server.ts` (remove the `function sleep` definition at line ~358; add import)

- [ ] **Step 1: Read the current `sleep` function**

Run: `grep -n "function sleep" server.ts`
Expected output: one line, around 358.

Read 3 lines starting at that line to get the function body.

- [ ] **Step 2: Create the new file**

```ts
// src-server/core/sleep.ts
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 3: Modify `server.ts`**

- Delete the original `function sleep(...)` block.
- Add this import near the top (after the ccxt/express imports):

```ts
import { sleep } from "./src-server/core/sleep";
```

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.ts src-server/core/sleep.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: extract sleep to src-server/core/sleep.ts"
```

---

### Task 1.2: Extract `core/files.ts`

**Files:**
- Create: `src-server/core/files.ts`
- Modify: `server.ts`

**Symbols to extract:** `writeFileAtomic`, `fileWriteQueue` (the Map used by writeFileAtomic for serialization)

- [ ] **Step 1: Find the symbols**

Run: `grep -nE "fileWriteQueue|writeFileAtomic" server.ts`
Note all matches. Locate the function definition and the Map declaration.

- [ ] **Step 2: Create the new file**

```ts
// src-server/core/files.ts
import { promises as fsp } from "node:fs";

const fileWriteQueue = new Map<string, Promise<void>>();

export async function writeFileAtomic(
  filePath: string,
  contents: string,
  options?: { mode?: number }
): Promise<void> {
  // Serialize writes to the same path so concurrent persists don't interleave.
  const previous = fileWriteQueue.get(filePath) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tempPath, contents, options);
    await fsp.rename(tempPath, filePath);
  });
  fileWriteQueue.set(filePath, next);
  try {
    await next;
  } finally {
    if (fileWriteQueue.get(filePath) === next) {
      fileWriteQueue.delete(filePath);
    }
  }
}
```

(Adjust the body if the actual implementation in `server.ts` differs — preserve current behavior exactly.)

- [ ] **Step 3: Modify `server.ts`**

- Delete the original `fileWriteQueue` Map declaration AND the `writeFileAtomic` function.
- Add import:

```ts
import { writeFileAtomic } from "./src-server/core/files";
```

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.ts src-server/core/files.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: extract writeFileAtomic to src-server/core/files.ts"
```

---

### Task 1.3: Extract `core/crypto.ts`

**Symbols to extract:** `hashSecret`, `timingSafeEqualString`

- [ ] **Step 1: Find the symbols**

Run: `grep -nE "function hashSecret|function timingSafeEqualString" server.ts`
Read each function's body.

- [ ] **Step 2: Create `src-server/core/crypto.ts`**

```ts
// src-server/core/crypto.ts
import crypto from "node:crypto";

export function hashSecret(value: string): string {
  return crypto.createHash("sha256").update(String(value), "utf-8").digest("hex");
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
```

(Adjust if actual implementation differs.)

- [ ] **Step 3: Modify `server.ts`**

- Delete the original `hashSecret` and `timingSafeEqualString` functions.
- Add import:

```ts
import { hashSecret, timingSafeEqualString } from "./src-server/core/crypto";
```

- [ ] **Step 4: Lint** — `npm run lint` must exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.ts src-server/core/crypto.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: extract hashSecret + timingSafeEqualString to src-server/core/crypto.ts"
```

---

### Task 1.4: Extract `core/env.ts`

**Symbols to extract:** `envText`, `hasText`, `mergeText` (the env-fallback and string utility helpers)

- [ ] **Step 1: Find the symbols**

Run: `grep -nE "function envText|function hasText|function mergeText" server.ts`

- [ ] **Step 2: Create `src-server/core/env.ts`**

```ts
// src-server/core/env.ts
//
// Tiny env + string helpers used across the codebase.

export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function envText(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (hasText(v)) return v.trim();
  }
  return "";
}

export function mergeText<T extends Record<string, any>>(
  current: T | undefined | null,
  next: Partial<T>
): T {
  const merged = { ...(current || {}) } as T;
  for (const [key, value] of Object.entries(next)) {
    if (hasText(value)) {
      (merged as any)[key] = (value as string).trim();
    }
  }
  return merged;
}
```

(Match actual signatures observed in `server.ts`; adjust if any.)

- [ ] **Step 3: Modify `server.ts`** — delete the originals, add import:

```ts
import { envText, hasText, mergeText } from "./src-server/core/env";
```

- [ ] **Step 4: Lint** — must exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.ts src-server/core/env.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: extract envText/hasText/mergeText to src-server/core/env.ts"
```

---

### Task 1.5: Extract `core/retry.ts`

**Symbols to extract:** `retry`, `withAutoTradingDataRetry` (if in same retry helper section)

- [ ] **Step 1: Find** — `grep -nE "function retry|function withAutoTradingDataRetry" server.ts`

- [ ] **Step 2: Create `src-server/core/retry.ts`**

Copy the function bodies verbatim. Keep both functions in this one file since they're closely related.

```ts
// src-server/core/retry.ts
import { sleep } from "./sleep";

export async function retry<T>(
  fn: () => Promise<T>,
  retries = 3,
  delay = 1000
): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    if (retries <= 0) throw error;
    if (error.message.includes("Insufficient funds") || error.message.includes("Invalid order")) {
      throw error;
    }
    console.warn(`Operation failed, retrying... (${retries} left). Error: ${error.message}`);
    await sleep(delay);
    return retry(fn, retries - 1, delay * 2);
  }
}

// withAutoTradingDataRetry: if its body is in server.ts, copy it verbatim here.
// If it depends on functions not yet extracted (e.g. exchange connectivity helpers),
// move only `retry` for now and leave `withAutoTradingDataRetry` in server.ts; extract
// it later in Phase 4 (after exchanges/connectivity is available).
```

If `withAutoTradingDataRetry` references symbols still in `server.ts`, extract only `retry` in this task and add `withAutoTradingDataRetry` extraction to Phase 4.

- [ ] **Step 3: Modify `server.ts`** — delete `retry`, add import:

```ts
import { retry } from "./src-server/core/retry";
```

- [ ] **Step 4: Lint** — must exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.ts src-server/core/retry.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: extract retry to src-server/core/retry.ts"
```

---

### Task 1.6: Extract `core/cache.ts`

**Symbols to extract:** `cachedPublicMarket`, plus the internal Map it uses for cache state

- [ ] **Step 1: Find** — `grep -nE "function cachedPublicMarket|publicMarketCache" server.ts`

- [ ] **Step 2: Create `src-server/core/cache.ts`**

```ts
// src-server/core/cache.ts

type CacheEntry = { value: any; expiresAt: number };
const publicMarketCache = new Map<string, CacheEntry>();

export async function cachedPublicMarket<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const cached = publicMarketCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }
  const value = await fetcher();
  publicMarketCache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}
```

(Match actual implementation.)

- [ ] **Step 3: Modify `server.ts`** — delete original, add import:

```ts
import { cachedPublicMarket } from "./src-server/core/cache";
```

- [ ] **Step 4: Lint** — must exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.ts src-server/core/cache.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: extract cachedPublicMarket to src-server/core/cache.ts"
```

---

### Task 1.7: Extract `core/proxy.ts`

The proxy module is the largest in `core/` (~150 lines). Many symbols.

**Symbols to extract:**
- `EXCHANGE_PROXY_URL`, `EXCHANGE_PROXY_MATCH_TOKENS` — module-level constants (move them as exported `const`)
- `redactProxyUrlForStatus`
- `getExchangeProxyStatus` (returns `ExchangeProxyStatus` type — also extract the type)
- `applyExchangeProxy`, `clearExchangeProxy`
- `isLocalProxyUrl`, `canConnectToProxy`, `isProxyConnectivityError`
- `disableExchangeProxy`, `restoreExchangeProxy`, `ensureExchangeProxyAvailable`
- `prepareExchange` (preflight wrapper around proxy)
- `runWithExchangeProxyFallback` (wraps an operation, falls back to direct on proxy failure)
- `restoreLocalExchangeProxyIfReachable`
- `exchangeProxyBypassed`, `exchangeProxyAvailability` — module-level mutable state

**Important:** The `disableExchangeProxy`/`restoreExchangeProxy` functions iterate over `publicExchanges` and `privateExchanges` Maps from the exchange-adapter section. Those Maps haven't been extracted yet (Phase 4 task). For Phase 1, the proxy module needs accessor functions for these Maps:

In `server.ts` (still has the Maps), expose:
```ts
export function getPublicExchangesIterable() { return publicExchanges.values(); }
export function getPrivateExchangesIterable() { return privateExchanges.values(); }
```

Then `proxy.ts` imports those from `../../server` (relative path back to root). Yes this is awkward — but it's temporary. In Phase 4, the Maps move into `exchanges/factory.ts` and the proxy module's import will be updated to import from there.

Actually, simpler approach: pass the Maps in via a registration function. Add to `proxy.ts`:

```ts
type ExchangeProvider = () => Iterable<any>;
let publicExchangesProvider: ExchangeProvider = () => [];
let privateExchangesProvider: ExchangeProvider = () => [];

export function registerExchangeProviders(
  publics: ExchangeProvider,
  privates: ExchangeProvider
) {
  publicExchangesProvider = publics;
  privateExchangesProvider = privates;
}
```

Then `disableExchangeProxy`/`restoreExchangeProxy` iterate via these providers. `server.ts` calls `registerExchangeProviders(() => publicExchanges.values(), () => privateExchanges.values())` once at startup.

- [ ] **Step 1: Find all symbols**

Run:
```bash
grep -nE "EXCHANGE_PROXY|exchangeProxy|applyExchangeProxy|clearExchangeProxy|disableExchangeProxy|restoreExchangeProxy|ensureExchangeProxy|prepareExchange|runWithExchangeProxyFallback|restoreLocalExchangeProxy|isLocalProxyUrl|canConnectToProxy|isProxyConnectivityError|redactProxyUrlForStatus|getExchangeProxyStatus|ExchangeProxyStatus" server.ts | head -60
```

Note: there are also reads of `EXCHANGE_PROXY_URL` and the status types in route handlers — those reads will continue to work via the import after extraction.

- [ ] **Step 2: Create `src-server/core/proxy.ts`**

This file will be ~200 lines. Copy the symbol bodies verbatim from `server.ts`. Add the `registerExchangeProviders` function as described above. Export everything that needs to be visible elsewhere.

Use `import { hasText } from "./env"` for the `hasText` helper if needed.

(Skipping full code dump here — copy from `server.ts` verbatim, that's the spec.)

- [ ] **Step 3: Modify `server.ts`**

- Delete all extracted symbols.
- Add import:

```ts
import {
  EXCHANGE_PROXY_URL,
  EXCHANGE_PROXY_MATCH_TOKENS,
  type ExchangeProxyStatus,
  redactProxyUrlForStatus,
  getExchangeProxyStatus,
  applyExchangeProxy,
  clearExchangeProxy,
  isLocalProxyUrl,
  canConnectToProxy,
  isProxyConnectivityError,
  disableExchangeProxy,
  restoreExchangeProxy,
  ensureExchangeProxyAvailable,
  prepareExchange,
  runWithExchangeProxyFallback,
  restoreLocalExchangeProxyIfReachable,
  registerExchangeProviders,
} from "./src-server/core/proxy";
```

- After the `publicExchanges` / `privateExchanges` Map declarations (still in `server.ts`), add:

```ts
registerExchangeProviders(
  () => publicExchanges.values(),
  () => privateExchanges.values()
);
```

- [ ] **Step 4: Lint** — must exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.ts src-server/core/proxy.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: extract proxy management to src-server/core/proxy.ts"
```

---

### Task 1.8: Phase 1 verification

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 2: Vitest**

Run: `npx vitest run`
Expected: all 47 tests pass, exit 0.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Snapshot diff**

Kill any existing dev server first:
```bash
netstat -ano | findstr :3000 | findstr LISTENING
# If any PID listed, kill it:
taskkill //PID <PID> //F
```

Then:
```bash
node scripts/snapshot-capture.mjs > /tmp/current.json
node scripts/snapshot-diff.mjs snapshots/baseline.json /tmp/current.json
```

Expected: exit 0, output `[snapshot-diff] OK: ...`.

If non-zero: the diff lines printed to stdout indicate which endpoints diverged. Fix the divergence (most likely a missed export or an incorrect copy of a function body), then re-run from Step 1.

- [ ] **Step 5: No commit (Phase 1 already committed in tasks 1.1-1.7)**

If you needed fixes during Step 4, those were fixed in their original task's commit (amend or new commit per fix). No separate "verification" commit unless you needed a one-off cleanup.

---

## Phase 2: Extract `credentials/`

### Task 2.1: Extract `credentials/admin-password.ts`

**Symbols to extract:** `adminPasswordHash` loading logic. Find with `grep -n "adminPasswordHash\|LOCAL_ADMIN_PASSWORD_FILE\|ADMIN_PASSWORD" server.ts`.

- [ ] **Step 1: Locate the loader**

The admin password hash is computed once at startup from `ADMIN_PASSWORD` env var or `LOCAL_ADMIN_PASSWORD_FILE`. Find that logic.

- [ ] **Step 2: Create `src-server/credentials/admin-password.ts`**

```ts
// src-server/credentials/admin-password.ts
import { promises as fsp } from "node:fs";
import path from "node:path";
import { hashSecret } from "../core/crypto";
import { hasText, envText } from "../core/env";

const DATA_DIR = path.join(process.cwd(), "data");
const LOCAL_ADMIN_PASSWORD_FILE = path.join(DATA_DIR, ".admin-password");

let adminPasswordHash = "";
let adminUsername = "admin";

export function getAdminUsername(): string { return adminUsername; }
export function getAdminPasswordHash(): string { return adminPasswordHash; }

export async function loadAdminCredentials(): Promise<void> {
  adminUsername = envText("ADMIN_USERNAME") || "admin";
  const fromEnv = envText("ADMIN_PASSWORD");
  if (hasText(fromEnv)) {
    adminPasswordHash = hashSecret(fromEnv);
    return;
  }
  try {
    const fromFile = (await fsp.readFile(LOCAL_ADMIN_PASSWORD_FILE, "utf-8")).trim();
    if (hasText(fromFile)) {
      adminPasswordHash = hashSecret(fromFile);
      return;
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn("[Admin] Failed to read local admin password:", error.message);
    }
  }
  // Default fallback: insecure but allows first-boot.
  adminPasswordHash = hashSecret("admin");
}
```

(If `server.ts`'s actual logic differs — different defaults, generates a random password, etc. — match its behavior exactly.)

- [ ] **Step 3: Modify `server.ts`**

- Delete the original loader logic and the `adminPasswordHash`/`ADMIN_USERNAME` const declarations.
- Add import:

```ts
import {
  loadAdminCredentials,
  getAdminUsername,
  getAdminPasswordHash,
} from "./src-server/credentials/admin-password";
```

- In the `main()`/startup function, ensure `await loadAdminCredentials()` runs before any auth code runs.
- Replace `ADMIN_USERNAME` references with `getAdminUsername()` calls. Replace `adminPasswordHash` reads with `getAdminPasswordHash()`.

- [ ] **Step 4: Lint** — must exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.ts src-server/credentials/admin-password.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: extract admin password loading to src-server/credentials/admin-password.ts"
```

---

### Task 2.2: Extract `credentials/store.ts`

**Symbols to extract:**
- `CredentialStore` type
- `credentialStore` global state
- `loadCredentialStore`, `persistCredentialStore` (or whatever the exact names are)
- `encryptCredentials`, `decryptCredentials`
- `getCredentialKey`, `getCredentialSecret`
- Migration logic (drop `okxDemo`, default `activeExchange`)

- [ ] **Step 1: Find symbols**

```bash
grep -nE "type CredentialStore|credentialStore|loadCredentialStore|persistCredentialStore|encryptCredentials|decryptCredentials|getCredentialKey|getCredentialSecret" server.ts | head
```

- [ ] **Step 2: Create `src-server/credentials/store.ts`**

```ts
// src-server/credentials/store.ts
import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../core/files";
import { hasText, envText } from "../core/env";
import { isExchangeName, type ExchangeName } from "../exchanges/factory";  // forward dep — Phase 4

// IMPORTANT: This file imports from "../exchanges/factory" which will not exist
// until Phase 4. To avoid blocking, define ExchangeName locally HERE, and remove
// the local definition after Phase 4 lands. Until then:
type ExchangeNameLocal = "okx" | "binance";
function isExchangeNameLocal(v: unknown): v is ExchangeNameLocal {
  return v === "okx" || v === "binance";
}

const DATA_DIR = path.join(process.cwd(), "data");
const CREDENTIALS_FILE = path.join(DATA_DIR, "credentials.enc.json");
const LOCAL_SECRET_FILE = path.join(DATA_DIR, ".local-secret");

export type CredentialStore = {
  activeExchange?: ExchangeNameLocal;
  okx?:     { apiKey?: string; secret?: string; password?: string };
  binance?: { apiKey?: string; secret?: string };
  ai?:      { proxyKey?: string; proxyUrl?: string; decisionModel?: string; summaryModel?: string; visionModel?: string };
};

let credentialStore: CredentialStore = {};

export function getCredentialStore(): CredentialStore { return credentialStore; }
export function setCredentialStore(next: CredentialStore) { credentialStore = next; }

export async function getCredentialSecret(): Promise<string> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const configured = process.env.APP_SECRET || process.env.CREDENTIALS_SECRET;
  if (hasText(configured)) return configured;
  try {
    const existing = (await fsp.readFile(LOCAL_SECRET_FILE, "utf-8")).trim();
    if (hasText(existing)) return existing;
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.warn("[Credentials] Failed to read local secret:", error.message);
    }
  }
  const generated = crypto.randomBytes(32).toString("hex");
  await fsp.writeFile(LOCAL_SECRET_FILE, generated, { mode: 0o600 });
  console.warn("[Credentials] APP_SECRET is not set; generated a local development secret under data/.");
  return generated;
}

export async function getCredentialKey(): Promise<Buffer> {
  const secret = await getCredentialSecret();
  return crypto.scryptSync(secret, "cryptoquant-ai-credential-store-v1", 32);
}

export async function encryptCredentials(data: CredentialStore): Promise<any> {
  const key = await getCredentialKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf-8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

export async function decryptCredentials(payload: any): Promise<CredentialStore> {
  const key = await getCredentialKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]);
  const data = JSON.parse(decrypted.toString("utf-8")) as CredentialStore;

  // Schema migration: drop sandbox/demo mode (removed 2026-05).
  if ((data as any).okxDemo) {
    console.warn("[Credentials] migration: dropping legacy okxDemo field");
    delete (data as any).okxDemo;
  }
  if (!data.activeExchange || !isExchangeNameLocal(data.activeExchange)) {
    data.activeExchange = "okx";
  }
  if (!data.binance) data.binance = {};
  return data;
}

export async function loadCredentialStore(): Promise<void> {
  try {
    const raw = await fsp.readFile(CREDENTIALS_FILE, "utf-8");
    const payload = JSON.parse(raw);
    credentialStore = await decryptCredentials(payload);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      credentialStore = { activeExchange: "okx", binance: {} };
      return;
    }
    throw error;
  }
}

export async function persistCredentialStore(): Promise<void> {
  const payload = await encryptCredentials(credentialStore);
  await writeFileAtomic(CREDENTIALS_FILE, JSON.stringify(payload, null, 2));
}
```

(Adapt to actual `server.ts` implementation. The above is reference structure.)

**Note on the Phase 4 forward-dep:** The local `ExchangeNameLocal` is a temporary stub. After Phase 4 introduces `src-server/exchanges/factory.ts` (which exports `ExchangeName` and `isExchangeName`), Task 4.4 (Phase 4 verification) will switch the import. Add a `// TODO Phase 4: import ExchangeName from exchanges/factory` comment.

- [ ] **Step 3: Modify `server.ts`** — delete the originals, add imports:

```ts
import {
  type CredentialStore,
  getCredentialStore,
  setCredentialStore,
  loadCredentialStore,
  persistCredentialStore,
  encryptCredentials,
  decryptCredentials,
} from "./src-server/credentials/store";
```

In `main()`: replace original load logic with `await loadCredentialStore();`.

Replace all `credentialStore.X` reads with `getCredentialStore().X`. (There may be many — use grep to find all and edit each.)

Replace all `credentialStore = ...` writes (if any direct assignments exist) with `setCredentialStore(...)`.

- [ ] **Step 4: Lint** — must exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.ts src-server/credentials/store.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: extract credential store load/persist/encrypt to src-server/credentials/store.ts"
```

---

### Task 2.3: Extract `credentials/resolve.ts`

**Symbols to extract:** `OkxCredentials` type, `hasOkxCredentials`, `resolveOkxCredentials`, `resolveCredentialsFor`, `resolveActiveExchangeName`

- [ ] **Step 1: Find symbols** — grep them.

- [ ] **Step 2: Create `src-server/credentials/resolve.ts`**

Copy these functions verbatim from `server.ts`, replace `credentialStore.X` reads with `getCredentialStore().X`, fix imports.

```ts
// src-server/credentials/resolve.ts
import { hasText, envText } from "../core/env";
import { getCredentialStore } from "./store";

type ExchangeNameLocal = "okx" | "binance";
function isExchangeNameLocal(v: unknown): v is ExchangeNameLocal {
  return v === "okx" || v === "binance";
}

export type OkxCredentials = {
  apiKey: string;
  secret: string;
  password: string;
};

export function hasOkxCredentials(creds: any): boolean {
  return !!creds && hasText(creds.apiKey) && hasText(creds.secret) && hasText(creds.password);
}

export function resolveOkxCredentials(body: any = {}): OkxCredentials | null {
  const stored = getCredentialStore().okx || {};
  const apiKey   = body.apiKey   || stored.apiKey   || envText("OKX_API_KEY");
  const secret   = body.secret   || stored.secret   || envText("OKX_SECRET_KEY");
  const password = body.password || stored.password || envText("OKX_PASSPHRASE", "OKX_PASSWORD", "OKX_PASS");
  if (!hasText(apiKey) || !hasText(secret) || !hasText(password)) return null;
  return { apiKey, secret, password };
}

export function resolveCredentialsFor(name: ExchangeNameLocal, body: any = {}) {
  if (name === "binance") {
    const stored = getCredentialStore().binance || {};
    const apiKey = body.apiKey || stored.apiKey || envText("BINANCE_API_KEY");
    const secret = body.secret || stored.secret || envText("BINANCE_SECRET_KEY");
    if (!hasText(apiKey) || !hasText(secret)) return null;
    return { apiKey, secret, password: undefined as string | undefined };
  }
  return resolveOkxCredentials(body);
}

export function resolveActiveExchangeName(): ExchangeNameLocal {
  const fromStore = getCredentialStore().activeExchange;
  if (isExchangeNameLocal(fromStore)) return fromStore;
  const fromEnv = envText("ACTIVE_EXCHANGE");
  if (isExchangeNameLocal(fromEnv)) return fromEnv;
  return "okx";
}
```

(Same Phase 4 stub note as Task 2.2.)

- [ ] **Step 3: Modify `server.ts`** — delete originals, add import.

```ts
import {
  type OkxCredentials,
  hasOkxCredentials,
  resolveOkxCredentials,
  resolveCredentialsFor,
  resolveActiveExchangeName,
} from "./src-server/credentials/resolve";
```

- [ ] **Step 4: Lint** — must exit 0.

- [ ] **Step 5: Commit**

```bash
git add server.ts src-server/credentials/resolve.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: extract credential resolution to src-server/credentials/resolve.ts"
```

---

### Task 2.4: Phase 2 verification

Run the full per-phase validation suite (lint + vitest + build + snapshot diff). All four must exit 0. If snapshot diff is non-empty, fix and re-run.

---

## Phase 3: Extract `stores/`

For brevity, Phase 3-12 tasks follow the same pattern. Each task:

1. **Find** symbols with `grep -n`
2. **Create** new file under `src-server/<feature>/<name>.ts` with extracted code, getter/setter wrapper for any module-level mutable state, exports
3. **Modify** `server.ts` to delete originals + add imports + replace direct state reads with `getX()` calls
4. **Lint** must exit 0
5. **Commit** with message `server: extract <module> to src-server/<path>`

The plan below specifies WHAT each task extracts, the target file, and any extraction pitfalls. The mechanical steps are the same as Phase 1-2.

### Task 3.1: Extract `stores/audit.ts`

**Symbols:** `STRATEGY_VERSION` const, `auditStore` mutable global, `addToAudit`, `loadAuditStore`, `persistAuditStore`, `AUDIT_FILE` path

**Pattern:**
```ts
let auditStore: AuditStore = { aiSnapshots: [], ... };
export function getAuditStore(): AuditStore { return auditStore; }
export function setAuditStore(next: AuditStore) { auditStore = next; }
export function addToAudit<T>(list: T[], item: T, limit = 100) { ... } // mutates list in place
export async function loadAuditStore() { auditStore = await read(...); }
export async function persistAuditStore() { await write(JSON.stringify(auditStore, null, 2)); }
```

`server.ts`: replace `auditStore.aiSnapshots` reads with `getAuditStore().aiSnapshots`. Replace any direct `auditStore = ...` assignments with `setAuditStore(...)` (rare).

Commit msg: `server: extract audit store to src-server/stores/audit.ts`

### Task 3.2: Extract `stores/operations.ts`

**Symbols:** `OperatorSession` type, `SecurityEvent` type, `OrderLifecycleEvent` type, `appStore` mutable global, `loadAppStore`/`persistAppStore`, `getSession(req)`, `addSecurityEvent`, `addOrderLifecycle`, `APP_STORE_FILE` path, `SESSION_TTL_MS` const

**Pattern:** same as 3.1. Many getters: `getAppStore()`, plus convenience exports for `getSessions()`, `getSecurityEvents()`, `getOrderLifecycle()`.

`getSession(req: express.Request)` is a function — keep it as-is, just import it.

Commit msg: `server: extract operations store (sessions/security/lifecycle) to src-server/stores/operations.ts`

### Task 3.3: Extract `stores/risk.ts`

**Symbols:** `PersistentRiskState` type, risk state global, load/persist functions, kill-switch state.

Use `grep -n "PersistentRiskState\|riskState\|kill_switch\|killSwitch" server.ts` to find.

Commit msg: `server: extract risk state to src-server/stores/risk.ts`

### Task 3.4: Extract `stores/trading-db.ts`

**Symbols:** `TradingDB` (the SQLite wrapper), `TRADING_DB_FILE` path, `recordTrade`, query functions, schema initialization.

This file is likely 200-400 lines. Be thorough. SQLite uses `node:sqlite` (experimental Node feature, hence the warning at startup).

Commit msg: `server: extract SQLite trading DB to src-server/stores/trading-db.ts`

### Task 3.5: Phase 3 verification

Run full validation suite (lint + vitest + build + snapshot diff). All exit 0.

---

## Phase 4: Extract `exchanges/` core (factory + symbols + connectivity)

### Task 4.1: Extract `exchanges/symbols.ts`

**Symbols:** `toCcxtSymbol`, `toOkxSwapInstId`, `toCcxtLikeSwapSymbol`

Pure functions, no state. Easy.

Commit msg: `server: extract symbol converters to src-server/exchanges/symbols.ts`

### Task 4.2: Extract `exchanges/connectivity.ts`

**Symbols:**
- `ExchangeProxyStatus` type (re-exported from proxy module — verify or move)
- `ExchangeConnectivityStatus` type
- `connectivity` mutable state, `getExchangeConnectivityStatus`, `updateExchangeConnectivityStatus`
- `markExchangeConnectivitySuccess`, `markExchangeConnectivityFailure`
- `probeOkxPublicApiForAutoTrading`
- `formatExchangeConnectivityError`, `isExchangeConnectivityFailure`

**Pitfall:** `probeOkxPublicApiForAutoTrading` calls `okxPublicGet` (which is OKX-specific, will be extracted in Phase 5). For now, keep `probeOkxPublicApiForAutoTrading` in `server.ts` and add a `// TODO Phase 5: move to exchanges/connectivity once okxPublicGet is in exchanges/okx/api.ts` comment. Move just the connectivity status state + the format/check helpers in this task.

Commit msg: `server: extract exchange connectivity state to src-server/exchanges/connectivity.ts`

### Task 4.3: Extract `exchanges/factory.ts`

**Symbols:**
- `ExchangeName` type, `VALID_EXCHANGES`, `isExchangeName`
- `getExchangeCtor`, `buildExchangeOptions`
- `publicExchanges` Map, `privateExchanges` Map (move them here)
- `getPublicExchange`, `getPrivateExchange`
- `OKX_AUTO_DATA_REQUEST_TIMEOUT_MS` const (or wherever it's currently defined)

**Pattern:** `publicExchanges` and `privateExchanges` Maps move into this file. Export getters for them so `proxy.ts`'s `registerExchangeProviders` can be called from `server.ts` startup with the moved Maps:

```ts
// In src-server/exchanges/factory.ts
export const publicExchanges = new Map<ExchangeName, any>();
export const privateExchanges = new Map<string, any>();
```

In `server.ts` startup, change:
```ts
// before
registerExchangeProviders(() => publicExchanges.values(), () => privateExchanges.values());
// after
import { publicExchanges, privateExchanges } from "./src-server/exchanges/factory";
registerExchangeProviders(() => publicExchanges.values(), () => privateExchanges.values());
```

**After this task is done:** Update `credentials/store.ts` and `credentials/resolve.ts` to import `ExchangeName` and `isExchangeName` from `../exchanges/factory` (delete the temporary `ExchangeNameLocal` stubs added in Phase 2). Include this import-update edit in THIS task's commit (one commit covers both the new factory file and the cleanup of the Phase 2 stubs).

Commit msg: `server: extract exchange factory to src-server/exchanges/factory.ts; remove Phase 2 ExchangeName stubs`

### Task 4.4: Phase 4 verification

Run full validation. All exit 0. Specifically check that `getCredentialStore().activeExchange` and `resolveActiveExchangeName()` still work (the type imports were updated).

---

## Phase 5: Extract `exchanges/okx/`

### Task 5.1: Extract `exchanges/okx/api.ts`

**Symbols:** `okxPublicGet`, `okxBar`, `fetchOkxTradeOrderRaw`

These call ccxt's raw OKX API. Module imports from `../factory` for `getPrivateExchange`/`getPublicExchange`.

After this task: move `probeOkxPublicApiForAutoTrading` from `server.ts` into `exchanges/connectivity.ts` (remove the Phase 4 TODO). Include in this task's commit.

Commit msg: `server: extract OKX raw-API helpers to src-server/exchanges/okx/api.ts; relocate probeOkxPublicApiForAutoTrading`

### Task 5.2: Extract `exchanges/okx/normalize.ts`

**Symbols:** `normalizeOkxOrderStatus`, `normalizeOkxRawOrder`, `normalizeOkxHistoryOrder`, `unwrapOkxApiRow`, `unwrapOkxApiRows`, `normalizeOkxBalance`, `normalizeOkxPosition`, `normalizeBinancePosition`

Note: `normalizeBinancePosition` was added in the Phase A follow-up. It belongs alongside `normalizeOkxPosition` for now (both are position normalizers). If you prefer, put it in a `exchanges/binance/normalize.ts` file in a future task.

Pure functions. No state.

Commit msg: `server: extract OKX (and Binance position) normalizers to src-server/exchanges/okx/normalize.ts`

### Task 5.3: Extract `exchanges/okx/markets.ts`

**Symbols:** `OkxResolvedSwapMarket` type, `OKX_SWAP_MARKET_CACHE_TTL_MS`, `findLoadedOkxSwapMarket`, `resolveOkxSwapMarket`, `ceilToStep`, `formatToStepString`

Module-level cache for resolved markets — wrap with getter/setter or keep as internal Map (it's read/written internally only).

Commit msg: `server: extract OKX market resolution to src-server/exchanges/okx/markets.ts`

### Task 5.4: Extract `exchanges/okx/errors.ts`

**Symbols:** `parseOkxErrorDetails`

Pure function.

Commit msg: `server: extract parseOkxErrorDetails to src-server/exchanges/okx/errors.ts`

### Task 5.5: Extract `exchanges/okx/orders.ts`

**Symbols:** `submitOkxOrder`, `buildOkxAttachAlgoOrds`

`submitOkxOrder` is a complex function — verify it still references the audit store, lifecycle store, and resolveOkxSwapMarket through their exported helpers (no direct closure access).

Commit msg: `server: extract submitOkxOrder + buildOkxAttachAlgoOrds to src-server/exchanges/okx/orders.ts`

### Task 5.6: Phase 5 verification

Run full validation. The OKX-specific snapshots (e.g., `/api/okx/balance` 400 response shape, `/api/okx/ticker/BTC-USDT-SWAP` ticker shape) must match baseline exactly.

---

## Phase 6: Extract `exchanges/impls.ts`

### Task 6.1: Extract `exchanges/impls.ts`

**Symbols:** `ImplResult` type, `sendImpl` helper, all 10 `*Impl` functions (`balanceImpl`, `tickerImpl`, `orderbookImpl`, `tickersImpl`, `ohlcvImpl`, `fundingImpl`, `positionsImpl`, `historyImpl`, `realizedPnlImpl`, `orderImpl`)

Long file (~500-700 lines). Imports many things: `getPrivateExchange`, `getPublicExchange`, `resolveCredentialsFor`, `submitOkxOrder`, OKX normalizers, cache.

Commit msg: `server: extract 10 *Impl + sendImpl + ImplResult to src-server/exchanges/impls.ts`

### Task 6.2: Phase 6 verification

Run full validation. Both `/api/okx/*` and `/api/binance/*` snapshot endpoints must match baseline.

---

## Phase 7: Extract `ai/analyze.ts`

### Task 7.1: Extract `ai/analyze.ts`

**Symbols:** `getZhipuConfig`, the `/api/ai/analyze` route handler (or its inner function — extract the function, leave the route registration in place for Phase 11).

If the AI handler is inlined as `app.post("/api/ai/analyze", async (req, res) => { ... 50 lines ... })`, extract the body to:

```ts
// src-server/ai/analyze.ts
export type AiTask = "decision" | "summary" | "vision";
export async function aiAnalyzeImpl(body: any, task: AiTask = "decision"): Promise<...> { ... }
```

Then the route handler becomes a thin wrapper, like the Phase 4 (Binance integration) `*Impl` pattern:

```ts
app.post("/api/ai/analyze", async (req, res) => {
  const { prompt, task = "decision" } = req.body;
  const result = await aiAnalyzeImpl({ ...req.body, prompt }, task);
  res.json(result);  // or similar
});
```

Note: The `/api/ai/analyze` endpoint is NOT in the snapshot list (we don't want to spend money). So validation here relies on lint + build only for the AI path.

Commit msg: `server: extract aiAnalyzeImpl + getZhipuConfig to src-server/ai/analyze.ts`

### Task 7.2: Phase 7 verification

Run full validation (snapshot diff still applies to all other endpoints). AI path is verified by lint + build only.

---

## Phase 8: Extract `auto-trading/` (HIGH RISK)

The auto-trading subsystem is the most coupled in `server.ts`. Plan B applies if extraction proves infeasible.

### Task 8.1: Extract `auto-trading/types.ts`

**Symbols:**
- `AutoTradingConfig`, `AutoTradingStatus`, `AutoTradingEngineState`
- `AutoTradingCycleSummary`, `AutoTradingTrace`
- `ManagedTakeProfitOrder`

These are pure types; no runtime cost. Should always extract cleanly.

Commit msg: `server: extract auto-trading types to src-server/auto-trading/types.ts`

### Task 8.2: Extract `auto-trading/preflight.ts`

**Symbols:** `assertAutoTradingExchangeReady`, `buildAutoTradingPreflightPayload`, `failAutoTradingPreflight`

Functions that depend on connectivity status + credentials. Should be straightforward.

Commit msg: `server: extract auto-trading preflight to src-server/auto-trading/preflight.ts`

### Task 8.3: Attempt to extract `auto-trading/tp-manager.ts`

**Symbols:** `TpManager` class (or whatever the take-profit manager is called)

If the TP manager is a class with clear methods and minimal closure dependencies → extract cleanly.

If it shares state with the auto-trading engine through shared closures (e.g., `currentCycleId` is read by both engine and tp-manager) → activate Plan B for this and subsequent auto-trading tasks: leave `tp-manager.ts` and `engine.ts` in `server.ts` with `// === auto-trading begin ===` / `// === auto-trading end ===` markers. Skip Tasks 8.4 and proceed to 8.5.

Commit msg (success): `server: extract TpManager to src-server/auto-trading/tp-manager.ts`
Commit msg (Plan B): `server: mark auto-trading section in server.ts (extraction deferred — internal coupling)`

### Task 8.4: Attempt to extract `auto-trading/engine.ts`

**Symbols:** Engine main loop, cycle execution, shadow mode, kill switch logic, auto-resume

If 8.3 succeeded, attempt this. If engine still has tight coupling to TP manager closures, see Plan B in spec §6.2 — try a SECOND decomposition approach (e.g., move cycle execution alone, leaving the loop driver in `server.ts`). After 2 attempts, if still infeasible, activate Plan B.

Commit msg: `server: extract auto-trading engine to src-server/auto-trading/engine.ts` (if successful)

### Task 8.5: Phase 8 verification

Run full validation. Auto-trading-related snapshot endpoints (`/api/auto-trading/status`, `/config`, `/logs`, `/cycles`, `/traces`) must match baseline.

---

## Phase 9: Extract `strategies/` and `backtest/`

These were left undefined in the spec; discovery happens here.

### Task 9.1: Survey strategies + backtest code

**Files:** none (research only)

- [ ] **Step 1: Identify the symbols**

```bash
grep -nE "function (run|build|score|generate)?[A-Z][a-zA-Z]*Strategy|class [A-Z][a-zA-Z]*Strategy|function (run|build)?[A-Z][a-zA-Z]*Backtest|function walkForward|class StrategyEngine" server.ts | head
```

Read the surrounding code. Identify natural module boundaries (e.g., `strategies/trend-breakout.ts`, `strategies/mean-reversion.ts`, `strategies/macro-gating.ts`, `backtest/walk-forward.ts`, `backtest/scoring.ts`).

- [ ] **Step 2: Document the proposed split inline as a comment in this plan section**

Add lines below this task summarizing the proposed split (so subsequent tasks know what to extract).

- [ ] **Step 3: Commit (no code changes — just a documentation comment update if any)**

If you only added comments to this plan file: `git add docs/superpowers/plans/2026-05-02-server-decomposition.md && git commit ...`. Otherwise skip the commit.

### Task 9.2-9.N: Per the survey

Execute the extractions identified in 9.1, one task per file. Use the same template as Phase 5.

Each task: find symbols → create module → modify server.ts → lint → commit.

### Task 9.N+1: Phase 9 verification

Run full validation.

---

## Phase 10: Extract `middleware/auth.ts`

### Task 10.1: Extract `middleware/auth.ts`

**Symbols:** `requireOperator`, `requireAdmin` if present, the session lookup logic, anything that reads `getSession(req)` and decides whether to allow access.

Imports from `../stores/operations` (for `getSession`) and `../credentials/admin-password` (if admin-only routes exist).

Commit msg: `server: extract auth middleware to src-server/middleware/auth.ts`

### Task 10.2: Phase 10 verification

Run full validation.

---

## Phase 11: Extract `routes/` (11 route files)

This is the biggest phase by file count. Each task extracts one logical group of routes into a `register*Routes(app)` function.

### Task 11.1: Extract `routes/auth.ts`

**Routes:** `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`

**Pattern:**

```ts
// src-server/routes/auth.ts
import type { Express } from "express";
import crypto from "node:crypto";
import {
  getAdminUsername,
  getAdminPasswordHash,
} from "../credentials/admin-password";
import { hashSecret, timingSafeEqualString } from "../core/crypto";
import {
  getAppStore,
  persistAppStore,
  addSecurityEvent,
  getSession,
} from "../stores/operations";

const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_HOURS) || 12) * 60 * 60 * 1000;

export function registerAuthRoutes(app: Express): void {
  app.post("/api/auth/login", async (req, res) => {
    const { username = getAdminUsername(), password } = req.body || {};
    const normalizedUsername = String(username || getAdminUsername()).trim();
    const passwordHash = password ? hashSecret(password) : "";
    if (
      normalizedUsername !== getAdminUsername() ||
      !passwordHash ||
      !timingSafeEqualString(passwordHash, getAdminPasswordHash())
    ) {
      addSecurityEvent("auth.login_failed", req, { username: normalizedUsername });
      return res.status(401).json({ error: "Invalid username or password" });
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const appStore = getAppStore();
    appStore.sessions.unshift({
      tokenHash: hashSecret(token),
      username: getAdminUsername(),
      role: "admin",
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastSeenAt: now,
    });
    appStore.sessions = appStore.sessions.filter(s => s.expiresAt > now).slice(0, 20);
    await persistAppStore();
    addSecurityEvent("auth.login_success", req, undefined, getAdminUsername());
    res.json({ token, user: { username: getAdminUsername(), role: "admin" }, expiresAt: now + SESSION_TTL_MS });
  });

  app.get("/api/auth/session", (req, res) => {
    const session = getSession(req);
    if (!session) return res.json({ authenticated: false });
    res.json({
      authenticated: true,
      user: { username: session.username, role: session.role },
      expiresAt: session.expiresAt,
    });
  });

  app.post("/api/auth/logout", async (req, res) => {
    // ... copy from server.ts
  });
}
```

In `server.ts`: delete the original 3 `app.post`/`app.get` calls, replace with `registerAuthRoutes(app);`.

Commit msg: `server: extract auth routes to src-server/routes/auth.ts`

### Task 11.2: Extract `routes/config.ts`

**Routes:** `GET /api/config/status`, `POST /api/config/credentials`, `DELETE /api/config/credentials`

Same `register*Routes(app)` pattern.

Commit msg: `server: extract config routes to src-server/routes/config.ts`

### Task 11.3: Extract `routes/settings.ts`

**Routes:** `GET /api/settings/exchange`, `POST /api/settings/exchange`, `POST /api/settings/binance-credentials`

Commit msg: `server: extract settings routes to src-server/routes/settings.ts`

### Task 11.4: Extract `routes/audit.ts`

**Routes:** `GET /api/audit/summary`, `GET /api/audit/logs/:type`, `POST /api/audit/risk-event`, `GET /api/security/events`, `GET /api/orders/lifecycle`, `GET /api/risk/state`, `POST /api/risk/state`, `POST /api/risk/kill-switch/reset`

Commit msg: `server: extract audit/security/risk routes to src-server/routes/audit.ts`

### Task 11.5: Extract `routes/exchanges.ts`

**Routes:** all 10 `/api/okx/*` + all 10 `/api/binance/*` (20 total)

Largest route file (~80 lines after thin-wrapper extraction is in place).

Commit msg: `server: extract OKX + Binance routes to src-server/routes/exchanges.ts`

### Task 11.6: Extract `routes/auto-trading.ts`

**Routes:** all `/api/auto-trading/*` (status, config GET/PUT, logs, traces, cycles, start, stop, run-once — ~10 routes)

Commit msg: `server: extract auto-trading routes to src-server/routes/auto-trading.ts`

### Task 11.7: Extract `routes/trades.ts`

**Routes:** `GET/POST /api/trades*`, `GET/POST /api/strategy/signals*`, `GET/POST /api/shadow/orders*`, `GET /api/shadow/summary`

Commit msg: `server: extract trades/signals/shadow routes to src-server/routes/trades.ts`

### Task 11.8: Extract `routes/portfolio.ts`

**Routes:** `GET /api/portfolio/returns`, `GET /api/research/weekly`, `GET /api/macro`

Commit msg: `server: extract portfolio/research/macro routes to src-server/routes/portfolio.ts`

### Task 11.9: Extract `routes/backtest.ts`

**Routes:** `POST /api/backtest`, `POST /api/backtest/walk-forward`

Commit msg: `server: extract backtest routes to src-server/routes/backtest.ts`

### Task 11.10: Extract `routes/ai.ts`

**Routes:** `POST /api/ai/analyze`

Commit msg: `server: extract AI route to src-server/routes/ai.ts`

### Task 11.11: Extract `routes/notify.ts`

**Routes:** `POST /api/notify`

Commit msg: `server: extract notify route to src-server/routes/notify.ts`

### Task 11.12: Phase 11 verification

Run full validation. ALL 30 snapshot endpoints must still match baseline. This is the highest-risk verification because every route was touched.

---

## Phase 12: Shrink `server.ts` to Entry Point

### Task 12.1: Reduce `server.ts` to ≤ 200 lines

By this point, `server.ts` should already be mostly empty (just the `main()` function, imports, and any frontend-serving setup). Trim what's left:

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Read the current `server.ts`**

Run: `wc -l server.ts`
Note the current line count.

- [ ] **Step 2: Identify any remaining inline code**

Read the file. Anything that's not:
- An import
- The `main()` function body (load stores, register routes, listen)
- Top-level error handling
- Frontend serving (express.static for production, vite middleware for dev)

…should be extracted (probably to `src-server/<appropriate>/`). If you find a substantial inline block, propose a target file (likely `core/` or a new helper) and extract it as a sub-task of 12.1.

- [ ] **Step 3: Reorganize what's left**

Final structure should be roughly:

```ts
// server.ts (target: ≤ 200 lines)
import express from "express";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { loadAdminCredentials } from "./src-server/credentials/admin-password";
import { loadCredentialStore } from "./src-server/credentials/store";
import { loadAuditStore } from "./src-server/stores/audit";
import { loadAppStore } from "./src-server/stores/operations";
import { loadRiskState } from "./src-server/stores/risk";
import { initTradingDB } from "./src-server/stores/trading-db";
import { publicExchanges, privateExchanges } from "./src-server/exchanges/factory";
import { registerExchangeProviders } from "./src-server/core/proxy";
import { startAutoTradingEngine } from "./src-server/auto-trading/engine";
import { requireOperator } from "./src-server/middleware/auth";
import { registerAuthRoutes } from "./src-server/routes/auth";
import { registerConfigRoutes } from "./src-server/routes/config";
// ... 9 more route imports

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

async function main() {
  console.log("[Server] Starting initialization...");
  await loadAdminCredentials();
  await loadCredentialStore();
  await loadAuditStore();
  await loadAppStore();
  await loadRiskState();
  await initTradingDB();
  registerExchangeProviders(
    () => publicExchanges.values(),
    () => privateExchanges.values()
  );
  await startAutoTradingEngine();

  const app = express();
  app.use(express.json());
  app.use("/api", requireOperator);
  registerAuthRoutes(app);
  registerConfigRoutes(app);
  registerSettingsRoutes(app);
  registerAuditRoutes(app);
  registerExchangesRoutes(app);
  registerAutoTradingRoutes(app);
  registerTradesRoutes(app);
  registerPortfolioRoutes(app);
  registerBacktestRoutes(app);
  registerAiRoutes(app);
  registerNotifyRoutes(app);

  if (process.env.NODE_ENV === "production") {
    const distPath = resolve(__dirname, "dist");
    if (existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (_req, res) => res.sendFile(resolve(distPath, "index.html")));
    }
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ server: { middlewareMode: true } });
    app.use(vite.middlewares);
  }

  app.listen(PORT, HOST, () => {
    console.log(`[Server] Listening on http://${HOST}:${PORT} (${process.env.NODE_ENV || "development"})`);
  });
}

main().catch(err => {
  console.error("[Server] Boot failed:", err);
  process.exit(1);
});
```

- [ ] **Step 4: Lint + build + snapshot**

Full validation suite. Snapshot diff must still be clean.

- [ ] **Step 5: Verify line count**

Run: `wc -l server.ts`
Expected: ≤ 200 lines (target). Hard cap: 300 lines. If over 300, identify the largest remaining block and extract it.

- [ ] **Step 6: Commit**

```bash
git add server.ts
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "server: shrink to <200 line entry point"
```

---

## Phase 13: Final Verification

### Task 13.1: Full validation + metrics

- [ ] **Step 1: Run all gates**

```bash
npm run lint              # exit 0
npx vitest run            # 47 tests pass, exit 0
npm run build             # exit 0
node scripts/snapshot-capture.mjs > /tmp/final.json
node scripts/snapshot-diff.mjs snapshots/baseline.json /tmp/final.json    # exit 0
```

All four must exit 0.

- [ ] **Step 2: Capture metrics**

```bash
echo "=== server.ts ===" && wc -l server.ts
echo "=== src-server/ files ===" && find src-server -name "*.ts" | sort
echo "=== src-server/ total lines ===" && find src-server -name "*.ts" | xargs wc -l | tail -1
echo "=== file count by directory ===" && find src-server -mindepth 1 -type d | xargs -I{} sh -c 'echo "{}: $(find {} -maxdepth 1 -name "*.ts" | wc -l) files"'
```

Expected:
- `server.ts` ≤ 200 lines (or ≤ 300 hard cap)
- `src-server/` contains ~30 files
- Total lines across `src-server/` + `server.ts` should be roughly equal to (or slightly more than) the original 7310 — extra lines from per-file imports/exports are acceptable

- [ ] **Step 3: Update the plan doc with final metrics (commit)**

Append a "Final State" section to this plan document recording the metrics, then commit:

```bash
git add docs/superpowers/plans/2026-05-02-server-decomposition.md
git -c user.name="Eric_hang" -c user.email="wyh0000009@gmail.com" commit -m "docs: record final decomposition metrics"
```

- [ ] **Step 4: Optional — push the branch**

```bash
git push -u origin feat/server-decomposition
```

---

## Self-Review Notes (for plan author, not engineer)

**Spec coverage:** Each spec section has at least one task:
- Spec §4 file layout → Phases 1-11 cover every file
- Spec §5 snapshot system → Phase 0 (Tasks 0.1-0.4)
- Spec §6 phase order → Phases 1-13 follow §6 table exactly
- Spec §6.2 Phase 8 Plan B → Task 8.3/8.4 explicit Plan B branches
- Spec §6.3 register route style → Task 11.1 establishes the pattern, 11.2-11.11 reuse it
- Spec §6.4 cold start order → Task 12.1 step 3 shows the final `main()`
- Spec §7 error handling → Embedded in per-task validation (lint/build/snapshot)
- Spec §8 testing → Phase 0 builds it; per-phase verification uses it
- Spec §9 risks → R1-R8 mitigated by getter/setter pattern (R1), snapshot tests (R2/R6/R8), strict phase order (R3), wc check (R4 indirectly), branch strategy (R5), Plan B (R7)

**Placeholder check:** No "TBD" / "TODO" left in plan body except:
- Phase 9 strategies/backtest — explicitly designed as "discover during 9.1, then extract per discovery". This is intentional since the spec said `(暂留空, phase 9 实施时根据现有代码再决定切分)`. Acceptable.
- Forward-dep stubs in Phase 2 (`ExchangeNameLocal`) explicitly cleaned up in Task 4.3. Acceptable.

**Type / name consistency:** 
- `ExchangeName`, `CredentialStore`, `AutoTradingConfig` etc. used consistently
- `register*Routes(app)` signature consistent across Tasks 11.1-11.11
- `getX()` / `setX()` / `loadX()` / `persistX()` naming consistent across all stores

**Estimated commits:** ~60 (Phase 0: 4, Phase 1: 7, Phase 2: 4, Phase 3: 5, Phase 4: 4, Phase 5: 6, Phase 6: 2, Phase 7: 2, Phase 8: 5, Phase 9: ~5 to be discovered, Phase 10: 2, Phase 11: 12, Phase 12: 1, Phase 13: 1)

**Estimated wall time:** 4-6 hours of subagent dispatches. Likely spans multiple sessions. Phase boundaries are natural pause points.
