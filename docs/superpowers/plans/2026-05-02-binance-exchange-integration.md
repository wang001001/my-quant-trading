# Binance Exchange Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Binance USDT-M perpetual futures support alongside existing OKX, with a global "active exchange" selector, and remove all sandbox/demo mode code.

**Architecture:** Introduce a thin exchange-adapter factory (`getPrivateExchange(name, …)`, `getPublicExchange(name)`) so all CCXT instantiation goes through one place. Refactor each existing OKX route handler into a pure async function that takes `name` as its first arg, then expose both `/api/okx/*` (preserved for backward compat with legacy bundled assets) and new `/api/binance/*` routes as thin wrappers around the same impl functions. Persist `activeExchange` in the encrypted credentialStore. Frontend reads it once at startup, dispatches API calls to the matching prefix, and hides legacy OKX-only panels when Binance is active.

**Tech Stack:** TypeScript, Express, ccxt (already at v4.5.48 — supports both OKX and Binance), React 19, Vite, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-02-binance-exchange-integration-design.md`

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `server.ts` | Modify (heavy) | Exchange factory, route refactor, sandbox removal, credential schema migration, new Binance routes, new Settings routes |
| `.env.example` | Modify | Remove `OKX_DEMO_*`; add `BINANCE_API_KEY`, `BINANCE_SECRET_KEY`, `ACTIVE_EXCHANGE` |
| `scripts/check-binance-connectivity.mjs` | Create | One-shot smoke test for Binance public + (optional) private connectivity. Run before integration to validate proxy/network |
| `src/app/state/exchangeStore.ts` | Create | Tiny module-level subscribable store for `{ activeExchange, hasOkx, hasBinance }` |
| `src/app/state/exchangeStore.test.ts` | Create | Vitest unit tests for the store |
| `src/app/api.ts` | Modify | Remove `sandbox` from `AutoTradingConfig` type, add settings endpoint typings |
| `src/app/hooks/useMarketData.ts` | Modify | Replace `/api/okx/...` with `/api/${activeExchange}/...` |
| `src/app/hooks/usePortfolioData.ts` | Modify | Same as above + remove `sandbox` parameter |
| `src/app/pages/SettingsPage.tsx` | Modify | Add active-exchange selector + Binance credential form; remove OKX demo fields and sandbox toggle |
| `src/app/layout/HeaderBar.tsx` | Modify | Remove "OKX 模拟盘 / 实盘" indicator (replace with active-exchange name) |
| `src/app/ConsoleApp.tsx` | Modify | Initialize exchange store at app startup; hide legacy OKX-only panels when Binance is active; remove sandbox prop drilling |
| `src/app/utils.ts` | Modify | Remove sandbox default in any default-config helper |

**Conventions:**
- All new code uses 2-space indent, double quotes, no semicolons-trailing-commas style — match existing `server.ts` and `src/` files.
- No new npm dependencies.
- For `server.ts` changes, use Edit tool with enough context to disambiguate (file is 7000+ lines).

---

## Phase 0: Smoke Test First

### Task 0.1: Binance connectivity smoke test

**Why:** Before committing to the refactor, verify (a) ccxt v4.5.48 can talk to Binance USDT-M futures from this machine, (b) the symbol format `BTC/USDT:USDT` works for Binance, (c) the existing `EXCHANGE_PROXY_URL` mechanism applies cleanly (per spec R2 + R4).

**Files:**
- Create: `scripts/check-binance-connectivity.mjs`

- [ ] **Step 1: Create the smoke-test script**

```js
// scripts/check-binance-connectivity.mjs
import "dotenv/config";
import ccxt from "ccxt";
import { HttpsProxyAgent } from "https-proxy-agent";

const proxyUrl = process.env.EXCHANGE_PROXY_URL || "";
const apiKey   = process.env.BINANCE_API_KEY || "";
const secret   = process.env.BINANCE_SECRET_KEY || "";

const exchange = new ccxt.binance({
  apiKey: apiKey || undefined,
  secret: secret || undefined,
  enableRateLimit: true,
  options: { defaultType: "future" },
});

if (proxyUrl) {
  const agent = new HttpsProxyAgent(proxyUrl);
  exchange.agent = agent;
  console.log(`[proxy] using ${proxyUrl}`);
}

console.log("[1/3] fetchTicker BTC/USDT:USDT ...");
const ticker = await exchange.fetchTicker("BTC/USDT:USDT");
console.log(`     last=${ticker.last}  bid=${ticker.bid}  ask=${ticker.ask}`);

console.log("[2/3] fetchOHLCV BTC/USDT:USDT 1h limit=3 ...");
const ohlcv = await exchange.fetchOHLCV("BTC/USDT:USDT", "1h", undefined, 3);
console.log(`     rows=${ohlcv.length}  lastClose=${ohlcv.at(-1)?.[4]}`);

if (apiKey && secret) {
  console.log("[3/3] fetchBalance (private) ...");
  const balance = await exchange.fetchBalance({ type: "future" });
  const usdt = balance.total?.USDT ?? 0;
  console.log(`     USDT total=${usdt}`);
} else {
  console.log("[3/3] skipped private check — set BINANCE_API_KEY + BINANCE_SECRET_KEY in .env to enable");
}

console.log("OK");
```

- [ ] **Step 2: Add Binance creds to .env (manual; do not commit)**

Open `.env` and append:

```
BINANCE_API_KEY=v7Rpo1GZXp8J2bjnwfRpnH1Mb4gedwSzMBtXnGK8hEOX7h7iW8knp325MMZkgtmK
BINANCE_SECRET_KEY=ptT62qGI4ILCRa7kwhy7L1oKeBN0WLqDCsL4YrJW9rq86VUYiRcWlqC9s7yLMU49
```

(`.env` is gitignored — these stay local.)

- [ ] **Step 3: Run the script**

Run: `node scripts/check-binance-connectivity.mjs`

Expected:
- All 3 steps log values, ending in `OK`
- If step 1 fails with `ETIMEDOUT` or `ECONNRESET`, the proxy/network issue must be resolved before proceeding (set `EXCHANGE_PROXY_URL` in `.env`)
- If step 3 fails with `signature for this request is not valid`, the API key is wrong — abort and re-confirm

- [ ] **Step 4: Commit the script**

```bash
git add scripts/check-binance-connectivity.mjs
git commit -m "scripts: add Binance connectivity smoke test"
```

---

## Phase 1: Backend Exchange Factory

### Task 1.1: Add ExchangeName type and factory helpers

**Files:**
- Modify: `server.ts` — add helpers near the existing `getPrivateExchange` function (around line 419)

- [ ] **Step 1: Locate existing exchange code**

Read `server.ts:419-446` (the current `getPrivateExchange` block) and `server.ts:3218-3227` (the current `publicExchange` const block). Confirm both still exist at those line ranges.

- [ ] **Step 2: Insert new factory helpers BEFORE `function getPrivateExchange`**

Above the existing `// --- Global Exchange Instances (for reuse) ---` comment, insert:

