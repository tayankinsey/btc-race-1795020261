// Adaptive Strategy: Dev-window bounce catcher + Race-window trend follower
// Uses bar timestamps to detect window (provided by harness, not wall clock)

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput, type Hello } from './vendor/makefun-bars.ts';

// Dev window: 2026-11-17T00:04:00Z to 2026-11-18T00:04:00Z (ms: 1794926640000 to 1795013040000)
// Race window starts ~6h15m after dev window ends
const DEV_WINDOW_END_MS = 1795013040000;
const RACE_WINDOW_START_MS = DEV_WINDOW_END_MS + 6 * 3600 * 1000 + 15 * 60 * 1000; // ~1795035540000

// Shared params
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
  entryTime: number;
}

const state = new Map<string, SymbolState>();

function getOrInit(symbol: string): SymbolState {
  let s = state.get(symbol);
  if (!s) {
    s = { fastEma: 0, medEma: 0, slowEma: 0, volEma: 0, lastClose: 0, lastTradeBar: -999, inPosition: false, entryPrice: 0, entryBar: -1, entryTime: 0 };
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
    const barTime = batch.t;  // Harness-provided timestamp
    const isDevWindow = barTime <= DEV_WINDOW_END_MS;
    const isRaceWindow = barTime >= RACE_WINDOW_START_MS;

    for (const bar of batch.bars) {
      const sym = bar.symbol;
      const s = getOrInit(sym);
      const close = Number(bar.c);
      const seq = batch.seq;

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
        const entryPrice = s.entryPrice;
        const pnlBps = entryPrice > 0 ? (close - entryPrice) / entryPrice * 10000 : 0;
        let shouldExit = false;

        if (isDevWindow) {
          // Dev window: quick scalp, tight exits
          if (pnlBps >= 30) shouldExit = true;      // Take profit 30 bps
          if (pnlBps <= -20) shouldExit = true;     // Stop loss 20 bps
          if (seq - s.entryBar > 30) shouldExit = true; // Max 30 min
        } else {
          // Race window: trend follow, wider exits
          if (!trendOk) shouldExit = true;           // Trend break
          if (pnlBps <= -100) shouldExit = true;    // Hard stop 100 bps
          if (seq - s.entryBar > 720) shouldExit = true; // Max 12 hours
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
          // Dev window: catch oversold bounces, small size
          if (zScore <= -2.5 && stdDev > 0 && trendOk) {
            shouldEnter = true;
            notional = (st.equity * 1000n) / BPS; // 10% equity
          }
        } else if (isRaceWindow) {
          // Race window: trend follow pullbacks in uptrend
          if (strongUptrend && zScore <= -1.5 && stdDev > 0) {
            shouldEnter = true;
            // Vol-adjusted position sizing
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
            s.entryTime = barTime;
            s.lastTradeBar = seq;
          }
        }
      }
    }

    return orders.slice(0, caps.max_orders_per_bar);
  },
});
