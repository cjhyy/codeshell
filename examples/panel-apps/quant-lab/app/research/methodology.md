# Quant Lab Panel App v1 methodology

## Input data

CSV headers are case-insensitive and must include:

`date,open,high,low,close`

`volume` is optional. Dates must start with a real ISO calendar date in `YYYY-MM-DD` form; an
optional timestamp after `T` or a space is ignored when assigning the daily bar. Prices must be
positive. Rows are sorted ascending, duplicate dates are rejected, and duplicate required/volume
columns are rejected rather than interpreted ambiguously.

Use split- and dividend-adjusted OHLC data when evaluating total-return-like behavior. If raw data
is used, document that limitation in the report.

The panel flags samples shorter than 252 bars, zero/missing volume, weekend observations, calendar
gaps longer than 10 days, and close-to-close moves of at least 35%. These are review prompts, not
proof that a dataset is invalid or adjusted correctly.

## Execution

- Signals are computed after a bar closes.
- Orders execute at the next bar's open with configured slippage and fees.
- The engine is long-only and commits all available cash to each position.
- A configured stop is checked against the current bar's low. Existing positions execute at the
  lower of the bar open and stop level, then apply slippage; a position opened that morning uses the
  stop level. A stopped position cannot re-enter on that same bar. Intraday ordering is therefore
  simplified.
- Any final open position is closed at the final close.
- The buy-and-hold benchmark begins at the first close and ignores fees.

This convention prevents direct same-bar look-ahead but does not model liquidity, spreads, market
impact, delistings, borrow, taxes, corporate actions, or order queueing.

## Bundled signals

- **SMA cross** is long while the fast close SMA is above the slow close SMA.
- **RSI reversion** enters below the oversold threshold and exits above the overbought threshold,
  using Wilder smoothing.
- **Breakout** enters when the close exceeds the highest high of the preceding lookback window and
  exits below the corresponding lowest low. The current bar is excluded from the channel.

## Metrics

- Annualized return assumes 252 observations per year.
- Buy-and-hold return is the final close divided by the first close; excess return is the simple
  difference between strategy and benchmark total return.
- Annualized volatility is the sample standard deviation of close-to-close strategy equity returns
  multiplied by `sqrt(252)`.
- Sharpe uses close-to-close strategy equity returns, a zero risk-free rate, and sample standard
  deviation, annualized by `sqrt(252)`.
- Calmar is annualized return divided by the absolute maximum drawdown and is unavailable when
  drawdown is zero.
- Profit factor is gross winning P&L divided by absolute gross losing P&L and is unavailable when
  there are no losing trades.
- Maximum drawdown is the worst close-equity decline from a prior close-equity peak.
- Exposure is the fraction of bars during which the strategy held a position at any point,
  including a same-day entry and stop; it is still only a coarse daily-bar approximation.
- Win rate counts only closed trades; an open final position is closed at the final close first.

## Strategy spec

Saved `*.quant.json` files use:

```json
{
  "format": "codeshell.quant-strategy",
  "version": 1,
  "name": "AAPL SMA 20/50",
  "dataset": "data/market/AAPL.csv",
  "sample": {
    "bars": 1258,
    "from": "2021-01-04",
    "to": "2025-12-31",
    "fingerprint": "fnv1a32:1a2b3c4d"
  },
  "strategy": {
    "type": "sma-cross",
    "fast": 20,
    "slow": 50
  },
  "execution": {
    "initialCapital": 100000,
    "feeBps": 5,
    "slippageBps": 2,
    "stopLossPct": 8
  }
}
```

Validate saved specs with the colocated `references/quant-strategy-v1.schema.json` schema when a
JSON Schema validator is available. The engine additionally enforces cross-field rules such as
`fast < slow` and `oversold < overbought`, and rejects lookback periods that leave fewer than two
bars after indicator warm-up.

The sample fingerprint is a deterministic FNV-1a change detector over normalized OHLCV rows. It is
not a cryptographic integrity proof; use it to notice dataset drift during review, not to establish
data provenance.

Markdown reports include at most 1,000 trade rows and state how many additional trades were
omitted. Metrics always use the full result.