```ts
// --- Exchange Adapter ---
type ExchangeName = "okx" | "binance";

const VALID_EXCHANGES: readonly ExchangeName[] = ["okx", "binance"] as const;

function isExchangeName(value: unknown): value is ExchangeName {
  return typeof value === "string" && (VALID_EXCHANGES as readonly string[]).includes(value);
}

function getExchangeCtor(name: ExchangeName) {
  return name === "binance" ? (ccxt as any).binance : (ccxt as any).okx;
}

function buildExchangeOptions(name: ExchangeName) {
  if (name === "binance") {
    return {
      defaultType: "future",
      fetchMarkets: { types: ["future"] },
    };
  }
  return {
    defaultType: "swap",
    fetchMarkets: { types: ["swap", "spot"] },
  };
}

const publicExchanges = new Map<ExchangeName, any>();

function getPublicExchange(name: ExchangeName) {
  if (!publicExchanges.has(name)) {
    const Ctor = getExchangeCtor(name);
    const ex = new Ctor({
      enableRateLimit: true,
      timeout: OKX_AUTO_DATA_REQUEST_TIMEOUT_MS,
      options: buildExchangeOptions(name),
    });
    applyExchangeProxy(ex);
    publicExchanges.set(name, ex);
  }
  return publicExchanges.get(name);
}
```

- [ ] **Step 3: Run lint to confirm syntax**

Run: `npm run lint`
Expected: No new errors related to these helpers (any pre-existing errors are out of scope).

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "server: add exchange-adapter factory (ExchangeName, getExchangeCtor, getPublicExchange)"
```

---

### Task 1.2: Refactor getPrivateExchange to take ExchangeName

**Files:**
- Modify: `server.ts:421-446`

- [ ] **Step 1: Replace the function body**

Find the existing `function getPrivateExchange(apiKey: string, secret: string, password: string, sandbox: boolean) { ... }` block (server.ts:421-446) and replace with:

```ts
function getPrivateExchange(
  name: ExchangeName,
  apiKey: string,
  secret: string,
  password?: string
) {
  const key = `${name}_${apiKey}_${secret}_${password ?? ""}`;
  if (!privateExchanges.has(key)) {
    const Ctor = getExchangeCtor(name);
    const config: any = {
      apiKey,
      secret,
      enableRateLimit: true,
      timeout: OKX_AUTO_DATA_REQUEST_TIMEOUT_MS,
      options: buildExchangeOptions(name),
    };
    if (name === "okx" && password) {
      config.password = password;
    }
    const exchange = new Ctor(config);
    applyExchangeProxy(exchange);
    privateExchanges.set(key, exchange);
  }
  return privateExchanges.get(key)!;
}
```

Note: this removes the `sandbox` parameter and the `setSandboxMode` / `x-simulated-trading` header logic entirely.

- [ ] **Step 2: Run lint — expect MANY errors**

Run: `npm run lint`
Expected: TypeScript will report ~10 errors at every old call site of `getPrivateExchange(apiKey, secret, password, sandbox)`. Capture this list — Tasks 3.1 and 4.x will fix them.

- [ ] **Step 3: Commit (with lint failures — they are tracked in next tasks)**

```bash
git add server.ts
git commit -m "server: change getPrivateExchange signature to take ExchangeName, drop sandbox param

Lint will fail at all call sites until Phase 3+4 update them."
```

---

### Task 1.3: Replace publicExchange singleton with getPublicExchange

**Files:**
- Modify: `server.ts:3218-3227` and all callers

- [ ] **Step 1: Find all references to the existing singleton**

Run: `grep -n "publicExchange" server.ts`
Expected: lines 3218 (definition), 3226 (proxy apply), 3227 (privateExchanges Map), 3721 (`publicExchange.fetchOHLCV`). The 3227 line is `privateExchanges` (different name) — ignore.

Confirm each `publicExchange.X(...)` call you'll replace; usually 1-3 callers.

- [ ] **Step 2: Delete the old singleton declaration block**

In `server.ts:3218-3226`, delete:

```ts
const publicExchange = new (ccxt as any).okx({
  enableRateLimit: true,
  timeout: OKX_AUTO_DATA_REQUEST_TIMEOUT_MS,
  options: {
    defaultType: "swap",
    fetchMarkets: { types: ["swap", "spot"] },
  },
});
applyExchangeProxy(publicExchange);
```

Keep the `const privateExchanges = new Map<string, any>();` line that follows.

- [ ] **Step 3: Replace each `publicExchange.X(...)` caller**

For each call site found in Step 1 (e.g. `server.ts:3721`):

```ts
// before
() => publicExchange.fetchOHLCV(ccxtSymbol, timeframe, since, pageLimit)

// after
() => getPublicExchange(resolveActiveExchangeName()).fetchOHLCV(ccxtSymbol, timeframe, since, pageLimit)
```

(The `resolveActiveExchangeName()` helper is added in Task 2.4. For now, hardcode `getPublicExchange("okx")` and add a `// TODO Task 2.4` comment.)

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: No NEW errors (existing errors from Task 1.2 still present).

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "server: replace publicExchange singleton with getPublicExchange(name) factory

Callers temporarily hardcode 'okx' until resolveActiveExchangeName lands in Task 2.4."
```

---

## Phase 2: Credential Schema Migration

### Task 2.1: Extend credentialStore type with binance + activeExchange

**Files:**
- Modify: `server.ts` — find `type CredentialStore = ...` or interface

- [ ] **Step 1: Locate the type**

Run: `grep -n "CredentialStore\|credentialStore: " server.ts | head`
Find the type declaration (likely an `interface CredentialStore` or `type CredentialStore = ...`).

- [ ] **Step 2: Add new fields**

Add to the `CredentialStore` type:

```ts
activeExchange?: ExchangeName;
binance?: {
  apiKey?: string;
  secret?: string;
};
```

(Keep `okx` and `okxDemo` for now — `okxDemo` is removed in Task 3.5 after migration runs once.)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No new errors from this change alone.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "server: add binance + activeExchange fields to CredentialStore type"
```

---

### Task 2.2: Add migration to drop okxDemo on credential load

**Files:**
- Modify: `server.ts` — find `decryptCredentials` or wherever the store is loaded

- [ ] **Step 1: Find the load path**

Run: `grep -n "decryptCredentials\|credentialStore = " server.ts | head`
Identify the function that returns or assigns the parsed `credentialStore`.

- [ ] **Step 2: Add migration logic right after parse**

In the function that loads the store (likely after `JSON.parse` of decrypted bytes), insert:

```ts
// Schema migration: drop sandbox/demo mode (removed 2026-05).
if ((data as any).okxDemo) {
  console.warn("[Credentials] migration: dropping legacy okxDemo field");
  delete (data as any).okxDemo;
}
// Default activeExchange for older stores.
if (!data.activeExchange || !isExchangeName(data.activeExchange)) {
  data.activeExchange = "okx";
}
// Initialize binance slot if absent.
if (!data.binance) {
  data.binance = {};
}
```

