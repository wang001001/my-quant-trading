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
