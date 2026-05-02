# server.ts 模块化重构设计

- **状态**: Draft (待 user review)
- **日期**: 2026-05-02
- **范围**: cryptoquant-ai 后端 `server.ts` 单文件（7310 行）拆分为 `src-server/` 多模块架构
- **前置任务**: Binance 集成已完成（`feat/binance-integration` 分支，43 commits 领先 master）
- **后置 spec（推迟到本 spec 完成后再开）**:
  - 后端单元测试体系（针对拆分后各模块）
  - Binance `orderImpl` / `historyImpl` / `realizedPnlImpl` 真实实现
  - 安全加固（admin 密码、rate limit、.env 加密等）

---

## 1. 背景与动机

`server.ts` 当前 7310 行，单文件包含约 50 个 HTTP 路由 + 几十个 helper + 多个持久化 store + auto-trading 引擎 + backtest + AI 集成 + 凭证管理 + 代理 + sqlite 等几乎所有后端逻辑。

**问题**：
- Subagent 改动时 grep/edit 成本高，定位精度差
- 新增 feature 需要在 7000+ 行里找插入点，容易破坏邻近代码
- 写后端测试无从下手——单元测试需要 mock 整个上下文
- 任何重构都需要重新理解全文件，效率低
- 内部耦合不可见——所有"模块"实际上都共享文件级闭包

**目标**：拆成 ~30 个文件的 `src-server/` 模块树，每个文件单一职责、< 500 行，`server.ts` 退化为 < 200 行的入口装配文件。**零行为变更**——所有现有 API 响应、数据流、副作用必须 byte-identical。

---

## 2. 目标与非目标

### 目标
- G1：把 `server.ts` 7310 行拆为 ~30 个文件的 `src-server/` 树状结构
- G2：每个文件单一职责，< 500 行（极少数允许更多但必须有理由）
- G3：feature 分组 + 共享 utils 扁平化（决策 Q1=C）
- G4：单 spec 多阶段执行（决策 Q2=A），13 phase
- G5：Golden snapshot 测试驱动，每 phase 必须 diff 干净（决策 Q3=B）
- G6：零行为变更——所有 30 个 snapshot 端点的响应形状不变
- G7：`server.ts` 退化为 < 200 行装配入口

### 非目标
- N1：增加任何新功能或修复任何已知 bug（包括 ohlcv `limit` 不生效、`/api/binance/order` 501 等）
- N2：改进性能、缓存、错误处理统一、命名一致性等"代码质量"项目（独立 spec）
- N3：添加后端单元测试（独立 spec）
- N4：内部 API（函数签名、参数顺序）的优化——拆分时尽量保持原签名，仅做必要调整
- N5：依赖升级、tsconfig 收紧、新增 lint 规则
- N6：删除任何"看起来没用"的代码——除非 grep 确认 0 引用且不在外部 API 中
- N7：前端任何改动

---

## 3. 决策摘要

| # | 决策 | 答案 |
|---|---|---|
| Q1 | 拆分粒度 | **C** 轻量混合：feature 分组 + 共享 utils 扁平化 `core/` |
| Q2 | spec 数量 | **A** 单 spec 多阶段（13 phase） |
| Q3 | 回归测试 | **B** Golden snapshot（形状骨架 + error 字符串内容） |
| 自决 | snapshot baseline 是否 commit | 是 |
| 自决 | snapshot diff 例外字段 | `error` 字符串内容必须对比；其他叶子值对比类型描述符 |
| 自决 | 模块导出风格 | 显式 import，不用 barrel；可变状态用 getter/setter 函数封装 |
| 自决 | 路由注册风格 | 每个 `routes/*.ts` 导出 `register<F>Routes(app, deps)` |
| 自决 | 冷启动顺序 | core → stores → exchanges → auto-trading → middleware → routes |
| 自决 | Phase 8 plan B | 不可拆则保留 auto-trading 在 server.ts，仅整理 imports |

---

## 4. 目标文件布局