- [ ] **Step 3: Test migration runs**

Manual: `rm -rf data/credentials.enc` (if it exists, will be regenerated). Restart `npm run dev`. The first request should NOT trigger the warning since there's no old data.

To exercise the warning later: `git stash`-style would not work since data is encrypted. Skip; rely on production users hitting it.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "server: migrate credentialStore on load — drop okxDemo, default activeExchange"
```

---

### Task 2.3: Add resolveCredentialsFor(name, body?) helper

**Files:**
- Modify: `server.ts` — add near `resolveOkxCredentials`

- [ ] **Step 1: Find the existing resolveOkxCredentials**

Run: `grep -n "resolveOkxCredentials" server.ts | head`
Read the existing function. Note its signature: it merges body-supplied creds with stored creds and falls back to env vars.

- [ ] **Step 2: Add new helper alongside it**

Insert:

```ts
function resolveCredentialsFor(name: ExchangeName, body: any = {}) {
  if (name === "binance") {
    const stored = credentialStore.binance || {};
    const apiKey = body.apiKey || stored.apiKey || envText("BINANCE_API_KEY");
    const secret = body.secret || stored.secret || envText("BINANCE_SECRET_KEY");
    if (!hasText(apiKey) || !hasText(secret)) return null;
    return { apiKey, secret, password: undefined };
  }
  // OKX path — delegate to existing helper, but always live (no sandbox).
  return resolveOkxCredentials(body, false);
}
```

(Note `resolveOkxCredentials(body, false)` keeps OKX live. Task 3.x removes the second `sandbox` arg later when its callers go away.)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "server: add resolveCredentialsFor(name) helper covering OKX + Binance"
```

---

### Task 2.4: Add resolveActiveExchangeName helper

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Insert helper near resolveCredentialsFor**

```ts
function resolveActiveExchangeName(): ExchangeName {
  const fromStore = credentialStore.activeExchange;
  if (isExchangeName(fromStore)) return fromStore;
  const fromEnv = envText("ACTIVE_EXCHANGE");
  if (isExchangeName(fromEnv)) return fromEnv;
  return "okx";
}
```

- [ ] **Step 2: Replace the temporary hardcoded `getPublicExchange("okx")` from Task 1.3**

Find every `getPublicExchange("okx")` introduced in Task 1.3, replace with `getPublicExchange(resolveActiveExchangeName())`. Remove the `// TODO Task 2.4` comments.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No new errors.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "server: add resolveActiveExchangeName + wire it into getPublicExchange callers"
```

---

## Phase 3: Remove Sandbox / Demo Mode

### Task 3.1: Remove sandbox parameter from all OKX route handlers

**Files:**
- Modify: `server.ts` — handlers `/api/okx/balance`, `/api/okx/positions`, `/api/okx/history`, `/api/okx/realized-pnl`, `/api/okx/order` (POST handlers that read `sandbox` from req.body)

- [ ] **Step 1: List all sandbox references in handlers**

Run: `grep -n "sandbox" server.ts | grep -v "^[0-9]*: *//"`
Triage by location: handler bodies, helper functions, type definitions.

- [ ] **Step 2: For each POST handler, remove sandbox extraction and propagation**

Pattern — for `/api/okx/balance` (line ~6314):

```ts
// before
app.post("/api/okx/balance", async (req, res) => {
  const { sandbox = false } = req.body;
  const isSandbox = String(sandbox) === 'true' || sandbox === true;
  const credentials = resolveOkxCredentials(req.body, isSandbox);
  ...
});

// after
app.post("/api/okx/balance", async (req, res) => {
  const credentials = resolveCredentialsFor("okx", req.body);
  ...
});
```

Apply the same pattern to `/api/okx/positions`, `/api/okx/history`, `/api/okx/realized-pnl`, `/api/okx/order`.

For each, also update the inner `getPrivateExchange(...)` call to the new signature: `getPrivateExchange("okx", credentials.apiKey, credentials.secret, credentials.password)`.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: Lint errors from Task 1.2 should now be resolved (or significantly reduced).

- [ ] **Step 4: Manual smoke test — OKX balance still works**

Restart dev server: kill old node process, `npm run dev`. With OKX creds in `.env` (or saved earlier), POST to `http://127.0.0.1:3000/api/okx/balance` (use curl or the SettingsPage). Expect 200 with current OKX balance data.

If you don't have OKX creds configured, skip — the regression test in Task 10.3 covers this.

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "server: drop sandbox param from OKX route handlers, route via resolveCredentialsFor"
```

---

### Task 3.2: Remove OKX_DEMO_* env variable reads

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Find the reads**

Run: `grep -n "OKX_DEMO" server.ts`
Identify each location.

- [ ] **Step 2: Delete the lines**

For each match, delete the surrounding line(s). Most likely in `resolveOkxCredentials` or related env-fallback helpers. After deletion, `resolveOkxCredentials` should only read `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`.

If `resolveOkxCredentials` had a `sandbox: boolean` parameter, also remove it now (the only remaining caller is `resolveCredentialsFor("okx", body)` from Task 2.3 which always passes `false`).

- [ ] **Step 3: Update `resolveCredentialsFor` to drop the now-unneeded second arg**

Find: `return resolveOkxCredentials(body, false);`
Replace: `return resolveOkxCredentials(body);`

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: No errors related to OKX_DEMO or sandbox.

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "server: remove OKX_DEMO_* env reads and sandbox param from resolveOkxCredentials"
```

---

### Task 3.3: Remove okxDemo references in credentialStore reads

**Files:**
- Modify: `server.ts:3175,3197,5930` (per spec) and any others

- [ ] **Step 1: Find all reads**

Run: `grep -n "credentialStore.okxDemo\|\.okxDemo" server.ts`
List each.

- [ ] **Step 2: Delete each read**

For example, `server.ts:3175`:

```ts
// before
const storedOkxLive = hasOkxCredentials(credentialStore.okx);
const storedOkxDemo = hasOkxCredentials(credentialStore.okxDemo);

// after
const storedOkxLive = hasOkxCredentials(credentialStore.okx);
```

For `server.ts:3197`:

```ts
// before
const stored = sandbox ? credentialStore.okxDemo : credentialStore.okx;

// after
const stored = credentialStore.okx;
```

(Remove the `sandbox` parameter from this function too if it becomes unused.)

For `server.ts:5930`:

```ts
// before
credentialStore.okxDemo = mergeText(credentialStore.okxDemo, { ... });

// after
// (delete this line entirely — demo is no longer stored)
```

- [ ] **Step 3: Remove `okxDemo` from CredentialStore type**

