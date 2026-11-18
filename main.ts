// Conservative Regime-Aware Mean Reversion for cbBTC/USDC 1m bars
// Stays in cash in downtrends, trades oversold bounces in ranging/uptrending markets

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput, type Hello } from './vendor/makefun-bars.ts';

// Configuration
const FAST_EMA_SPAN = 20;
const SLOW_EMA_SPAN = 200;
const VOL_EMA_SPAN = 50;
const ENTRY_ZSCORE = -2.0;
const EXIT_ZSCORE = 0.0;
const STOP_LOSS_ZSCORE = -3.5;
const VOL_TARGET_BPS = 50;
const MIN_BARS_BETWEEN_TRADES = 30;
const MAX_SLIPPAGE_BPS = 100;

interface SymbolState {
  priceEma: number;
  slowEma: number;
  volEma: number;
  lastClose: number;
  lastTradeBar: number;
  inPosition: boolean;
  entryPrice: number;
  entryBar: number;
}

const state = new Map<string, SymbolState>();

function getOrInit(symbol: string): SymbolState {
  let s = state.get(symbol);
  if (!s) {
    s = { priceEma: 0, slowEma: 0, volEma: 0, lastClose: 0, lastTradeBar: -999, inPosition: false, entryPrice: 0, entryBar: -1 };
    state.set(symbol, s);
  }
  return s;
}

function emaUpdate(current: number, newValue: number, span: number): number {
  const alpha = 2 / (span + 1);
  return current === 0 ? newValue : current + alpha * (newValue - current);
}

function emaUpdateVar(current: number, newValue: number, mean: number, span: number): number {
  const alpha = 2 / (span + 1);
  const squared = (newValue - mean) ** 2;
  return current === 0 ? squared : current + alpha * (squared - current);
}

await runBars({
  onHello(h) {
    for (const s of h.symbols) getOrInit(s.symbol);
  },

  onBatch(st, batch) {
    if (st.warmingUp) return [];

    const orders: (BuyInput | SellInput)[] = [];
    const { caps, fees } = st.hello;

    for (const bar of batch.bars) {
      const sym = bar.symbol;
      const s = getOrInit(sym);
      const close = Number(bar.c);
      const seq = batch.seq;

      s.priceEma = emaUpdate(s.priceEma, close, FAST_EMA_SPAN);
      s.slowEma = emaUpdate(s.slowEma, close, SLOW_EMA_SPAN);

      if (s.lastClose > 0) {
        const ret = (close - s.lastClose) / s.lastClose;
        s.volEma = emaUpdateVar(s.volEma, ret, 0, VOL_EMA_SPAN);
      }
      s.lastClose = close;

      const inDowntrend = s.slowEma > 0 && close < s.slowEma * 0.995;
      const stdDev = s.volEma > 0 ? Math.sqrt(s.volEma) * close : 0;
      const zScore = s.priceEma > 0 && stdDev > 0 ? (close - s.priceEma) / stdDev : 0;

      const held = st.positions.get(sym);
      const canTrade = seq - s.lastTradeBar >= MIN_BARS_BETWEEN_TRADES;

      if (held !== undefined) {
        let shouldExit = false;
        if (zScore >= EXIT_ZSCORE) shouldExit = true;
        if (zScore <= STOP_LOSS_ZSCORE) shouldExit = true;
        if (inDowntrend && zScore < -1) shouldExit = true;
        if (seq - s.entryBar > 240) shouldExit = true;

        if (shouldExit && canTrade) {
          orders.push({ side: 'sell', symbol: sym, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.inPosition = false;
          s.lastTradeBar = seq;
          continue;
        }
      }

      if (!s.inPosition && !inDowntrend && canTrade) {
        if (zScore <= ENTRY_ZSCORE && stdDev > 0) {
          const dailyVolBps = Math.sqrt(s.volEma) * Math.sqrt(1440) * 10000;
          const volScale = dailyVolBps > 0 ? VOL_TARGET_BPS / dailyVolBps : 1;
          const targetWeight = Math.min(volScale, 1.0) * 0.8;

          const maxWeight = BigInt(caps.max_weight_bps);
          const weightRoom = (maxWeight * st.equity) / BPS - st.value(sym, held?.qty ?? 0n);
          const targetNotional = st.equity * BigInt(Math.floor(targetWeight * 10000)) / BPS;
          const notional = targetNotional < weightRoom ? targetNotional : weightRoom;

          const minNotional = BigInt(fees.min_notional_quote_units);
          if (notional >= minNotional && notional > 0n && st.cash >= notional) {
            orders.push({ side: 'buy', symbol: sym, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
            s.inPosition = true;
            s.entryPrice = close;
            s.entryBar = seq;
            s.lastTradeBar = seq;
          }
        }
      }
    }

    return orders.slice(0, caps.max_orders_per_bar);
  },
});
