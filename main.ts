// Mean Reversion with Tight Risk Control
// Catches oversold bounces, cuts losses fast, small position size

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput, type Hello } from './vendor/makefun-bars.ts';

const FAST_EMA_SPAN = 20;
const VOL_EMA_SPAN = 50;
const ENTRY_ZSCORE = -2.5;
const TAKE_PROFIT_BPS = 30;    // Exit at +30 bps from entry
const STOP_LOSS_BPS = 30;      // Exit at -30 bps from entry
const MIN_BARS_BETWEEN_TRADES = 60;
const POSITION_WEIGHT_BPS = 2000;  // 20% of equity per trade
const MAX_SLIPPAGE_BPS = 50;

interface SymbolState {
  fastEma: number;
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
    s = { fastEma: 0, volEma: 0, lastClose: 0, lastTradeBar: -999, inPosition: false, entryPrice: 0, entryBar: -1 };
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

      s.fastEma = emaUpdate(s.fastEma, close, FAST_EMA_SPAN);

      if (s.lastClose > 0) {
        const ret = (close - s.lastClose) / s.lastClose;
        s.volEma = emaUpdateVar(s.volEma, ret, 0, VOL_EMA_SPAN);
      }
      s.lastClose = close;

      const stdDev = s.volEma > 0 ? Math.sqrt(s.volEma) * close : 0;
      const zScore = s.fastEma > 0 && stdDev > 0 ? (close - s.fastEma) / stdDev : 0;

      const held = st.positions.get(sym);
      const canTrade = seq - s.lastTradeBar >= MIN_BARS_BETWEEN_TRADES;

      if (held !== undefined) {
        const entryPrice = s.entryPrice;
        const pnlBps = entryPrice > 0 ? (close - entryPrice) / entryPrice * 10000 : 0;
        let shouldExit = false;

        if (pnlBps >= TAKE_PROFIT_BPS) shouldExit = true;
        if (pnlBps <= -STOP_LOSS_BPS) shouldExit = true;
        if (seq - s.entryBar > 120) shouldExit = true;  // Max 2 hours

        if (shouldExit && canTrade) {
          orders.push({ side: 'sell', symbol: sym, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.inPosition = false;
          s.lastTradeBar = seq;
          continue;
        }
      }

      if (!s.inPosition && canTrade) {
        if (zScore <= ENTRY_ZSCORE && stdDev > 0) {
          const maxWeight = BigInt(caps.max_weight_bps);
          const weightRoom = (maxWeight * st.equity) / BPS - st.value(sym, held?.qty ?? 0n);
          const targetNotional = (st.equity * BigInt(POSITION_WEIGHT_BPS)) / BPS;
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
