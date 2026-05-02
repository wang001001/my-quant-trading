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