```
src-server/
├── core/                          # 共用工具（无 feature 依赖）
│   ├── proxy.ts                   # apply/clear/disable/restore/canConnectToProxy/isLocalProxyUrl
│   ├── retry.ts                   # retry 工具
│   ├── cache.ts                   # cachedPublicMarket（含 TTL Map）
│   ├── files.ts                   # writeFileAtomic + fileWriteQueue
│   ├── crypto.ts                  # hashSecret, timingSafeEqualString
│   ├── env.ts                     # envText, hasText, mergeText
│   └── sleep.ts                   # sleep 工具
│
├── exchanges/
│   ├── factory.ts                 # ExchangeName, isExchangeName, getExchangeCtor, buildExchangeOptions, getPublicExchange, getPrivateExchange, publicExchanges/privateExchanges Map
│   ├── symbols.ts                 # toCcxtSymbol, toOkxSwapInstId, toCcxtLikeSwapSymbol
│   ├── connectivity.ts            # ExchangeProxyStatus / ExchangeConnectivityStatus 类型 + 状态变更函数 + probeOkxPublicApiForAutoTrading + formatExchangeConnectivityError + isExchangeConnectivityFailure
│   ├── okx/
│   │   ├── api.ts                 # okxPublicGet, okxBar, fetchOkxTradeOrderRaw
│   │   ├── normalize.ts           # normalizeOkxOrderStatus, normalizeOkxRawOrder, normalizeOkxHistoryOrder, unwrapOkxApiRow(s), normalizeOkxBalance, normalizeOkxPosition
│   │   ├── markets.ts             # OkxResolvedSwapMarket type, resolveOkxSwapMarket, findLoadedOkxSwapMarket, ceilToStep, formatToStepString
│   │   ├── errors.ts              # parseOkxErrorDetails
│   │   └── orders.ts              # submitOkxOrder, buildOkxAttachAlgoOrds
│   └── impls.ts                   # 10 个 *Impl 函数（balance/ticker/orderbook/tickers/ohlcv/funding/positions/history/realized-pnl/order）+ sendImpl + ImplResult 类型 + normalizeBinancePosition
│
├── credentials/
│   ├── store.ts                   # CredentialStore 类型 + load/persist + 加密 (encryptCredentials, decryptCredentials, getCredentialKey, getCredentialSecret)
│   ├── resolve.ts                 # resolveCredentialsFor, resolveOkxCredentials, resolveActiveExchangeName, hasOkxCredentials, OkxCredentials 类型
│   └── admin-password.ts          # adminPasswordHash 加载（从 LOCAL_ADMIN_PASSWORD_FILE 或 env）
│
├── stores/
│   ├── audit.ts                   # auditStore 类型 + addToAudit + loadAuditStore + persistAuditStore + STRATEGY_VERSION
│   ├── operations.ts              # OperatorSession, SecurityEvent, OrderLifecycleEvent 类型 + appStore + persistAppStore + addSecurityEvent + addOrderLifecycle + getSession
│   ├── risk.ts                    # PersistentRiskState 类型 + 加载/持久化
│   └── trading-db.ts              # SQLite 设置 + recordTrade + 查询函数（按当前 TradingDB 命名）
│
├── auto-trading/
│   ├── types.ts                   # AutoTradingConfig, AutoTradingStatus, AutoTradingEngineState, AutoTradingCycleSummary, AutoTradingTrace, ManagedTakeProfitOrder
│   ├── preflight.ts               # assertAutoTradingExchangeReady, buildAutoTradingPreflightPayload, failAutoTradingPreflight
│   ├── tp-manager.ts              # TpManager 类（managed take-profit/stop-loss）
│   ├── engine.ts                  # 引擎主循环、cycle execution、shadow mode、kill switch
│   └── persistence.ts             # auto-trading config 持久化（如果当前有专门函数）
│
├── strategies/                    # 暂留空，phase 9 实施时根据现有代码再决定切分
│
├── backtest/                      # 暂留空，phase 9 实施时再细化
│
├── ai/
│   └── analyze.ts                 # /api/ai/analyze 处理函数 + getZhipuConfig（虽然现在用 DeepSeek，函数名保留）
│
├── routes/                        # 路由注册函数
│   ├── auth.ts                    # registerAuthRoutes(app, deps): /api/auth/login /session /logout
│   ├── config.ts                  # registerConfigRoutes(app, deps): /api/config/status, /credentials (POST/DELETE)
│   ├── settings.ts                # registerSettingsRoutes(app, deps): /api/settings/exchange (GET/POST), /binance-credentials
│   ├── audit.ts                   # registerAuditRoutes(app, deps): /api/audit/* /api/security/* /api/orders/* /api/risk/*
│   ├── exchanges.ts               # registerExchangesRoutes(app, deps): 20 个 /api/okx/* + /api/binance/* 路由
│   ├── auto-trading.ts            # registerAutoTradingRoutes(app, deps): /api/auto-trading/*
│   ├── trades.ts                  # registerTradesRoutes(app, deps): /api/trades, /api/strategy/signals, /api/shadow/*
│   ├── portfolio.ts               # registerPortfolioRoutes(app, deps): /api/portfolio/returns, /api/research/weekly, /api/macro
│   ├── backtest.ts                # registerBacktestRoutes(app, deps): /api/backtest, /api/backtest/walk-forward
│   ├── ai.ts                      # registerAiRoutes(app, deps): /api/ai/analyze
│   └── notify.ts                  # registerNotifyRoutes(app, deps): /api/notify
│
├── middleware/
│   └── auth.ts                    # requireOperator, requireAdmin（如果有）
│
└── server.ts                      # < 200 行入口：env 加载、stores 初始化、exchanges 装配、auto-trading 启动、middleware/routes 注册、express listen
```

