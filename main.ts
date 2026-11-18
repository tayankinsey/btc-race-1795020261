// Conservative Regime-Aware Mean Reversion for cbBTC/USDC 1m bars
// Stays in cash in downtrends, trades oversold bounces in ranging/uptrending markets

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput, type Hello } from './vendor/makefun-bars.ts';

// Configuration
const FAST_EMA_SPAN = 20;      // Short-term price EMA
const SLOW_EMA_SPAN = 200;     // Long-term trend EMA
const VOL_EMA_SPAN = 50;       // Volatility estimation
const ENTRY_ZSCORE = -2.0;     // Enter when price this many std devs below mean
const EXIT_ZSCORE = 0.0;       // Exit at mean reversion
const STOP_LOSS_ZSCORE = -3.5; // Hard stop if keeps dropping
const VOL_TARGET_BPS = 50;     // Target daily vol in bps (annualized ~15%)
const MIN_BARS_BETWEEN_TRADES = 30; // Min bars between trades (fee control)
const MAX_SLIPPAGE_BPS = 100;  // 1% max slippage from decision close

interface SymbolState {
  priceEma: number;
  slowEma: number;
  volEma: number;    // EMA of squared returns
  lastClose: number;
  lastTradeBar: number;
  inPosition: boolean;
  entryPrice: number;
  entryBar: number;
}

const state = new Map<string, SymbolState>();

function initSymbol(symbol: string): SymbolState {
  return { priceEma: 0, slowEma: 0, volEma: 0, lastClose: 0, lastTradeBar: -999, inPosition: false, entryPrice: 0, entryBar: -1 };
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
    // Seed symbol states
    for (const s of h.symbols) state.set(s.symbol, initSymbol(s.symbol));
  },

  onBatch(st, batch) {
    if (st.warmingUp) return [];

    const orders: (BuyInput | SellInput)[] = [];
    const { caps, fees } = st.hello;

    for (const bar of batch.bars) {
      const sym = bar.symbol;
      const s = state.get(sym)!;
      const close = Number(bar.c);
      const seq = batch.seq;

      // Update EMAs
      s.priceEma = emaUpdate(s.priceEma, close, FAST_EMA_SPAN);
      s.slowEma = emaUpdate(s.slowEma, close, SLOW_EMA_SPAN);

      // Update volatility (EMA of squared returns)
      if (s.lastClose > 0) {
        const ret = (close - s.lastClose) / s.lastClose;
        s.volEma = emaUpdateVar(s.volEma, ret, 0, VOL_EMA_SPAN);
      }
      s.lastClose = close;

      // Regime detection: downtrend if price well below slow EMA
      const inDowntrend = s.slowEma > 0 && close < s.slowEma * 0.995;

      // Z-score: how many std devs from short-term mean
      const stdDev = s.volEma > 0 ? Math.sqrt(s.volEma) * close : 0;
      const zScore = s.priceEma > 0 && stdDev > 0 ? (close - s.priceEma) / stdDev : 0;

      const held = st.positions.get(sym);
      const canTrade = seq - s.lastTradeBar >= MIN_BARS_BETWEEN_TRADES;

      // Exit logic
      if (held !== undefined) {
        let shouldExit = false;

        // Mean reversion exit
        if (zScore >= EXIT_ZSCORE) shouldExit = true;

        // Stop loss
        if (zScore <= STOP_LOSS_ZSCORE) shouldExit = true;

        // Trend break exit
        if (inDowntrend && zScore < -1) shouldExit = true;

        // Time-based exit (max hold ~4 hours)
        if (seq - s.entryBar > 240) shouldExit = true;

        if (shouldExit && canTrade) {
          orders.push({
            side: 'sell',
            symbol: sym,
            qty: held.qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          s.inPosition = false;
          s.lastTradeBar = seq;
          continue;
        }
      }

      // Entry logic
      if (!s.inPosition && !inDowntrend && canTrade) {
        // Only enter on significant overshoot in non-downtrending market
        if (zScore <= ENTRY_ZSCORE && stdDev > 0) {
          // Position sizing: target volatility
          const dailyVolBps = Math.sqrt(s.volEma) * Math.sqrt(1440) * 10000; // annualize to daily bps
          const volScale = dailyVolBps > 0 ? VOL_TARGET_BPS / dailyVolBps : 1;
          const targetWeight = Math.min(volScale, 1.0) * 0.8; // Cap at 80% of Kelly

          const maxWeight = BigInt(caps.max_weight_bps);
          const weightRoom = (maxWeight * st.equity) / BPS - st.value(sym, held?.qty ?? 0n);
          const targetNotional = st.equity * BigInt(Math.floor(targetWeight * 10000)) / BPS;
          const notional = targetNotional < weightRoom ? targetNotional : weightRoom;

          const minNotional = BigInt(fees.min_notional_quote_units);
          if (notional >= minNotional && notional > 0n && st.cash >= notional) {
            orders.push({
              side: 'buy',
              symbol: sym,
              notional_quote_units: notional,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            });
            s.inPosition = true;
            s.entryPrice = close;
            s.entryBar = seq;
            s.lastTradeBar = seq;
          }
        }
      }
    }

    // Respect order cap
    return orders.slice(0, caps.max_orders_per_bar);
  },
});