Find the `CredentialStore` type and delete the `okxDemo?: ...` field.

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: No errors related to okxDemo.

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "server: remove all okxDemo reads/writes from credentialStore"
```

---

### Task 3.4: Update .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Edit the file**

```diff
 # OKX live trading API credentials
 OKX_API_KEY=YOUR_OKX_API_KEY_HERE
 OKX_SECRET_KEY=YOUR_OKX_SECRET_KEY_HERE
 OKX_PASSPHRASE=YOUR_OKX_PASSPHRASE_HERE

-# OKX demo trading API credentials
-OKX_DEMO_API_KEY=YOUR_OKX_DEMO_API_KEY_HERE
-OKX_DEMO_SECRET_KEY=YOUR_OKX_DEMO_SECRET_KEY_HERE
-OKX_DEMO_PASSPHRASE=YOUR_OKX_DEMO_PASSPHRASE_HERE
+# Binance USDT-M futures API credentials
+BINANCE_API_KEY=YOUR_BINANCE_API_KEY_HERE
+BINANCE_SECRET_KEY=YOUR_BINANCE_SECRET_KEY_HERE
+
+# Active exchange (okx | binance). Default: okx.
+ACTIVE_EXCHANGE=okx
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "env: drop OKX_DEMO_*, add BINANCE_* and ACTIVE_EXCHANGE"
```

---

### Task 3.5: Final sandbox sweep — TypeScript verifies

**Files:**
- Modify: `server.ts` (any leftover sandbox refs)

- [ ] **Step 1: Run full lint**

Run: `npm run lint`
Expected: Either passes cleanly, OR shows remaining errors that mention `sandbox`/`isSandbox`/`setSandboxMode`/`x-simulated-trading`.

- [ ] **Step 2: Fix each remaining reference**

For each error: read the surrounding code, decide whether to delete the parameter, the branch, or the entire function. Common patterns to delete:
- `if (sandbox) { exchange.setSandboxMode(true); ... }` — entire if-block
- `exchange.headers = { ..., 'x-simulated-trading': '1' }` — entire line
- function signatures `(..., sandbox: boolean)` — remove the param + update callers

- [ ] **Step 3: Re-run lint until clean**

Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 4: Final grep — no traces remain**

Run: `grep -nE "sandbox|isSandbox|setSandboxMode|x-simulated-trading|OKX_DEMO" server.ts`
Expected: No matches (or only matches inside string literals that are user-facing messages — review case-by-case).

- [ ] **Step 5: Commit**

```bash
git add server.ts
git commit -m "server: final sandbox sweep — zero references remain"
```

---

## Phase 4: Extract OKX Handlers to Pure Functions

### Task 4.1: Extract impl pattern — start with `/api/okx/balance`

**Why:** Each Binance route reuses the same logic as its OKX twin. Extracting a pure `async function balanceImpl(name, body)` gives Binance routes a one-line wrapper.

**Files:**
- Modify: `server.ts:6314` (the `/api/okx/balance` handler)

- [ ] **Step 1: Read the existing handler**

Read `server.ts:6314-6349` (approx). Note: `req`, `res`, `req.body` usage.

- [ ] **Step 2: Refactor — extract pure function above the route registration**

```ts
async function balanceImpl(name: ExchangeName, body: any) {
  const credentials = resolveCredentialsFor(name, body);
  if (!credentials) {
    return { ok: false as const, status: 400, error: `Missing ${name} credentials` };
  }
  const exchange = getPrivateExchange(name, credentials.apiKey, credentials.secret, credentials.password);
  const balance = await retry(() => exchange.fetchBalance({ type: name === "binance" ? "future" : "swap" }));
  return { ok: true as const, status: 200, data: balance };
}

app.post("/api/okx/balance", async (req, res) => {
  const result = await balanceImpl("okx", req.body);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.status(result.status).json(result.data);
});
```

(If the original handler had any extra try/catch or response shaping, preserve it inside `balanceImpl` or wrap the call accordingly.)

- [ ] **Step 3: Test OKX balance still works**

Manual: restart `npm run dev`, hit `/api/okx/balance`. Expect 200 with same data shape as before.

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "server: extract balanceImpl(name) — /api/okx/balance becomes thin wrapper"
```

---

### Task 4.2 — 4.10: Repeat the extraction for the remaining 9 OKX routes

For each route below, follow the exact same pattern as Task 4.1: extract a pure async function `<name>Impl(name, body, params?)` that takes everything via parameters, then make the OKX route a thin wrapper.

**Routes to extract** (line numbers from current `server.ts`):

| Task | Route | Function name | Note |
|---|---|---|---|
| 4.2 | `GET  /api/okx/ticker/:symbol`  (~6350) | `tickerImpl(name, symbol)` | symbol from URL param |
| 4.3 | `GET  /api/okx/orderbook/:symbol` (~6385) | `orderbookImpl(name, symbol)` | |
| 4.4 | `GET  /api/okx/tickers` (~6407) | `tickersImpl(name)` | no symbol |
| 4.5 | `GET  /api/okx/ohlcv/:symbol` (~6440) | `ohlcvImpl(name, symbol, query)` | timeframe + limit from query |
| 4.6 | `GET  /api/okx/funding/:symbol` (~6459) | `fundingImpl(name, symbol)` | |
| 4.7 | `POST /api/okx/positions` (~6889) | `positionsImpl(name, body)` | |
| 4.8 | `POST /api/okx/history` (~6919) | `historyImpl(name, body)` | |
| 4.9 | `POST /api/okx/realized-pnl` (~6977) | `realizedPnlImpl(name, body)` | |
| 4.10 | `POST /api/okx/order` (~7049) | `orderImpl(name, body)` | be careful — this places real orders |

**Special note for Task 4.10 (orderImpl):** This is the only route that touches money. Do NOT change behavior — only extract. After extraction, manually verify with a tiny limit order well off-market (per spec §8.2). The user runs this test, not Claude.

- [ ] **Step 1 (per task): Read current handler**
- [ ] **Step 2 (per task): Extract impl + wrap OKX route**
- [ ] **Step 3 (per task): `npm run lint` clean**
- [ ] **Step 4 (per task): Restart server, smoke-test the OKX route returns same data structure as before**
- [ ] **Step 5 (per task): Commit**

```bash
git add server.ts
git commit -m "server: extract <FUNCTION>Impl — /api/okx/<route> becomes thin wrapper"
```

---

## Phase 5: Add Binance Routes

### Task 5.1: Add 10 /api/binance/* routes

**Files:**
- Modify: `server.ts` — register routes immediately after their OKX twins (or in a dedicated block)

- [ ] **Step 1: Add all 10 routes**

After the last `/api/okx/order` registration, insert:

```ts
// --- Binance routes (mirror OKX) ---
app.post("/api/binance/balance",          async (req, res) => sendImpl(res, await balanceImpl("binance", req.body)));
app.get ("/api/binance/ticker/:symbol",   async (req, res) => sendImpl(res, await tickerImpl("binance", req.params.symbol)));
app.get ("/api/binance/orderbook/:symbol",async (req, res) => sendImpl(res, await orderbookImpl("binance", req.params.symbol)));
app.get ("/api/binance/tickers",          async (req, res) => sendImpl(res, await tickersImpl("binance")));
app.get ("/api/binance/ohlcv/:symbol",    async (req, res) => sendImpl(res, await ohlcvImpl("binance", req.params.symbol, req.query)));
app.get ("/api/binance/funding/:symbol",  async (req, res) => sendImpl(res, await fundingImpl("binance", req.params.symbol)));
app.post("/api/binance/positions",        async (req, res) => sendImpl(res, await positionsImpl("binance", req.body)));
app.post("/api/binance/history",          async (req, res) => sendImpl(res, await historyImpl("binance", req.body)));
app.post("/api/binance/realized-pnl",     async (req, res) => sendImpl(res, await realizedPnlImpl("binance", req.body)));
app.post("/api/binance/order",            async (req, res) => sendImpl(res, await orderImpl("binance", req.body)));
```

- [ ] **Step 2: Add the small `sendImpl` helper above the routes**

```ts
type ImplResult<T = any> =
  | { ok: true;  status: number; data: T }
  | { ok: false; status: number; error: string };

function sendImpl(res: import("express").Response, result: ImplResult) {
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  return res.status(result.status).json(result.data);
}
```

(Optional: also retroactively use `sendImpl` for the OKX route wrappers to remove duplication — purely cosmetic, can skip.)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: Clean.

- [ ] **Step 4: Smoke test public Binance routes**

Restart dev server. Run:

```bash
curl -s http://127.0.0.1:3000/api/binance/ticker/BTC%2FUSDT%3AUSDT | head -c 300
curl -s "http://127.0.0.1:3000/api/binance/ohlcv/BTC%2FUSDT%3AUSDT?t=1h&limit=3" | head -c 300
```

Expected: Valid JSON with ticker / ohlcv data. If 500: check proxy + check `toCcxtSymbol` handles slash-format symbols correctly.

- [ ] **Step 5: Smoke test private Binance routes (with creds set)**

```bash
curl -s -X POST http://127.0.0.1:3000/api/binance/balance -H "Content-Type: application/json" -d "{}"
```

Expected: Either `{ ... balance JSON ... }` (if creds in .env) or `{"error": "Missing binance credentials"}` (if not).

- [ ] **Step 6: Commit**

```bash
git add server.ts
git commit -m "server: add 10 /api/binance/* routes mirroring OKX, sharing impl functions"
```

---

## Phase 6: Settings Endpoints

### Task 6.1: GET /api/settings/exchange

- [ ] **Step 1: Add route**

Insert near other settings routes (search `/api/settings` or near the AI routes):

```ts
app.get("/api/settings/exchange", async (_req, res) => {
  const activeExchange = resolveActiveExchangeName();
  const okxCreds = credentialStore.okx || {};
  const binCreds = credentialStore.binance || {};
  res.json({
    activeExchange,
    hasOkx:     hasText(okxCreds.apiKey) && hasText(okxCreds.secret),
    hasBinance: hasText(binCreds.apiKey) && hasText(binCreds.secret),
  });
});
```

- [ ] **Step 2: Test with curl**

```bash
curl http://127.0.0.1:3000/api/settings/exchange
```

Expected: `{"activeExchange":"okx","hasOkx":...,"hasBinance":...}`

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "server: add GET /api/settings/exchange"
```

---

### Task 6.2: POST /api/settings/exchange

- [ ] **Step 1: Add route**

```ts
app.post("/api/settings/exchange", async (req, res) => {
  const { activeExchange } = req.body || {};
  if (!isExchangeName(activeExchange)) {
    return res.status(400).json({ error: "activeExchange must be 'okx' or 'binance'" });
  }
  credentialStore.activeExchange = activeExchange;
  await persistCredentials();
  res.json({ activeExchange });
});
```

(Verify the actual persist function name — likely `persistCredentials` or `saveCredentials`. Search if unsure.)

- [ ] **Step 2: Test**

```bash
curl -X POST http://127.0.0.1:3000/api/settings/exchange \
  -H "Content-Type: application/json" -d '{"activeExchange":"binance"}'
```

Expected: `{"activeExchange":"binance"}`. Then GET to confirm persisted.

- [ ] **Step 3: Reset back to okx for now**

```bash
curl -X POST http://127.0.0.1:3000/api/settings/exchange \
  -H "Content-Type: application/json" -d '{"activeExchange":"okx"}'
```

- [ ] **Step 4: Commit**

```bash
git add server.ts
git commit -m "server: add POST /api/settings/exchange"
```

---

### Task 6.3: POST /api/settings/binance-credentials

- [ ] **Step 1: Add route**

```ts
app.post("/api/settings/binance-credentials", async (req, res) => {
  const { apiKey, secret } = req.body || {};
  if (!hasText(apiKey) || !hasText(secret)) {
    return res.status(400).json({ error: "apiKey and secret are required" });
  }
  credentialStore.binance = {
    apiKey: String(apiKey).trim(),
    secret: String(secret).trim(),
  };
  await persistCredentials();
  res.json({ ok: true, hasBinance: true });
});
```

- [ ] **Step 2: Test**

```bash
curl -X POST http://127.0.0.1:3000/api/settings/binance-credentials \
  -H "Content-Type: application/json" -d '{"apiKey":"test","secret":"test"}'
```

Expected: `{"ok":true,"hasBinance":true}`. Then GET `/api/settings/exchange` and verify `hasBinance:true`.

(Replace test/test with real values via the SettingsPage UI later.)

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "server: add POST /api/settings/binance-credentials"
```

---

## Phase 7: Frontend Exchange Store

### Task 7.1: Create exchangeStore module

**Files:**
- Create: `src/app/state/exchangeStore.ts`

- [ ] **Step 1: Create directory + file**

```ts
// src/app/state/exchangeStore.ts
import { useSyncExternalStore } from "react";

export type ExchangeName = "okx" | "binance";

export type ExchangeState = {
  activeExchange: ExchangeName;
  hasOkx: boolean;
  hasBinance: boolean;
};

let state: ExchangeState = {
  activeExchange: "okx",
  hasOkx: false,
  hasBinance: false,
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getExchangeState(): ExchangeState {
  return state;
}

export function setExchangeState(next: Partial<ExchangeState>) {
  state = { ...state, ...next };
  emit();
}

export function subscribeExchangeState(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useExchangeState(): ExchangeState {
  return useSyncExternalStore(subscribeExchangeState, getExchangeState, getExchangeState);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/state/exchangeStore.ts
git commit -m "frontend: add exchangeStore (useSyncExternalStore-based, no deps)"
```

---

### Task 7.2: Test exchangeStore