**约束**：
- 所有跨模块通信用 ES module imports，**不创建 `index.ts` barrel files**（避免循环依赖）
- 可变全局状态用 getter/setter 函数封装：例如 `stores/audit.ts` 不 export `auditStore` 直接量，而 export `getAuditStore()` 和 `addToAudit(list, item)`
- 跨模块共享类型：放在拥有该类型的模块（如 `CredentialStore` 在 `credentials/store.ts`），消费者 import
- 跨多个 feature 的类型：放在 `core/types.ts`（目前没有，按需创建）

---

## 5. Golden Snapshot 系统（Phase 0）

### 5.1 形状归一化

把 JSON 响应的每个**叶子值**替换为类型描述符，保留**键名、嵌套结构、数组长度**：

```jsonc
// 原始
{ "symbol": "BTC/USDT:USDT", "last": 78294.4, "info": { "instId": "BTC-USDT-SWAP" } }

// 形状（用于比对）
{ "symbol": "<string>", "last": "<number>", "info": { "instId": "<string>" } }
```

### 5.2 例外：error 字符串

`error` 字段的**字符串内容**必须对比（refactor 不能改 error message wording）：

```jsonc
{ "error": "Missing OKX credentials" }       // 不归一化为 <string>，而保留原文
```

实现：归一化函数遇到 `error: string` 时直接保留原值。

### 5.3 数组长度容忍

```jsonc
"prices": ["<number>", "<number>", "<number>"]    // 长度作为骨架的一部分
```

但市场数据条数会有 ±1 的微变（新条目刚生成）。归一化时数组用 `<array len=N±1>` 描述符，diff 时 N 容忍 ±1。

### 5.4 例外：可选键的出现/消失

如果 baseline 里某 key 不存在但 current 里出现了——**默认报警**。需显式认可后写入 baseline.json。

### 5.5 Snapshot 覆盖端点（约 30 个）

