# Binance 交易所接入设计

- **状态**: Draft (待 user review)
- **日期**: 2026-05-02
- **范围**: cryptoquant-ai 后端 + 前端
- **后续 spec**: 整个系统的合理优化（独立 spec，本 spec 完成实施后再开）

---

## 1. 背景与动机

当前 cryptoquant-ai 仅支持 OKX，且 OKX 接入是**硬编码**的：
- `server.ts:11` `import ccxt from "ccxt"`
- `server.ts:424` `new (ccxt as any).okx({...})` —— 私有交易实例
- `server.ts:3218` `new (ccxt as any).okx({...})` —— 公共行情实例
- 约 10 个 `/api/okx/*` 路由直接绑死 OKX
- 前端 `SettingsPage.tsx` 只有 OKX 凭证 UI

用户需求：在保留 OKX 的前提下接入 Binance USDT-M 永续合约，可通过设置页全局切换激活的交易所。

同时用户要求**彻底移除模拟盘 (sandbox/demo) 概念**：不再使用 OKX demo 模式，也不接入 Binance testnet。所有交易直接面向实盘。

---

## 2. 目标与非目标

### 目标
- G1：在保留 OKX 全部现有功能的前提下，新增 Binance USDT-M 永续合约支持
- G2：用户可在前端设置页全局切换 "当前激活交易所"，切换后整个 React app 后续请求路由到对应交易所
- G3：彻底移除 sandbox / demo / testnet 相关代码和配置
- G4：原 OKX 路由 `/api/okx/*` 保持向后兼容（legacy bundled JS 仍能工作）
- G5：refactor OKX handler 内部逻辑为可复用的纯函数，让 Binance handler 通过薄包装复用

### 非目标
- N1：现货 (spot) 交易 —— 仅永续，与 OKX 现状对齐
- N2：每个策略选不同交易所的细粒度切换 —— 全局单选即可
- N3：Binance testnet 支持 —— 用户明确放弃
- N4：自动化下单测试 —— 验证由用户手动通过 UI 完成
- N5：服务端架构整体优化（拆分 server.ts、性能优化、可测性等）—— 见独立 spec

---

## 3. 决策摘要（Q&A 结果）

| # | 决策 |
|---|---|
| Q1 | 共存模式：OKX + Binance 并存，可全局切换 |
| Q2 | 切换粒度：全局单选（不做策略级粒度） |
| Q3 | 交易类型：仅 USDT-M 永续合约 |
| Q4 | testnet：不支持。同时移除 OKX demo 模式 |
| Q5 | 测试策略：公共行情自动验证；私有读接口用真实 key 验证；下单接口由用户手动 UI 验证，Claude 不自动下单 |
| §1 | API 路由：保留 `/api/okx/*`，新增 `/api/binance/*`；底层共享 handler 逻辑 |
| §3 | Legacy panels：Binance 激活时**隐藏**入口（不显示老 panels） |

---

## 4. 架构

### 4.1 核心抽象

引入交易所适配层。所有 ccxt 实例化集中到工厂函数，路由 handler 通过工厂获取实例：

```ts
type ExchangeName = "okx" | "binance";

function getExchangeCtor(name: ExchangeName);
function buildExchangeOptions(name: ExchangeName);
function getPublicExchange(name: ExchangeName);
function getPrivateExchange(name: ExchangeName, apiKey: string, secret: string, password?: string);
function resolveActiveExchangeName(): ExchangeName;        // 从 credentialStore 读
function resolveCredentialsFor(name: ExchangeName, body?: any): {apiKey, secret, password?} | null;
```

### 4.2 凭证存储 schema 演进

`credentialStore` 加密存储结构变化：

**旧** (server.ts:3174,3175,3197,5925,5930):
```jsonc
{
  "okx":     { "apiKey", "secret", "password" },
  "okxDemo": { "apiKey", "secret", "password" },   // ← 删除
  "ai":      { ... }
}
```

**新**:
```jsonc
{
  "activeExchange": "okx",   // 新增；老用户加载时若不存在补默认值
  "okx":     { "apiKey", "secret", "password" },   // 不变
  "binance": { "apiKey", "secret" },                // 新增；无 passphrase
  "ai":      { ... }
}
```

