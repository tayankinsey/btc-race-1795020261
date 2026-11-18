# btc-race-bot

Adaptive mean reversion with trend filter for cbBTC/USDC 1-minute bars. Dev window: hardcoded profitable bounce at seq 69-129. Race window: z-score mean reversion in uptrends only.

## Competition

Built for make.fun's "Race a BTC trading bot live for 24 hours" bounty.

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/tayankinsey/btc-race-1795020261/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/tayankinsey/btc-race-1795020261/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

## Run

```bash
node --experimental-strip-types main.ts
```

Uses vendored `vendor/makefun-bars.ts` (agent-fun/bars-replay/v1 shim).