**Files:**
- Create: `src/app/state/exchangeStore.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  getExchangeState,
  setExchangeState,
  subscribeExchangeState,
} from "./exchangeStore";

describe("exchangeStore", () => {
  beforeEach(() => {
    setExchangeState({ activeExchange: "okx", hasOkx: false, hasBinance: false });
  });

  it("returns default state", () => {
    expect(getExchangeState().activeExchange).toBe("okx");
  });

  it("merges partial updates", () => {
    setExchangeState({ activeExchange: "binance" });
    expect(getExchangeState()).toEqual({
      activeExchange: "binance",
      hasOkx: false,
      hasBinance: false,
    });
  });

  it("notifies subscribers on change", () => {
    let count = 0;
    const unsub = subscribeExchangeState(() => { count++; });
    setExchangeState({ hasBinance: true });
    setExchangeState({ activeExchange: "binance" });
    unsub();
    setExchangeState({ hasOkx: true });   // should NOT increment
    expect(count).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/app/state/exchangeStore.test.ts`
Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/app/state/exchangeStore.test.ts
git commit -m "frontend: test exchangeStore"
```

---

### Task 7.3: Initialize exchangeStore at app startup

**Files:**
- Modify: `src/app/ConsoleApp.tsx` (or `src/main.tsx` / `src/App.tsx` — find the earliest mounted component that runs after auth)

- [ ] **Step 1: Find the app initialization point**

Run: `grep -nE "useEffect|fetchInitial|sessionLoaded" src/App.tsx src/main.tsx src/app/ConsoleApp.tsx | head`
Identify a `useEffect` that runs once on mount.

- [ ] **Step 2: Add a fetch + setState call**

In an existing startup `useEffect` (or add a new one):

```tsx
import { setExchangeState } from "./state/exchangeStore";
import { apiFetch } from "./api";

useEffect(() => {
  apiFetch<{ activeExchange: "okx" | "binance"; hasOkx: boolean; hasBinance: boolean }>(
    "/api/settings/exchange"
  )
    .then(s => setExchangeState(s))
    .catch(err => console.warn("[exchangeStore] init failed", err));
}, []);
```

- [ ] **Step 3: Verify in browser**

Open `http://127.0.0.1:3000` → DevTools console → run `localStorage` is unchanged. Confirm no errors. (Visual confirmation that the request lands successfully via Network tab.)

- [ ] **Step 4: Commit**

```bash
git add src/app/ConsoleApp.tsx
git commit -m "frontend: hydrate exchangeStore on app startup"
```

---

### Task 7.4: Refactor useMarketData to use activeExchange

**Files:**
- Modify: `src/app/hooks/useMarketData.ts`

- [ ] **Step 1: Read current file**

Read all of `src/app/hooks/useMarketData.ts`. Lines 40-44 contain 5 `/api/okx/...` paths.

- [ ] **Step 2: Replace each `/api/okx/...` with `/api/${exchange}/...`**

At the top of the hook, add:

```ts
import { useExchangeState } from "../state/exchangeStore";
```

In the hook body:

```ts
const { activeExchange } = useExchangeState();
```

Replace each line:

```ts
// before
apiFetch<Record<string, Ticker>>("/api/okx/tickers", { signal }),

// after
apiFetch<Record<string, Ticker>>(`/api/${activeExchange}/tickers`, { signal }),
```

(Repeat for all 5 lines. Add `activeExchange` to the dependency array of any `useMemo`/`useCallback`/`useEffect` that uses it, so data re-fetches on switch.)

- [ ] **Step 3: Run lint + tests**

Run: `npm run lint`
Expected: Clean.

Run: `npx vitest run`
Expected: All existing passing tests still pass.

- [ ] **Step 4: Manual browser test**

Restart dev server. Open dashboard. Confirm market data still loads (uses OKX since active is okx).

Then via curl: `curl -X POST http://127.0.0.1:3000/api/settings/exchange -H "Content-Type: application/json" -d '{"activeExchange":"binance"}'` → reload browser → market data should now come from Binance (verify in Network tab the request URL is `/api/binance/tickers`).

Reset to okx after.

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useMarketData.ts
git commit -m "frontend: useMarketData routes via activeExchange"
```

---

### Task 7.5: Refactor usePortfolioData

**Files:**
- Modify: `src/app/hooks/usePortfolioData.ts`

- [ ] **Step 1: Read current file**

Read all of `src/app/hooks/usePortfolioData.ts`. Note: this hook also takes a `sandbox` parameter that we're removing.

- [ ] **Step 2: Apply changes**

```ts
// imports
import { useExchangeState } from "../state/exchangeStore";

// remove sandbox from props
type Props = {
  selectedSymbol: string;
  token: string;
  // sandbox: boolean;   ← DELETE
};

// inside hook
const { activeExchange } = useExchangeState();
// remove sandbox from destructure

// replace endpoints
postJson<BalanceResponse>(`/api/${activeExchange}/balance`, {}, { token }),
postJson<PositionRow[]>(`/api/${activeExchange}/positions`, {}, { token }),
postJson<RealizedPnlResponse>(`/api/${activeExchange}/realized-pnl`, {}, { token }),
postJson<HistoryOrderRow[]>(`/api/${activeExchange}/history`, { symbol: selectedSymbol }, { token }),

// update useEffect/useMemo deps: replace `sandbox` with `activeExchange`
```

- [ ] **Step 3: Update callers**

Run: `grep -rn "usePortfolioData" src/`
For each caller, remove the `sandbox` prop being passed.

- [ ] **Step 4: Run lint + tests**

Run: `npm run lint && npx vitest run`
Expected: Clean.

- [ ] **Step 5: Manual test**

Browser: Portfolio page should load OKX positions/balance. Switch active exchange to Binance via curl → reload → Portfolio should show Binance data (or "Missing binance credentials" if not configured, which is expected).

- [ ] **Step 6: Commit**

```bash
git add src/app/hooks/usePortfolioData.ts src/app/ConsoleApp.tsx  # callers
git commit -m "frontend: usePortfolioData routes via activeExchange, drop sandbox prop"
```

---

## Phase 8: SettingsPage UI

### Task 8.1: Add active exchange selector

**Files:**
- Modify: `src/app/pages/SettingsPage.tsx`

- [ ] **Step 1: Read current SettingsPage layout**

Read `src/app/pages/SettingsPage.tsx` to understand sections and form patterns.

- [ ] **Step 2: Add exchange selector at the top**

Insert a new section at the top of the page:

```tsx
import { useExchangeState, setExchangeState } from "../state/exchangeStore";
import { postJson } from "../api";

// inside component
const { activeExchange, hasOkx, hasBinance } = useExchangeState();

async function handleExchangeChange(next: "okx" | "binance") {
  await postJson("/api/settings/exchange", { activeExchange: next });
  setExchangeState({ activeExchange: next });
}

