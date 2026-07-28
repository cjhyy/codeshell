/* Deterministic research engine used only by the Quant Lab Panel App. */
const TRADING_DAYS = 252;

export function markdownInlineCode(value) {
  const text = String(value).replaceAll("\n", " ");
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

export function markdownPlainText(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([`*_[\]{}()#+.!|])/gu, "\\$1")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

export function fencedMarkdown(content, language = "") {
  const text = String(content);
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
  return parsed;
}

function parseCsvLine(line) {
  const fields = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  fields.push(value.trim());
  return fields;
}

function normalizedHeader(value) {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

export function isSafeCsvPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !value.toLowerCase().endsWith(".csv") ||
    value.startsWith("/") ||
    value.includes(":") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => {
    const windowsBaseName = (segment.split(".", 1)[0] ?? "").trimEnd().toUpperCase();
    return (
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith(".") &&
      segment.toLowerCase() !== "node_modules" &&
      !/[. ]$/u.test(segment) &&
      !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(windowsBaseName)
    );
  });
}

export function parseOhlcvCsv(source) {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("CSV is empty");
  }
  const lines = source
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 3) throw new Error("CSV needs a header and at least two data rows");
  const headers = parseCsvLine(lines[0]).map(normalizedHeader);
  for (const header of ["date", "open", "high", "low", "close", "volume"]) {
    if (headers.filter((candidate) => candidate === header).length > 1) {
      throw new Error(`CSV contains duplicate ${header} columns`);
    }
  }
  const indexOf = (name) => headers.indexOf(name);
  const columns = {
    date: indexOf("date"),
    open: indexOf("open"),
    high: indexOf("high"),
    low: indexOf("low"),
    close: indexOf("close"),
    volume: indexOf("volume"),
  };
  for (const key of ["date", "open", "high", "low", "close"]) {
    if (columns[key] < 0) throw new Error(`CSV is missing the ${key} column`);
  }
  const bars = [];
  const dates = new Set();
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const fields = parseCsvLine(lines[lineIndex]);
    const rawDate = fields[columns.date];
    const dateMatch = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/.exec(rawDate ?? "");
    const date = dateMatch?.[1];
    const parsedDate = date ? new Date(`${date}T00:00:00Z`) : null;
    if (
      !date ||
      !parsedDate ||
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== date
    ) {
      throw new Error(`row ${lineIndex + 1} has an invalid date`);
    }
    if (dates.has(date)) throw new Error(`row ${lineIndex + 1} duplicates date ${date}`);
    dates.add(date);
    const bar = {
      date,
      open: finiteNumber(fields[columns.open], `row ${lineIndex + 1} open`),
      high: finiteNumber(fields[columns.high], `row ${lineIndex + 1} high`),
      low: finiteNumber(fields[columns.low], `row ${lineIndex + 1} low`),
      close: finiteNumber(fields[columns.close], `row ${lineIndex + 1} close`),
      volume:
        columns.volume >= 0 && fields[columns.volume] !== ""
          ? finiteNumber(fields[columns.volume], `row ${lineIndex + 1} volume`)
          : 0,
    };
    if (Math.min(bar.open, bar.high, bar.low, bar.close) <= 0) {
      throw new Error(`row ${lineIndex + 1} contains a non-positive price`);
    }
    if (
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close, bar.high)
    ) {
      throw new Error(`row ${lineIndex + 1} has inconsistent OHLC values`);
    }
    if (bar.volume < 0) throw new Error(`row ${lineIndex + 1} has negative volume`);
    bars.push(bar);
  }
  bars.sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
  return bars;
}

export function simpleMovingAverage(values, period) {
  const length = Math.max(1, Math.floor(period));
  const result = Array(values.length).fill(null);
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= length) sum -= values[index - length];
    if (index >= length - 1) result[index] = sum / length;
  }
  return result;
}

export function relativeStrengthIndex(values, period = 14) {
  const length = Math.max(2, Math.floor(period));
  const result = Array(values.length).fill(null);
  if (values.length <= length) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= length; index += 1) {
    const change = values[index] - values[index - 1];
    gains += Math.max(0, change);
    losses += Math.max(0, -change);
  }
  let averageGain = gains / length;
  let averageLoss = losses / length;
  const valueFor = () =>
    averageLoss === 0
      ? averageGain === 0
        ? 50
        : 100
      : 100 - 100 / (1 + averageGain / averageLoss);
  result[length] = valueFor();
  for (let index = length + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (length - 1) + Math.max(0, change)) / length;
    averageLoss = (averageLoss * (length - 1) + Math.max(0, -change)) / length;
    result[index] = valueFor();
  }
  return result;
}

function strategySignals(bars, strategy) {
  const closes = bars.map((bar) => bar.close);
  const signals = bars.map(() => ({ enter: false, exit: false }));
  if (strategy.type === "sma-cross") {
    const fast = simpleMovingAverage(closes, strategy.fast);
    const slow = simpleMovingAverage(closes, strategy.slow);
    for (let index = 0; index < bars.length; index += 1) {
      if (fast[index] == null || slow[index] == null) continue;
      signals[index] = {
        enter: fast[index] > slow[index],
        exit: fast[index] <= slow[index],
      };
    }
    return { signals, indicators: { fast, slow } };
  }
  if (strategy.type === "rsi-reversion") {
    const rsi = relativeStrengthIndex(closes, strategy.period);
    for (let index = 0; index < bars.length; index += 1) {
      if (rsi[index] == null) continue;
      signals[index] = {
        enter: rsi[index] < strategy.oversold,
        exit: rsi[index] > strategy.overbought,
      };
    }
    return { signals, indicators: { rsi } };
  }
  if (strategy.type === "breakout") {
    const lookback = Math.max(2, Math.floor(strategy.lookback));
    const upper = Array(bars.length).fill(null);
    const lower = Array(bars.length).fill(null);
    for (let index = lookback; index < bars.length; index += 1) {
      const window = bars.slice(index - lookback, index);
      upper[index] = Math.max(...window.map((bar) => bar.high));
      lower[index] = Math.min(...window.map((bar) => bar.low));
      signals[index] = {
        enter: bars[index].close > upper[index],
        exit: bars[index].close < lower[index],
      };
    }
    return { signals, indicators: { upper, lower } };
  }
  throw new Error(`unknown strategy type: ${strategy.type}`);
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function metricsFor(equity, initialCapital, trades, exposureDays, benchmarkReturn) {
  const finalEquity = equity.at(-1)?.value ?? initialCapital;
  const totalReturn = finalEquity / initialCapital - 1;
  const years = Math.max(equity.length / TRADING_DAYS, 1 / TRADING_DAYS);
  const annualizedReturn = (finalEquity / initialCapital) ** (1 / years) - 1;
  const dailyReturns = [];
  let peak = initialCapital;
  let maximumDrawdown = 0;
  const drawdowns = [];
  for (let index = 0; index < equity.length; index += 1) {
    const value = equity[index].value;
    peak = Math.max(peak, value);
    const drawdown = peak === 0 ? 0 : value / peak - 1;
    maximumDrawdown = Math.min(maximumDrawdown, drawdown);
    drawdowns.push({ date: equity[index].date, value: drawdown });
    if (index > 0 && equity[index - 1].value > 0) {
      dailyReturns.push(value / equity[index - 1].value - 1);
    }
  }
  const meanDaily =
    dailyReturns.length > 0
      ? dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
      : 0;
  const volatility = standardDeviation(dailyReturns);
  const sharpe = volatility === 0 ? 0 : (meanDaily / volatility) * Math.sqrt(TRADING_DAYS);
  const winners = trades.filter((trade) => trade.pnl > 0).length;
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnl), 0);
  const grossLoss = trades.reduce((sum, trade) => sum + Math.max(0, -trade.pnl), 0);
  return {
    finalEquity,
    totalReturn,
    annualizedReturn,
    maximumDrawdown,
    sharpe,
    annualizedVolatility: volatility * Math.sqrt(TRADING_DAYS),
    calmar: maximumDrawdown === 0 ? null : annualizedReturn / Math.abs(maximumDrawdown),
    benchmarkReturn,
    excessReturn: totalReturn - benchmarkReturn,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    averageTradeReturn:
      trades.length === 0
        ? 0
        : trades.reduce((sum, trade) => sum + trade.return, 0) / trades.length,
    winRate: trades.length === 0 ? 0 : winners / trades.length,
    trades: trades.length,
    exposure: equity.length === 0 ? 0 : exposureDays / equity.length,
    drawdowns,
  };
}

export function fingerprintText(value) {
  let hash = 2_166_136_261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function fingerprintBars(bars) {
  return fingerprintText(
    bars
      .map((bar) => [bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume].join(","))
      .join("\n") + "\n",
  );
}

export function analyzeDataset(bars) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return { warnings: [{ code: "empty", message: "dataset is empty" }] };
  }
  let missingVolume = 0;
  let weekendBars = 0;
  let largestGapDays = 0;
  let largeJumps = 0;
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!(bar.volume > 0)) missingVolume += 1;
    const day = new Date(`${bar.date}T00:00:00Z`).getUTCDay();
    if (day === 0 || day === 6) weekendBars += 1;
    if (index === 0) continue;
    const previous = bars[index - 1];
    largestGapDays = Math.max(
      largestGapDays,
      Math.round((Date.parse(bar.date) - Date.parse(previous.date)) / 86_400_000),
    );
    if (Math.abs(bar.close / previous.close - 1) >= 0.35) largeJumps += 1;
  }
  const warnings = [];
  if (bars.length < TRADING_DAYS) {
    warnings.push({
      code: "short-sample",
      message: `only ${bars.length} bars; less than one trading year`,
    });
  }
  if (missingVolume > 0) {
    warnings.push({
      code: "missing-volume",
      message: `${missingVolume} bar(s) have zero or missing volume`,
    });
  }
  if (weekendBars > 0) {
    warnings.push({
      code: "weekend-bars",
      message: `${weekendBars} bar(s) fall on weekends`,
    });
  }
  if (largestGapDays > 10) {
    warnings.push({
      code: "calendar-gap",
      message: `largest calendar gap is ${largestGapDays} days`,
    });
  }
  if (largeJumps > 0) {
    warnings.push({
      code: "large-jump",
      message: `${largeJumps} close-to-close move(s) exceed 35%; check corporate-action adjustment`,
    });
  }
  return { missingVolume, weekendBars, largestGapDays, largeJumps, warnings };
}

function validateStrategy(strategy, barCount) {
  if (!strategy || typeof strategy !== "object") throw new Error("strategy is required");
  if (strategy.type === "sma-cross") {
    const fast = finiteNumber(strategy.fast, "fast SMA period");
    const slow = finiteNumber(strategy.slow, "slow SMA period");
    if (
      !Number.isInteger(fast) ||
      !Number.isInteger(slow) ||
      fast < 2 ||
      slow < 3 ||
      fast >= slow
    ) {
      throw new Error("SMA periods must be integers with 2 <= fast < slow");
    }
    if (slow >= barCount - 1) throw new Error("slow SMA period leaves too few executable bars");
    return;
  }
  if (strategy.type === "rsi-reversion") {
    const period = finiteNumber(strategy.period, "RSI period");
    const oversold = finiteNumber(strategy.oversold, "RSI oversold threshold");
    const overbought = finiteNumber(strategy.overbought, "RSI overbought threshold");
    if (
      !Number.isInteger(period) ||
      period < 2 ||
      oversold < 0 ||
      overbought > 100 ||
      oversold >= overbought
    ) {
      throw new Error("RSI requires an integer period >= 2 and 0 <= oversold < overbought <= 100");
    }
    if (period >= barCount - 1) throw new Error("RSI period leaves too few executable bars");
    return;
  }
  if (strategy.type === "breakout") {
    const lookback = finiteNumber(strategy.lookback, "breakout lookback");
    if (!Number.isInteger(lookback) || lookback < 2) {
      throw new Error("breakout lookback must be an integer >= 2");
    }
    if (lookback >= barCount - 1) {
      throw new Error("breakout lookback leaves too few executable bars");
    }
    return;
  }
  throw new Error(`unknown strategy type: ${strategy.type}`);
}

function validateBacktestBars(bars) {
  if (!Array.isArray(bars) || bars.length < 20) {
    throw new Error("backtest requires at least 20 bars");
  }
  if (bars.length > 100_000) throw new Error("backtest accepts at most 100000 bars");
  let previousDate = "";
  for (const [index, bar] of bars.entries()) {
    const label = `bar ${index + 1}`;
    if (!bar || typeof bar !== "object" || !/^\d{4}-\d{2}-\d{2}$/.test(bar.date)) {
      throw new Error(`${label} has an invalid date`);
    }
    const parsedDate = new Date(`${bar.date}T00:00:00Z`);
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== bar.date) {
      throw new Error(`${label} has an invalid date`);
    }
    if (previousDate && bar.date <= previousDate) {
      throw new Error("backtest bars must be strictly chronological with unique dates");
    }
    previousDate = bar.date;
    for (const field of ["open", "high", "low", "close"]) {
      if (!Number.isFinite(bar[field]) || bar[field] <= 0) {
        throw new Error(`${label} ${field} must be a positive finite number`);
      }
    }
    if (!Number.isFinite(bar.volume) || bar.volume < 0) {
      throw new Error(`${label} volume must be a non-negative finite number`);
    }
    if (
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close, bar.high)
    ) {
      throw new Error(`${label} has inconsistent OHLC values`);
    }
  }
}

export function runBacktest(bars, configuration) {
  validateBacktestBars(bars);
  const initialCapital = finiteNumber(configuration.initialCapital, "initial capital");
  const feeRate = finiteNumber(configuration.feeBps, "fee bps") / 10_000;
  const slippageRate = finiteNumber(configuration.slippageBps, "slippage bps") / 10_000;
  const stopLossRate = finiteNumber(configuration.stopLossPct, "stop loss") / 100;
  if (initialCapital <= 0) throw new Error("initial capital must be positive");
  if (feeRate < 0 || feeRate >= 1 || slippageRate < 0 || slippageRate >= 1) {
    throw new Error("fee and slippage assumptions must be between 0 and 10000 bps");
  }
  if (stopLossRate < 0 || stopLossRate >= 1) {
    throw new Error("stop loss must be between 0% (inclusive) and 100% (exclusive)");
  }
  validateStrategy(configuration.strategy, bars.length);

  const { signals, indicators } = strategySignals(bars, configuration.strategy);
  let cash = initialCapital;
  let shares = 0;
  let entry = null;
  let exposureDays = 0;
  const trades = [];
  const equity = [];

  const exitPosition = (bar, price, reason) => {
    const proceeds = shares * price;
    const exitFee = proceeds * feeRate;
    cash += proceeds - exitFee;
    const pnl = cash - entry.cashBefore;
    trades.push({
      entryDate: entry.date,
      exitDate: bar.date,
      entryPrice: entry.price,
      exitPrice: price,
      shares,
      pnl,
      return: pnl / entry.cashBefore,
      reason,
    });
    shares = 0;
    entry = null;
  };

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    let exposedThisBar = shares > 0;
    if (index > 0) {
      const previousSignal = signals[index - 1];
      let exitedThisBar = false;
      if (shares > 0) {
        const stopPrice = stopLossRate > 0 ? entry.price * (1 - stopLossRate) : 0;
        if (stopPrice > 0 && bar.low <= stopPrice) {
          const executableStop = Math.min(bar.open, stopPrice) * (1 - slippageRate);
          exitPosition(bar, executableStop, "stop");
          exitedThisBar = true;
        } else if (previousSignal.exit) {
          exitPosition(bar, bar.open * (1 - slippageRate), "signal");
          exitedThisBar = true;
        }
      }
      if (shares === 0 && !exitedThisBar && previousSignal.enter) {
        const entryPrice = bar.open * (1 + slippageRate);
        const cashBefore = cash;
        shares = cash / (entryPrice * (1 + feeRate));
        const cost = shares * entryPrice;
        const entryFee = cost * feeRate;
        cash -= cost + entryFee;
        entry = { date: bar.date, price: entryPrice, cashBefore };
        exposedThisBar = true;
      }
      if (shares > 0 && entry.date === bar.date && stopLossRate > 0) {
        const stopPrice = entry.price * (1 - stopLossRate);
        if (bar.low <= stopPrice) {
          exitPosition(bar, stopPrice * (1 - slippageRate), "stop");
        }
      }
    }
    if (exposedThisBar) exposureDays += 1;
    equity.push({ date: bar.date, value: cash + shares * bar.close });
  }

  if (shares > 0) {
    const finalBar = bars.at(-1);
    exitPosition(finalBar, finalBar.close * (1 - slippageRate), "end");
    equity[equity.length - 1] = { date: finalBar.date, value: cash };
  }

  const benchmark = bars.map((bar) => ({
    date: bar.date,
    value: initialCapital * (bar.close / bars[0].close),
  }));
  const benchmarkReturn = bars.at(-1).close / bars[0].close - 1;
  const metrics = metricsFor(equity, initialCapital, trades, exposureDays, benchmarkReturn);
  const finiteMetrics = [
    "finalEquity",
    "totalReturn",
    "annualizedReturn",
    "maximumDrawdown",
    "sharpe",
    "annualizedVolatility",
    "benchmarkReturn",
    "excessReturn",
    "averageTradeReturn",
    "winRate",
    "trades",
    "exposure",
  ];
  if (
    equity.some((point) => !Number.isFinite(point.value)) ||
    benchmark.some((point) => !Number.isFinite(point.value)) ||
    finiteMetrics.some((key) => !Number.isFinite(metrics[key])) ||
    (metrics.calmar != null && !Number.isFinite(metrics.calmar)) ||
    (metrics.profitFactor != null && !Number.isFinite(metrics.profitFactor))
  ) {
    throw new Error("backtest result is numerically unstable; check price magnitudes and inputs");
  }
  return {
    bars,
    equity,
    benchmark,
    trades,
    indicators,
    metrics,
  };
}

export function generateDemoBars(count = 520) {
  if (!Number.isInteger(count) || count < 1 || count > 5_000) {
    throw new Error("demo bar count must be an integer between 1 and 5000");
  }
  const bars = [];
  let seed = 7_314_159;
  let close = 112;
  const date = new Date("2023-01-03T00:00:00Z");
  const random = () => {
    seed = (seed * 48_271) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  while (bars.length < count) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) {
      const cycle = Math.sin(bars.length / 27) * 0.006;
      const drift = 0.00045 + cycle;
      const shock = (random() - 0.48) * 0.035;
      const open = close * (1 + (random() - 0.5) * 0.012);
      close = Math.max(18, open * (1 + drift + shock));
      const high = Math.max(open, close) * (1 + random() * 0.018);
      const low = Math.min(open, close) * (1 - random() * 0.018);
      bars.push({
        date: date.toISOString().slice(0, 10),
        open,
        high,
        low,
        close,
        volume: Math.round(2_500_000 + random() * 6_000_000),
      });
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return bars;
}