```
GET  /api/auth/session                      （with token）
GET  /api/config/status
GET  /api/settings/exchange
GET  /api/audit/summary
GET  /api/security/events
GET  /api/orders/lifecycle
GET  /api/risk/state
GET  /api/auto-trading/status
GET  /api/auto-trading/config
GET  /api/auto-trading/logs?limit=5
GET  /api/auto-trading/cycles?limit=5
GET  /api/auto-trading/traces?limit=5
GET  /api/trades
GET  /api/strategy/signals
GET  /api/shadow/orders
GET  /api/shadow/summary
GET  /api/portfolio/returns                 （with sample range）
GET  /api/research/weekly
GET  /api/macro
POST /api/okx/balance       (expect 400)
GET  /api/okx/ticker/BTC-USDT-SWAP
GET  /api/okx/orderbook/BTC-USDT-SWAP
GET  /api/okx/tickers
GET  /api/okx/ohlcv/BTC-USDT-SWAP?t=1h&limit=5
GET  /api/okx/funding/BTC-USDT-SWAP
POST /api/okx/positions     (expect 400)
POST /api/okx/history       (expect 400)
POST /api/okx/realized-pnl  (expect 400)
POST /api/binance/balance
GET  /api/binance/ticker/BTC-USDT-SWAP
GET  /api/binance/orderbook/BTC-USDT-SWAP
GET  /api/binance/tickers
GET  /api/binance/ohlcv/BTC-USDT-SWAP?t=1h&limit=5
GET  /api/binance/funding/BTC-USDT-SWAP
POST /api/binance/positions
POST /api/binance/history          (expect [])
POST /api/binance/realized-pnl     (expect special shape)
```

**不打**：`/api/okx/order` `/api/binance/order`（下真单）、`/api/ai/analyze`（花钱）、`/api/notify`（发邮件）、`/api/auto-trading/start|stop|run-once`（启动引擎）。

### 5.6 工作流

```bash
# Phase 0 一次性建立 baseline（拆分开始之前）
node scripts/snapshot-capture.mjs > snapshots/baseline.json
git add snapshots/baseline.json && git commit -m "snapshots: capture baseline before refactor"

# 每个 phase 完成后
node scripts/snapshot-capture.mjs > /tmp/current.json
node scripts/snapshot-diff.mjs snapshots/baseline.json /tmp/current.json
# 退出码 0 → 通过；非 0 → diff 内容打印到 stdout，agent 检查并修复
```

### 5.7 脚本启动逻辑

`snapshot-capture.mjs` 检测 `127.0.0.1:3000` 是否监听：
- 已监听：直接打
- 未监听：spawn `npm run dev`，等待 `Listening on http://127.0.0.1:3000` 字串，打完 snapshot 后 kill

### 5.8 文件位置

```
scripts/snapshot-capture.mjs     # 抓取 + 归一化（合二为一，输出到 stdout）
scripts/snapshot-diff.mjs        # 比对（args: baseline.json current.json）
snapshots/baseline.json          # Phase 0 的产物，commit 进 git
.gitignore                       # 添加 /tmp/current.json（如果用 /tmp 之外的路径要相应忽略）
```

### 5.9 例外端点处理

snapshot 脚本对每个端点：
- 调用 1 次，超时 15s
- 失败则 retry 1 次
- 仍失败：在该端点位置记录 `<endpoint-error: ${status} ${message}>` 而不中断整体 capture

---

## 6. Phase 顺序

| Phase | 抽出目标 | 依赖 | 风险 | 验证 |
|---|---|---|---|---|
| 0 | snapshot 脚本 + baseline.json | 无 | - | 跑一次，看 snapshot 是否合理 |
| 1 | `core/*` (proxy / retry / cache / files / crypto / env / sleep) | 无 | 低 | snapshot diff |
| 2 | `credentials/*` | core | 低 | snapshot diff |
| 3 | `stores/*` (audit / operations / risk / trading-db) | core, credentials | 低 | snapshot diff |
| 4 | `exchanges/factory + symbols + connectivity` | core | 低 | snapshot diff |
| 5 | `exchanges/okx/*` (api / normalize / markets / errors / orders) | exchanges/factory + symbols | 中 | snapshot diff |
| 6 | `exchanges/impls.ts` | exchanges/okx | 中 | snapshot diff |
| 7 | `ai/analyze.ts` | core | 低 | snapshot diff |
| 8 | `auto-trading/*` | exchanges, stores | **高** | snapshot diff |
| 9 | `strategies/*` + `backtest/*` | exchanges, core | 中 | snapshot diff |
| 10 | `middleware/auth.ts` | credentials, stores/operations | 低 | snapshot diff |
| 11 | `routes/*` (11 个 route 文件) | 上面全部 | 中 | snapshot diff |
| 12 | server.ts 退化为 < 200 行入口 | - | 低 | snapshot diff + 启动 server 看正常 |
| 13 | 最终验证：lint / vitest / build / snapshot diff / `wc -l server.ts` | - | - | - |

