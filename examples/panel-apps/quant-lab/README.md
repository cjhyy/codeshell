# Quant Lab Panel App

Quant Lab is an independent CodeShell Desktop Panel App for local stock
research. It is intentionally separate from the agent Plugin system.

It loads repository OHLCV CSV data, runs deterministic long-only backtests,
compares results with buy-and-hold, audits data quality, and saves strategy
specifications and Markdown reports back to the repository.

Install it from **Extensions → Panel Apps → From folder** by selecting this
directory. The dedicated installer reviews its Host permissions and records it
in the Panel App registry; it does not install Skills, MCP servers, Agents,
Commands, or Hooks.

After editing this source directory, use **Update from source** on the installed
Quant Lab card to review and apply the new snapshot.

This is a research tool, not investment advice. The backtest includes explicit
fees, slippage, next-bar execution, and stop-loss assumptions, but it does not
model every real-market constraint.