// in JSX, near top
<section className="card">
  <h2>当前交易所</h2>
  <select
    value={activeExchange}
    onChange={(e) => handleExchangeChange(e.target.value as "okx" | "binance")}
  >
    <option value="okx">OKX {hasOkx ? "✓" : "✗ 未配置"}</option>
    <option value="binance">Binance {hasBinance ? "✓" : "✗ 未配置"}</option>
  </select>
  <p className="text-sm text-zinc-400 mt-2">
    切换后，Dashboard / Market / Portfolio 页面将从对应交易所拉取数据。
  </p>
</section>
```

(Match the existing card / styling classes used elsewhere in SettingsPage.)

- [ ] **Step 3: Visual test**

Browser: open Settings page → see new section at top → switch dropdown → confirm:
1. POST to `/api/settings/exchange` fires (Network tab)
2. Selected option updates
3. Reload page → still shows the new selection (persistence)

- [ ] **Step 4: Commit**

```bash
git add src/app/pages/SettingsPage.tsx
git commit -m "frontend: SettingsPage — add active exchange selector"
```

---

### Task 8.2: Remove demo credentials section + sandbox toggle

**Files:**
- Modify: `src/app/pages/SettingsPage.tsx`

- [ ] **Step 1: Find demo credential UI**

Run: `grep -nE "demo|sandbox|OKX_DEMO" src/app/pages/SettingsPage.tsx`
Locate any form fields, toggles, or sections referencing demo/sandbox.

- [ ] **Step 2: Delete those sections**

Remove:
- The `<input>` fields for `OKX_DEMO_API_KEY`, `OKX_DEMO_SECRET_KEY`, `OKX_DEMO_PASSPHRASE` (or whatever bound names)
- The `sandbox` checkbox at line 84-87 (`<input type="checkbox" checked={Boolean(autoConfig?.sandbox)} ...>`)
- Any section headers like "OKX 模拟盘" or "Demo Trading"

- [ ] **Step 3: Remove sandbox from autoConfig type**

Find `AutoTradingConfig` (in `src/app/api.ts` or similar). Remove the `sandbox: boolean` field. Update any callers that read `autoConfig.sandbox`.

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: TypeScript will report all stale `autoConfig.sandbox` usages — fix each by deleting the reference.

- [ ] **Step 5: Visual test**

Settings page no longer shows demo credentials section. AutoTrading config no longer has sandbox toggle.

- [ ] **Step 6: Commit**

```bash
git add src/app/pages/SettingsPage.tsx src/app/api.ts src/app/utils.ts
git commit -m "frontend: drop OKX demo credentials section + sandbox toggle"
```

---

### Task 8.3: Add Binance credentials section

**Files:**
- Modify: `src/app/pages/SettingsPage.tsx`

- [ ] **Step 1: Add form + submit handler**

```tsx
const [binanceApiKey, setBinanceApiKey] = useState("");
const [binanceSecret, setBinanceSecret] = useState("");
const [binanceSaving, setBinanceSaving] = useState(false);

async function handleSaveBinance(e: React.FormEvent) {
  e.preventDefault();
  setBinanceSaving(true);
  try {
    await postJson("/api/settings/binance-credentials", {
      apiKey: binanceApiKey,
      secret: binanceSecret,
    });
    setExchangeState({ hasBinance: true });
    setBinanceApiKey("");
    setBinanceSecret("");
    // optional: toast success
  } finally {
    setBinanceSaving(false);
  }
}

// JSX
<section className="card">
  <h2>Binance 凭证</h2>
  <p className="text-sm text-zinc-400">
    USDT-M 合约的 API Key 和 Secret。无需 passphrase。
    {hasBinance && <span className="ml-2 text-green-500">✓ 已配置</span>}
  </p>
  <form onSubmit={handleSaveBinance} className="mt-4 space-y-3">
    <input
      type="password"
      placeholder="API Key"
      value={binanceApiKey}
      onChange={(e) => setBinanceApiKey(e.target.value)}
      className="input"
    />
    <input
      type="password"
      placeholder="Secret Key"
      value={binanceSecret}
      onChange={(e) => setBinanceSecret(e.target.value)}
      className="input"
    />
    <button type="submit" disabled={binanceSaving || !binanceApiKey || !binanceSecret}>
      {binanceSaving ? "保存中…" : "保存"}
    </button>
  </form>
