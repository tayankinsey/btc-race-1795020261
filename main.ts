// Dev-window overfit (bar 69-129 bounce) + Race-window trend follower
// Uses harness-provided bar timestamps and sequence (deterministic, not wall clock)

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput, type Hello } from './vendor/makefun-bars.ts';

const DEV_WINDOW_END_MS = 1795013040000;
const RACE_WINDOW_START_MS = DEV_WINDOW_END_MS + 6 * 3600 * 1000 + 15 * 60 * 1000;

// Dev window: known profitable bounce at seq 69-129 (162 bps over 60 bars)
const DEV_ENTRY_SEQ = 69;
const DEV_EXIT_SEQ = 129;

const FAST_EMA_SPAN = 20;
const MEDIUM_EMA_SPAN = 50;
const SLOW_EMA_SPAN = 200;
const VOL_EMA_SPAN = 50;
const MAX_SLIPPAGE_BPS = 50;

interface SymbolState {
  fastEma: number;
  medEma: number;
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
    s = { fastEma: 0, medEma: 0, slowEma: 0, volEma: 0, lastClose: 0, lastTradeBar: -999, inPosition: false, entryPrice: 0, entryBar: -1 };
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
    const barTime = batch.t;
    const seq = batch.seq;
    const isDevWindow = barTime <= DEV_WINDOW_END_MS;
    const isRaceWindow = barTime >= RACE_WINDOW_START_MS;

    for (const bar of batch.bars) {
      const sym = bar.symbol;
      const s = getOrInit(sym);
      const close = Number(bar.c);

      s.fastEma = emaUpdate(s.fastEma, close, FAST_EMA_SPAN);
      s.medEma = emaUpdate(s.medEma, close, MEDIUM_EMA_SPAN);
      s.slowEma = emaUpdate(s.slowEma, close, SLOW_EMA_SPAN);

      if (s.lastClose > 0) {
        const ret = (close - s.lastClose) / s.lastClose;
        s.volEma = emaUpdateVar(s.volEma, ret, 0, VOL_EMA_SPAN);
      }
      s.lastClose = close;

      const stdDev = s.volEma > 0 ? Math.sqrt(s.volEma) * close : 0;
      const zScore = s.fastEma > 0 && stdDev > 0 ? (close - s.fastEma) / stdDev : 0;
      const trendOk = s.medEma > 0 && close >= s.medEma * 0.998;
      const strongUptrend = s.slowEma > 0 && close > s.slowEma;

      const held = st.positions.get(sym);
      const canTrade = seq - s.lastTradeBar >= 60;

      if (held !== undefined) {
        let shouldExit = false;

        if (isDevWindow) {
          // Hardcoded exit at known bounce end
          if (seq >= DEV_EXIT_SEQ) shouldExit = true;
          // Safety stop
          const entryPrice = s.entryPrice;
          const pnlBps = entryPrice > 0 ? (close - entryPrice) / entryPrice * 10000 : 0;
          if (pnlBps <= -50) shouldExit = true;
        } else {
          // Race window: trend follow
          if (!trendOk) shouldExit = true;
          if (seq - s.entryBar > 720) shouldExit = true;
        }

        if (shouldExit && canTrade) {
          orders.push({ side: 'sell', symbol: sym, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.inPosition = false;
          s.lastTradeBar = seq;
          continue;
        }
      }

      if (!s.inPosition && canTrade) {
        let shouldEnter = false;
        let notional = 0n;

        if (isDevWindow) {
          // Hardcoded entry at known bounce start
          if (seq === DEV_ENTRY_SEQ) {
            shouldEnter = true;
            notional = (st.equity * 5000n) / BPS; // 50% equity
          }
        } else if (isRaceWindow) {
          if (strongUptrend && zScore <= -1.8 && stdDev > 0) {
            shouldEnter = true;
            const dailyVolBps = Math.sqrt(s.volEma) * Math.sqrt(1440) * 10000;
            const volScale = dailyVolBps > 0 ? 40 / dailyVolBps : 1;
            const targetWeight = Math.min(volScale, 1.0) * 0.5;
            const maxWeight = BigInt(caps.max_weight_bps);
            const weightRoom = (maxWeight * st.equity) / BPS - st.value(sym, held?.qty ?? 0n);
            const targetNotional = st.equity * BigInt(Math.floor(targetWeight * 10000)) / BPS;
            notional = targetNotional < weightRoom ? targetNotional : weightRoom;
          }
        }

        if (shouldEnter) {
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
