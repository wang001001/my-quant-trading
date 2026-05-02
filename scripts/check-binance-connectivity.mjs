// scripts/check-binance-connectivity.mjs
import "dotenv/config";
import ccxt from "ccxt";
import { HttpsProxyAgent } from "https-proxy-agent";

const proxyUrl = process.env.EXCHANGE_PROXY_URL || "";
const apiKey   = process.env.BINANCE_API_KEY || "";
const secret   = process.env.BINANCE_SECRET_KEY || "";

const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
if (proxyUrl) console.log(`[proxy] using ${proxyUrl}`);

// Public-data instance: no key, so loadMarkets does NOT call private currencies API.
const publicEx = new ccxt.binance({
  enableRateLimit: true,
  options: { defaultType: "future" },
});
if (agent) publicEx.agent = agent;

console.log("[1/3] fetchTicker BTC/USDT:USDT ...");
const ticker = await publicEx.fetchTicker("BTC/USDT:USDT");
console.log(`     last=${ticker.last}  bid=${ticker.bid}  ask=${ticker.ask}`);

console.log("[2/3] fetchOHLCV BTC/USDT:USDT 1h limit=3 ...");
const ohlcv = await publicEx.fetchOHLCV("BTC/USDT:USDT", "1h", undefined, 3);
console.log(`     rows=${ohlcv.length}  lastClose=${ohlcv.at(-1)?.[4]}`);

// Private-data instance: separate from public to avoid triggering spot wallet endpoints
// during loadMarkets when the API key only has Futures permission.
if (apiKey && secret) {
  console.log("[3/3] fetchBalance (private) ...");
  const privateEx = new ccxt.binance({
    apiKey,
    secret,
    enableRateLimit: true,
    options: {
      defaultType: "future",
      // Skip private currencies loading -- futures-only keys don't have spot wallet permission.
      fetchCurrencies: false,
      // Restrict loadMarkets to USDT-M perpetual only; default loads spot+option+future in parallel
      // and the spot call requires permissions that futures-only keys don't have.
      fetchMarkets: ["linear"],
    },
  });
  if (agent) privateEx.agent = agent;
  const balance = await privateEx.fetchBalance({ type: "future" });
  const usdt = balance.total?.USDT ?? 0;
  console.log(`     USDT total=${usdt}`);
} else {
  console.log("[3/3] skipped private check -- set BINANCE_API_KEY + BINANCE_SECRET_KEY in .env to enable");
}

console.log("OK");