加载时迁移：若旧结构存在 `okxDemo` 字段，**静默丢弃**；同时清理所有读取 `credentialStore.okxDemo` 的代码（`server.ts:3175`, `3197`, `5930` 等）。

### 4.3 .env 字段变化

**移除**:
- `OKX_DEMO_API_KEY`
- `OKX_DEMO_SECRET_KEY`
- `OKX_DEMO_PASSPHRASE`

**新增**:
- `BINANCE_API_KEY`
- `BINANCE_SECRET_KEY`
- `ACTIVE_EXCHANGE` (可选，默认 `okx`)

`.env.example` 同步更新。

---

## 5. 后端改动 (`server.ts`)

### 5.1 新增辅助函数（约 60 行）

实现上述 4.1 的工厂函数。`getExchangeCtor` 用 `name === "binance" ? ccxt.binance : ccxt.okx` 二选一。`buildExchangeOptions` 处理 OKX `defaultType: "swap"` vs Binance `defaultType: "future"` 差异。

### 5.2 重构现有代码

| 位置 | 改动 |
|---|---|
| `server.ts:421` `getPrivateExchange(apiKey, secret, password, sandbox)` | 签名改为 `getPrivateExchange(name, apiKey, secret, password?)`；移除 `sandbox` 参数和相关分支（`setSandboxMode`、`x-simulated-trading` header）。约 10 处调用点更新 |
| `server.ts:3218` `const publicExchange = new ccxt.okx(...)` | 改为函数 `getPublicExchange(name)`，内部带 cache。所有引用 `publicExchange` 的代码改为 `getPublicExchange(resolveActiveExchangeName())`。约 5-10 处 |
| `resolveOkxCredentials(...)` | 重命名为 `resolveCredentialsFor(name, body?)`，按 name 分发到 OKX/Binance 凭证读取逻辑 |
| 所有带 `sandbox` / `isSandbox` 参数的 handler / 函数 | 移除该参数和分支。约 8-12 处 |
| `/api/okx/*` 10 个 handler | 把每个 handler 的核心业务逻辑提取为独立异步函数 `async function fetchBalance(name, body)` 等。OKX handler 变成 `(req, res) => doX("okx", req, res)` 的薄包装 |

### 5.3 新增路由

```
POST /api/binance/balance
GET  /api/binance/ticker/:symbol
GET  /api/binance/orderbook/:symbol
GET  /api/binance/tickers
GET  /api/binance/ohlcv/:symbol
GET  /api/binance/funding/:symbol
POST /api/binance/positions
POST /api/binance/history
POST /api/binance/realized-pnl
POST /api/binance/order
```

每个新路由是上述提取出的纯函数的薄包装，仅传入 `name="binance"`。

### 5.4 新增 Settings 路由

```
GET  /api/settings/exchange         → { activeExchange, hasOkx, hasBinance }
POST /api/settings/exchange         → 保存 activeExchange
POST /api/settings/binance-credentials → 保存 Binance API key/secret 到加密存储
```

### 5.5 Symbol 归一化

CCXT 统一 symbol 格式下，OKX 与 Binance USDT-M 永续都是 `BTC/USDT:USDT`。现有 `toCcxtSymbol()` 应开箱即用，**实施第一步需写最小连通测试验证**：

```ts
const x = getPublicExchange("binance");
await x.fetchTicker("BTC/USDT:USDT");
```

---

## 6. 前端改动

### 6.1 全局状态

新增 `activeExchange` 全局状态（实施时按现有项目规范选 React context / Zustand / 已有的 store）。
- 启动时调 `GET /api/settings/exchange` 获取初值
- 切换时 POST 同 endpoint 更新，本地状态同步

### 6.2 `src/app/api.ts`

API 客户端层把所有 `/api/okx/...` 路径改为读取 `activeExchange` 后动态拼接：

```ts
const ex = useExchangeStore.getState().active;
axios.post(`/api/${ex}/balance`, ...)
```

### 6.3 `src/app/pages/SettingsPage.tsx`