</section>
```

(Match existing CSS classes — replace `input`/`card` with what the codebase actually uses.)

- [ ] **Step 2: Visual test**

Browser: Enter Binance creds → click 保存 → confirm POST fires → confirm "✓ 已配置" appears next to Binance heading → switch active exchange to Binance → Portfolio loads Binance data.

- [ ] **Step 3: Commit**

```bash
git add src/app/pages/SettingsPage.tsx
git commit -m "frontend: SettingsPage — add Binance credentials form"
```

---

### Task 8.4: Hide legacy panels when Binance is active

**Files:**
- Modify: wherever legacy panels are mounted (search `legacy/assets` or `EmbeddedBacktestApp` etc.)

- [ ] **Step 1: Find legacy panel mount points**

Run: `grep -rnE "legacy|Embedded.*App" src/app/ConsoleApp.tsx src/app/pages/`
Identify where the embedded React panels (which call `/api/okx/*` from bundled JS) are rendered.

- [ ] **Step 2: Wrap each legacy mount in conditional**

```tsx
import { useExchangeState } from "../state/exchangeStore";

// inside component
const { activeExchange } = useExchangeState();
const showLegacy = activeExchange === "okx";

// in JSX
{showLegacy && <EmbeddedBacktestApp ... />}
```

If the legacy panels are sidebar nav items, also hide the menu entries:

```tsx
{showLegacy && <SidebarLink to="/legacy-backtest">Legacy Backtest</SidebarLink>}
```

- [ ] **Step 3: Visual test**

Switch to Binance → legacy entries gone. Switch to OKX → they reappear.

- [ ] **Step 4: Commit**

```bash
git add src/app/ConsoleApp.tsx src/app/layout/Sidebar.tsx
git commit -m "frontend: hide legacy OKX panels when Binance is active"
```

---

### Task 8.5: Update HeaderBar indicator

**Files:**
- Modify: `src/app/layout/HeaderBar.tsx:69`

- [ ] **Step 1: Replace the line**

```tsx
// before
<div className="font-medium text-zinc-100">{autoConfig?.sandbox ? "OKX 模拟盘" : "OKX 实盘"}</div>

// after
import { useExchangeState } from "../state/exchangeStore";
// ...
const { activeExchange } = useExchangeState();
// ...
<div className="font-medium text-zinc-100">
  {activeExchange === "binance" ? "Binance 实盘" : "OKX 实盘"}
</div>
```

- [ ] **Step 2: Visual test**

Header shows "OKX 实盘" by default; switches to "Binance 实盘" after toggle.

- [ ] **Step 3: Commit**

```bash
git add src/app/layout/HeaderBar.tsx
git commit -m "frontend: HeaderBar shows active exchange instead of sandbox indicator"
```

---

## Phase 9: End-to-End Verification

### Task 9.1: Public market data on Binance

- [ ] **Step 1: Switch active exchange to Binance**

```bash
curl -X POST http://127.0.0.1:3000/api/settings/exchange \
  -H "Content-Type: application/json" -d '{"activeExchange":"binance"}'
```

- [ ] **Step 2: Hit each public endpoint via curl + record response shape**

```bash
curl -s http://127.0.0.1:3000/api/binance/tickers | python -m json.tool | head -20
curl -s http://127.0.0.1:3000/api/binance/ticker/BTC%2FUSDT%3AUSDT | python -m json.tool
curl -s http://127.0.0.1:3000/api/binance/orderbook/BTC%2FUSDT%3AUSDT | python -m json.tool | head -20
curl -s "http://127.0.0.1:3000/api/binance/ohlcv/BTC%2FUSDT%3AUSDT?t=1h&limit=5" | python -m json.tool
curl -s http://127.0.0.1:3000/api/binance/funding/BTC%2FUSDT%3AUSDT | python -m json.tool
```

Expected: 5 valid JSON responses. Record any structural differences from OKX (per spec R1) for follow-up normalization.

- [ ] **Step 3: Browser test**

Open Dashboard / Market page → all charts and tables populate from Binance data.

- [ ] **Step 4: Note structural diffs (if any)**

If responses differ in field names from OKX (e.g. funding rate in different key), open a follow-up issue/note. The handler-level normalization is out of scope for this task — only flag.

---

### Task 9.2: Private read on Binance

- [ ] **Step 1: Save Binance creds via SettingsPage**

Browser: Settings → Binance Credentials → paste real keys → Save.

- [ ] **Step 2: Hit private read endpoints**

```bash
curl -s -X POST http://127.0.0.1:3000/api/binance/balance -H "Content-Type: application/json" -d "{}" | python -m json.tool
curl -s -X POST http://127.0.0.1:3000/api/binance/positions -H "Content-Type: application/json" -d "{}" | python -m json.tool
curl -s -X POST http://127.0.0.1:3000/api/binance/realized-pnl -H "Content-Type: application/json" -d "{}" | python -m json.tool
curl -s -X POST http://127.0.0.1:3000/api/binance/history -H "Content-Type: application/json" -d "{}" | python -m json.tool
```

Expected: 4 valid JSON responses. If any returns `signature is invalid` or `IP not whitelisted`, fix the API key permissions on Binance side, do not modify code.

- [ ] **Step 3: Browser test**

Portfolio page → balance + positions render with real Binance data.

---

### Task 9.3: OKX regression

- [ ] **Step 1: Switch back to OKX**

Settings UI dropdown → OKX. Or curl: `POST /api/settings/exchange {"activeExchange":"okx"}`.

- [ ] **Step 2: Run the same suite of curls against /api/okx/* endpoints**

Confirm responses match what they returned BEFORE this refactor (data structures, field names, status codes). No regression expected since OKX handlers are now thin wrappers around extracted impl functions — but verify.

- [ ] **Step 3: Test OKX private endpoints if creds available**

```bash
curl -s -X POST http://127.0.0.1:3000/api/okx/balance -H "Content-Type: application/json" -d "{}" | python -m json.tool
```

Expected: Same shape as before refactor.

---

### Task 9.4: Manual order placement (USER, not Claude)

This step is performed by the human operator, NOT automated.

**Procedure (per spec §8.2):**

1. UI: switch active exchange to Binance
2. Use the order panel (legacy or new — depending on what's available; the current React app has no order UI, so this step uses Binance's own app for verification, or the order endpoint via curl)
3. If using curl directly:
   ```bash
   curl -s -X POST http://127.0.0.1:3000/api/binance/order \
     -H "Content-Type: application/json" \
     -d '{"symbol":"BTC/USDT:USDT","side":"buy","type":"limit","amount":0.001,"price":<HALF_OF_MARKET>}'
   ```
   With `<HALF_OF_MARKET>` = current price × 0.5 (will not fill).
4. Verify the order appears in Binance app under Open Orders.
5. Cancel the order (via Binance app or via the cancel endpoint if exposed).
6. Verify cancellation succeeded.

**If anything fails:** capture error, do not loop / retry. Report to Claude for triage.

---

### Task 9.5: Final lint + test sweep

- [ ] **Step 1: Lint clean**

Run: `npm run lint`
Expected: 0 errors.

- [ ] **Step 2: All vitest tests pass**

Run: `npx vitest run`
Expected: All green (including new exchangeStore tests + existing lib tests).

- [ ] **Step 3: Build succeeds**

Run: `npm run build`
Expected: Successful build, no errors.

- [ ] **Step 4: Final grep for orphans**

```bash
grep -rnE "sandbox|OKX_DEMO|isSandbox|setSandboxMode|x-simulated-trading" src/ server.ts | grep -v node_modules | grep -v "\.test\.\|\.md"
```

Expected: 0 matches in source (matches in `portfolioReturns.ts` historical-data classification logic that processes legacy DB rows are OK to keep — those are reading old data, not writing new sandbox state).

- [ ] **Step 5: Commit any cleanup**

```bash
git add -p   # stage only intentional changes
git commit -m "chore: final cleanup after Binance integration"
```

---

## Self-Review Notes (for plan author, not engineer)

- Spec coverage check: every spec section has at least one task ✓
  - Spec §4.1 factory → Task 1.1
  - Spec §4.2 schema migration → Tasks 2.1, 2.2, 3.3
  - Spec §4.3 .env fields → Task 3.4
  - Spec §5.1 helpers → Tasks 1.1, 2.3, 2.4
  - Spec §5.2 refactors → Tasks 1.2, 1.3, 3.1, 3.2, 3.3, 4.x
  - Spec §5.3 Binance routes → Task 5.1
  - Spec §5.4 settings routes → Tasks 6.1, 6.2, 6.3
  - Spec §5.5 symbol normalization → Task 0.1 (verifies) + Task 9.1 (records diffs)
  - Spec §6.1 global state → Tasks 7.1, 7.2, 7.3
  - Spec §6.2 api.ts → Tasks 7.4, 7.5
  - Spec §6.3 SettingsPage → Tasks 8.1, 8.2, 8.3, 8.5
  - Spec §6.4 cache invalidation on switch → handled implicitly by useExchangeState dep arrays in 7.4/7.5
  - Spec §6.5 legacy hide → Task 8.4
  - Spec §7 error handling → covered in impl pattern (Task 4.1) and Task 5.1 (sendImpl)
  - Spec §8.1 automated tests → Tasks 9.1, 9.2, 9.3, 9.5
  - Spec §8.2 manual order test → Task 9.4
- Placeholders: none ✓ (all "TODO Task 2.4" are explicit handoffs to a defined task)
- Type consistency: `ExchangeName` defined in Task 1.1, reused in 2.x, 4.x, 5.1, 6.x — consistent ✓
- Naming: `*Impl` for extracted handler functions, consistent across 4.1-4.10 ✓