### 6.1 每个 Phase 的工作模式

1. 抽出代码到新文件
2. 在 `server.ts` 用 `import` 引用（而不是删除）
3. **每个文件抽出后立即 commit**——细粒度便于 revert
4. 整个 phase 完成后跑：
   - `npm run lint` 必须 0 错误（exit 0）
   - `npx vitest run` 必须全过（exit 0）
   - `npm run build` 必须成功（exit 0）
   - `node scripts/snapshot-capture.mjs > /tmp/current.json && node scripts/snapshot-diff.mjs snapshots/baseline.json /tmp/current.json` 必须 **exit 0**——脚本应在形状一致时输出空 + exit 0，有任何字段差异时输出 diff + exit 1
5. 4 项全过才进入下一 phase；任何一项失败，agent 修复或 BLOCK 不进入下一 phase

### 6.2 Phase 8 (auto-trading) Plan B

如果 subagent 在 Phase 8 报告"auto-trading 内部耦合不可拆"——具体定义：subagent 已尝试至少 **2 种不同的拆分方案**（例如先抽 tp-manager vs 先抽 cycle execution）且每种都因循环依赖或共享闭包变量无法在不破坏行为的前提下完成——则允许：
- 仅把 `auto-trading/types.ts` 和 `auto-trading/preflight.ts` 抽出
- 引擎和 tp-manager 留在 server.ts，但用形如 `// === auto-trading engine begin ===` / `// === auto-trading engine end ===` 注释划分代码块
- 此 phase 提前完成；剩余拆分作为独立 spec 处理

### 6.3 Phase 11 (routes) 的注册风格

每个 `routes/*.ts` 导出 `register*Routes(app: Express)`，**不传 deps**：

```ts
// routes/auth.ts
import type { Express } from "express";
import { getCredentialStore } from "../credentials/store";
import { addSecurityEvent } from "../stores/operations";
import { hashSecret, timingSafeEqualString } from "../core/crypto";

export function registerAuthRoutes(app: Express) {
  app.post("/api/auth/login", async (req, res) => {
    const store = getCredentialStore();
    const adminPasswordHash = store.adminPasswordHash;  // 或专门的 getter
    // ...
  });
  app.get("/api/auth/session", (req, res) => { ... });
  app.post("/api/auth/logout", async (req, res) => { ... });
}
```

理由：
- 模块通过 getter/setter 暴露状态（§4 约束），路由直接调 getter 即可
- "deps 注入便于测试" 在没有后端测试的当下是过度设计；将来加测试时单测可用 vitest mock
- 避免装配代码冗长

`server.ts` 装配只是按顺序调 11 个 register 函数：

```ts
registerAuthRoutes(app);
registerExchangesRoutes(app);
// ... 等等
```

### 6.4 冷启动顺序

```ts
// server.ts (拆分后估计 150-200 行)
import express from "express";
import { loadCredentialStore } from "./credentials/store";
import { loadAuditStore } from "./stores/audit";
import { loadAppStore } from "./stores/operations";
import { initTradingDB } from "./stores/trading-db";
import { startAutoTradingEngine } from "./auto-trading/engine";
import { requireOperator } from "./middleware/auth";
import { registerAuthRoutes } from "./routes/auth";
// ... 11 个 register imports

async function main() {
  // load 函数把数据装进各模块自己的内部 state，无返回值（或返回 void）
  await loadCredentialStore();
  await loadAuditStore();
  await loadAppStore();
  await initTradingDB();
  await startAutoTradingEngine();   // 自动从持久化 state 恢复

  const app = express();
  app.use(express.json());
  app.use("/api", requireOperator);
  registerAuthRoutes(app);
  registerExchangesRoutes(app);
  // ... 11 个 register
  app.use(serveFrontend());
  app.listen(PORT, () => console.log(`[Server] Listening on http://127.0.0.1:${PORT}`));
}