- 顶部新增"当前交易所"下拉（OKX / Binance）
- OKX 凭证区：移除 demo 三件套字段，只保留 live 三件套
- 新增 Binance 凭证区：API Key + Secret（无 passphrase）
- 每个交易所凭证区显示 ✓/✗ 已配置状态
- 移除任何 demo/live 切换 UI

### 6.4 切换交易所的副作用

切换激活交易所时不刷新页面，但需触发数据重拉（账户、持仓、订单等数据完全不同）。具体：清空相关组件状态或 React Query 缓存。

### 6.5 Legacy panels (`public/legacy/assets/index-ByqDttXL.js`)

- 文件本身**不动**，永远调 `/api/okx/*`
- React 容器层判断：`activeExchange === "binance"` 时**隐藏 legacy panel 入口**

---

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| `activeExchange=binance` 但 Binance 凭证未配置 | 私有接口返回 `400 "Missing Binance credentials"`；公共行情接口正常工作 |
| Binance 实例化或调用失败 | 复用现有 `retry()` 包装，3 次后返回 500 + 原始错误 |
| 用户切换交易所瞬间，前端正在飞行的请求 | 不管。请求按发起时的 exchange 完成，UI 后续刷新用新 exchange 重拉 |
| Binance 不支持的 OKX 特有参数 | CCXT 抛 `NotSupported`，handler 捕获后返回 501 + 提示 |

---

## 8. 测试计划

### 8.1 自动化（实施过程中由 Claude 跑）

1. **公共行情**: 命中 `/api/binance/ticker/...`、`/api/binance/ohlcv/...`，对比 OKX 返回结构
2. **私有读**: 用用户提供的实盘 key 调 `/api/binance/balance`、`/api/binance/positions`，确认签名与权限正常
3. **TypeScript 全量 lint**: `npm run lint` 通过，确保 sandbox 删除后无遗漏引用
4. **OKX 回归**: 切回 OKX，运行原有 balance/positions/历史等流程，确认 refactor 没破坏 OKX

### 8.2 手动（用户在 UI 上完成）

1. UI 切到 Binance
2. 用最小数量（≥ Binance 最小 notional ~5 USDT）下一笔限价单，价位远离市价不会成交
3. 在 Binance app 上确认订单存在
4. 撤单，确认前端订单消失
5. 回报结果，Claude 不自动执行此步

---

## 9. 风险

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | CCXT 对 Binance 资金费率/历史成交字段命名与 OKX 略有差异，前端展示组件可能需小修 | 实施时打日志看返回结构，不一致时在 handler 做归一化 |
| R2 | `toCcxtSymbol()` 现有实现对 Binance 是否有效未验证 | 实施第一步即写最小连通测试 |
| R3 | 删除 demo 模式后某些 corner-case 仍引用 `sandbox` 变量 | 删除后跑 `tsc --noEmit`，TypeScript 暴露所有未定义引用 |
| R4 | Binance 在中国大陆需要代理 | 复用现有 `EXCHANGE_PROXY_URL` / `applyExchangeProxy()` 机制，确认 Binance 实例也走该代理 |
| R5 | 凭证 schema 迁移失败导致老用户登录后看不到 OKX 凭证 | 加载时保持 `okx` 字段不动；仅丢弃 `okxDemo`；写一条迁移日志便于诊断 |

---

## 10. 回滚

`git revert` 单个 commit 即可恢复到 OKX-only 状态。删除的 demo 代码在 git 历史中可恢复。凭证存储 schema 变化是单向的（demo 字段已删除）；如需回滚到含 demo 的版本，用户需手动重新填入 demo 凭证。

---

## 11. 实施顺序提示（写给后续 plan 阶段）

1. 写最小连通测试（独立小脚本调 `ccxt.binance.fetchTicker`）→ 验证 R2、R4
2. 后端：抽出 `getExchange*` 工厂 + 凭证 schema 迁移逻辑
3. 后端：把 OKX 10 个 handler 拆为纯函数 + 薄包装
4. 后端：新增 Binance 10 个路由 + Settings 路由
5. 后端：删除所有 sandbox / demo 代码（lint 全通过）
6. 前端：全局状态 + API 客户端层改造
7. 前端：SettingsPage 改造 + Legacy panel 隐藏逻辑
8. 自动化测试（行情 + 私有读 + 回归）
9. 用户手动测试下单流程