main().catch(err => {
  console.error("Server boot failed:", err);
  process.exit(1);
});
```

**目标**：装配后 server.ts ≤ 200 行。**硬上限**：300 行（超过则进一步拆出更多 helper）。

---

## 7. 错误处理 / 边界

| 场景 | 行为 |
|---|---|
| 抽出后 lint 报错 | agent 立即修复，不进入下一 phase；不超过 3 轮自修复，否则 BLOCK |
| Snapshot diff 失败 | agent 不 commit；分析 diff，要么修复（行为变了），要么显式更新 baseline.json（行为故意变化，需写理由到 commit message） |
| Build 失败 | 同 lint |
| vitest 失败 | 同 lint |
| 发现循环依赖（runtime 报错） | 重新设计该模块的导入边界；如果该 phase 的某个文件无法独立无环，回退该文件，留在 server.ts，标 TODO |
| 发现某 helper 实际跨多个 feature 用 | 提到 `core/` 而不是塞进单一 feature |

---

## 8. 测试

本 spec **不增加新单元测试**（目标 N3）。仅依赖：
- 现有 11 个 vitest 单测（前端 + lib 层）继续通过
- Phase 0 建立的 30 个 endpoint snapshot 作为回归网

后端单元测试是后续独立 spec。

---

## 9. 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | 全局可变状态（credentialStore, appStore 等）在拆分后被多处 import 形成隐式耦合 | 用 getter/setter 函数封装；运行时单一实例靠 `loadX()` 一次性加载，后续读写都通过函数调用 |
| R2 | 拆分破坏 auto-resume 行为（auto-trading 重启） | snapshot 端点包含 `/api/auto-trading/status` 和 `/api/auto-trading/config`，行为变化会被 diff 捕获 |
| R3 | 循环依赖（core import exchanges import core） | 严格按 §6 phase 依赖顺序拆；core 必须保持无对其他 feature 的 import |
| R4 | tsx 加载多文件项目时 startup 慢 | 实测；如果加载时间 > 5s，考虑用 esbuild bundle 后再跑 |
| R5 | 重构期间 `feat/binance-integration` 分支越拉越长，与 master 冲突 | 本 spec 完成后立即 merge 到 master（或 squash merge） |
| R6 | snapshot 脚本本身有 bug 导致误判 | Phase 0 跑通后**手工核对** baseline.json 一遍：键名是否合理、骨架结构是否符合直觉，确认无误后再 commit |
| R7 | Phase 8 auto-trading 抽不出 | 已有 §6.2 Plan B：保留在 server.ts |
| R8 | snapshot 端点数量不全，漏掉的端点形状变化没被发现 | 拆分前期就要警惕；§5.5 列表是初始版本，可在 Phase 0 跑通后微调；任何重要端点遗漏在 review 阶段补上 |

---

## 10. 回滚

每个 phase 由若干小 commit 组成。如需回退：
- 回退一个文件抽取：`git revert <single-commit-sha>`
- 回退整个 phase：`git revert <range>` 或 `git reset --hard <pre-phase-sha>`（仅在分支独占时安全）

最坏情况——拆分中途彻底放弃：`git reset --hard <Binance-集成完成的 commit>` 或 `git checkout master && git branch -D feat/server-decomposition`（如果用了独立分支）。

---

## 11. 实施提示（写给后续 plan 阶段）

1. 本 spec 的 plan 应在新分支 `feat/server-decomposition` 上执行（不混在 `feat/binance-integration` 上），避免和 Binance 集成 PR review 冲突
2. 实际 commit 数预计 60-100：每个 phase 5-10 个 commit
3. 实际工作时长预计 4-6 小时（多个 subagent dispatch），可能跨多个会话
4. 优先用 `general-purpose` subagent；Phase 8 (auto-trading) 风险高，可考虑用 opus 模型
5. 每个 phase 完成 + 验证通过后**强烈建议告知用户**——这是天然的暂停/回顾点
6. snapshot 系统是本次重构的安全网，任何"省时间不跑 diff"的捷径都不能允许
