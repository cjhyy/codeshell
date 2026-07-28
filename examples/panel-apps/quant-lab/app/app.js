/* Quant Lab Panel App runtime. */
/* global document, localStorage, window */

import {
  analyzeDataset,
  fencedMarkdown,
  fingerprintBars,
  fingerprintText,
  generateDemoBars,
  isSafeCsvPath,
  markdownInlineCode,
  markdownPlainText,
  parseOhlcvCsv,
  runBacktest,
} from "./engine.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const elements = {
  dataPath: document.querySelector("#data-path"),
  loadData: document.querySelector("#load-data"),
  askAgent: document.querySelector("#ask-agent"),
  agentDialog: document.querySelector("#agent-dialog"),
  agentRequest: document.querySelector("#agent-request"),
  agentState: document.querySelector("#agent-state"),
  submitAgent: document.querySelector("#submit-agent"),
  instrumentName: document.querySelector("#instrument-name"),
  datasetBadge: document.querySelector("#dataset-badge"),
  datasetMeta: document.querySelector("#dataset-meta"),
  dataQuality: document.querySelector("#data-quality"),
  runState: document.querySelector("#run-state"),
  runBacktest: document.querySelector("#run-backtest"),
  saveStrategy: document.querySelector("#save-strategy"),
  saveReport: document.querySelector("#save-report"),
  strategyType: document.querySelector("#strategy-type"),
  smaParams: document.querySelector("#sma-params"),
  rsiParams: document.querySelector("#rsi-params"),
  breakoutParams: document.querySelector("#breakout-params"),
  fastPeriod: document.querySelector("#fast-period"),
  slowPeriod: document.querySelector("#slow-period"),
  rsiPeriod: document.querySelector("#rsi-period"),
  rsiOversold: document.querySelector("#rsi-oversold"),
  rsiOverbought: document.querySelector("#rsi-overbought"),
  breakoutPeriod: document.querySelector("#breakout-period"),
  initialCapital: document.querySelector("#initial-capital"),
  feeBps: document.querySelector("#fee-bps"),
  slippageBps: document.querySelector("#slippage-bps"),
  stopLoss: document.querySelector("#stop-loss"),
  metricReturn: document.querySelector("#metric-return"),
  metricFinalEquity: document.querySelector("#metric-final-equity"),
  metricCagr: document.querySelector("#metric-cagr"),
  metricCagrDetail: document.querySelector("#metric-cagr-detail"),
  metricDrawdown: document.querySelector("#metric-drawdown"),
  metricDrawdownDetail: document.querySelector("#metric-drawdown-detail"),
  metricSharpe: document.querySelector("#metric-sharpe"),
  metricSharpeDetail: document.querySelector("#metric-sharpe-detail"),
  metricWinRate: document.querySelector("#metric-win-rate"),
  metricTrades: document.querySelector("#metric-trades"),
  metricExposure: document.querySelector("#metric-exposure"),
  chartTitle: document.querySelector("#chart-title"),
  chart: document.querySelector("#chart"),
  chartWrap: document.querySelector("#chart-wrap"),
  chartGrid: document.querySelector("#chart-grid"),
  chartSeries: document.querySelector("#chart-series"),
  chartLabels: document.querySelector("#chart-labels"),
  chartCursor: document.querySelector("#chart-cursor"),
  chartTooltip: document.querySelector("#chart-tooltip"),
  chartLegend: document.querySelector("#chart-legend"),
  tradesBody: document.querySelector("#trades-body"),
  tradeSummary: document.querySelector("#trade-summary"),
  toast: document.querySelector("#toast"),
};

let bars = generateDemoBars();
let dataset = {
  kind: "demo",
  path: null,
  name: "DEMO / SYNTHETIC",
  source: "synthetic sample",
};
let result = null;
let chartMode = "equity";
let context = { busy: false, trusted: false };
let toastTimer;
let workspaceEpoch = 0;
let contextInitialized = false;

function scopedStorageKey(base, workspaceRoot = context.cwd ?? "preview") {
  let primary = 2_166_136_261;
  let secondary = 2_654_435_769;
  for (let index = 0; index < workspaceRoot.length; index += 1) {
    const code = workspaceRoot.charCodeAt(index);
    primary = Math.imul(primary ^ code, 16_777_619);
    secondary = Math.imul(secondary ^ code, 2_246_822_519);
    secondary ^= secondary >>> 13;
  }
  const scope = [primary, secondary]
    .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
    .join("");
  return `${base}.${scope}`;
}

function numberValue(
  element,
  label,
  { minimum, maximum, maximumInclusive = false, integer = false },
) {
  const value = Number(element.value);
  if (
    !Number.isFinite(value) ||
    value < minimum ||
    (maximumInclusive ? value > maximum : value >= maximum) ||
    (integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `${label}必须是${integer ? "整数，且" : ""}不小于 ${minimum}、${maximumInclusive ? "不大于" : "小于"} ${maximum}`,
    );
  }
  return value;
}

function currentStrategy() {
  if (elements.strategyType.value === "sma-cross") {
    const fast = numberValue(elements.fastPeriod, "快速均线周期", {
      minimum: 2,
      maximum: 100_000,
      integer: true,
    });
    const slow = numberValue(elements.slowPeriod, "慢速均线周期", {
      minimum: 3,
      maximum: 100_000,
      integer: true,
    });
    if (fast >= slow) throw new Error("快速均线周期必须小于慢速均线周期");
    return { type: "sma-cross", fast, slow };
  }
  if (elements.strategyType.value === "rsi-reversion") {
    const period = numberValue(elements.rsiPeriod, "RSI 周期", {
      minimum: 2,
      maximum: 100_000,
      integer: true,
    });
    const oversold = numberValue(elements.rsiOversold, "RSI 超卖阈值", {
      minimum: 0,
      maximum: 100,
      maximumInclusive: true,
    });
    const overbought = numberValue(elements.rsiOverbought, "RSI 超买阈值", {
      minimum: 0,
      maximum: 100,
      maximumInclusive: true,
    });
    if (oversold >= overbought) throw new Error("RSI 超卖阈值必须小于超买阈值");
    return { type: "rsi-reversion", period, oversold, overbought };
  }
  return {
    type: "breakout",
    lookback: numberValue(elements.breakoutPeriod, "突破周期", {
      minimum: 2,
      maximum: 100_000,
      integer: true,
    }),
  };
}

function currentConfiguration() {
  return {
    strategy: currentStrategy(),
    initialCapital: numberValue(elements.initialCapital, "初始资金", {
      minimum: 100,
      maximum: Number.MAX_VALUE,
    }),
    feeBps: numberValue(elements.feeBps, "手续费", {
      minimum: 0,
      maximum: 10_000,
    }),
    slippageBps: numberValue(elements.slippageBps, "滑点", {
      minimum: 0,
      maximum: 10_000,
    }),
    stopLossPct: numberValue(elements.stopLoss, "止损比例", {
      minimum: 0,
      maximum: 100,
    }),
  };
}

function formatMoney(value, decimals = 0) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(value);
}

function formatPercent(value, decimals = 1) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(decimals)}%`;
}

function formatPrice(value) {
  return Number(value).toFixed(2);
}

function setRunState(message, kind = "ready") {
  elements.runState.textContent = message;
  elements.runState.classList.toggle("error", kind === "error");
}

function notify(message, kind = "idle") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", kind === "error");
  elements.toast.hidden = false;
  toastTimer = setTimeout(
    () => {
      elements.toast.hidden = true;
    },
    kind === "error" ? 5200 : 2800,
  );
}

function mockHostCall(method, params = {}) {
  const prefix = "codeshell-quant-lab:";
  if (method === "storage.get") {
    return Promise.resolve(
      JSON.parse(localStorage.getItem(`${prefix}storage:${params.key}`) || "null"),
    );
  }
  if (method === "storage.set") {
    localStorage.setItem(`${prefix}storage:${params.key}`, JSON.stringify(params.value));
    return Promise.resolve(true);
  }
  if (method === "workspace.info") {
    return Promise.resolve({
      name: "codeshell",
      root: "/preview/codeshell",
      trusted: true,
      gitBranch: "preview",
    });
  }
  if (method === "workspace.readText") {
    const content = localStorage.getItem(`${prefix}file:${params.path}`);
    if (content == null) return Promise.reject(new Error("预览环境中没有这个 CSV 文件"));
    const modifiedAt = Number(localStorage.getItem(`${prefix}mtime:${params.path}`)) || Date.now();
    return Promise.resolve({
      path: params.path,
      content,
      size: content.length,
      modifiedAt,
      revision: `preview:${modifiedAt}`,
    });
  }
  if (method === "workspace.writeText") {
    const modifiedAt = Date.now();
    localStorage.setItem(`${prefix}file:${params.path}`, params.content);
    localStorage.setItem(`${prefix}mtime:${params.path}`, String(modifiedAt));
    return Promise.resolve({
      path: params.path,
      size: params.content.length,
      modifiedAt,
      revision: `preview:${modifiedAt}`,
    });
  }
  if (method === "agent.submitPrompt") return Promise.resolve({ accepted: true });
  return Promise.resolve(null);
}

function hostCall(method, params) {
  if (window.codeshellPanel?.call) return window.codeshellPanel.call(method, params);
  return mockHostCall(method, params);
}

async function writeRepoText(path, content) {
  const operationWorkspaceEpoch = workspaceEpoch;
  let expectedModifiedAt = null;
  let expectedRevision = null;
  try {
    const existing = await hostCall("workspace.readText", { path });
    expectedModifiedAt = existing.modifiedAt;
    expectedRevision = existing.revision;
  } catch {
    // A missing output is created; unreadable existing output fails the host conflict check.
  }
  if (operationWorkspaceEpoch !== workspaceEpoch) {
    throw new Error("工作区已在操作期间切换；旧操作已取消，请在当前仓库重试");
  }
  const result = await hostCall("workspace.writeText", {
    path,
    content,
    expectedModifiedAt,
    ...(expectedRevision ? { expectedRevision } : {}),
  });
  if (operationWorkspaceEpoch !== workspaceEpoch) {
    throw new Error("工作区已在操作期间切换；旧操作已取消，请在当前仓库重试");
  }
  return result;
}

function renderDataset() {
  elements.instrumentName.textContent = dataset.name;
  elements.datasetBadge.textContent = dataset.kind === "demo" ? "DEMO" : "REPO DATA";
  elements.datasetBadge.className = `badge ${dataset.kind === "demo" ? "demo" : "live"}`;
  const first = bars[0];
  const last = bars.at(-1);
  elements.datasetMeta.textContent = `${bars.length} daily bars · ${first.date} → ${last.date} · ${dataset.source}`;
  const quality = analyzeDataset(bars);
  elements.dataQuality.dataset.state = quality.warnings.length === 0 ? "ok" : "warning";
  elements.dataQuality.textContent =
    quality.warnings.length === 0
      ? "数据检查通过"
      : `${quality.warnings.length} 项数据提醒 · ${quality.warnings.map((warning) => warning.message).join("；")}`;
}

function renderMetrics() {
  const metrics = result.metrics;
  elements.metricReturn.textContent = formatPercent(metrics.totalReturn);
  elements.metricFinalEquity.textContent = `${formatMoney(metrics.finalEquity)} final equity`;
  elements.metricCagr.textContent = formatPercent(metrics.annualizedReturn);
  elements.metricCagrDetail.textContent = `B&H ${formatPercent(metrics.benchmarkReturn)} · excess ${formatPercent(metrics.excessReturn)}`;
  elements.metricDrawdown.textContent = formatPercent(metrics.maximumDrawdown);
  elements.metricDrawdownDetail.textContent = `Calmar ${metrics.calmar == null ? "—" : metrics.calmar.toFixed(2)}`;
  elements.metricSharpe.textContent = metrics.sharpe.toFixed(2);
  elements.metricSharpeDetail.textContent = `Vol ${formatPercent(metrics.annualizedVolatility)} · rf 0%`;
  elements.metricWinRate.textContent = `${(metrics.winRate * 100).toFixed(0)}%`;
  elements.metricTrades.textContent = `${metrics.trades} trades · PF ${metrics.profitFactor == null ? "—" : metrics.profitFactor.toFixed(2)}`;
  elements.metricExposure.textContent = `${(metrics.exposure * 100).toFixed(0)}%`;
}

function clearRunResult() {
  result = null;
  for (const element of [
    elements.metricReturn,
    elements.metricFinalEquity,
    elements.metricCagr,
    elements.metricCagrDetail,
    elements.metricDrawdown,
    elements.metricDrawdownDetail,
    elements.metricSharpe,
    elements.metricSharpeDetail,
    elements.metricWinRate,
    elements.metricTrades,
    elements.metricExposure,
  ]) {
    element.textContent = "—";
  }
  renderChart();
  renderTrades();
}

function applyRunResult(nextResult) {
  result = nextResult;
  renderMetrics();
  renderChart();
  renderTrades();
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function pathFor(values, xScale, yScale) {
  let path = "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]?.value;
    if (value == null || !Number.isFinite(value)) continue;
    const command = path ? "L" : "M";
    path += `${command}${xScale(index).toFixed(2)},${yScale(value).toFixed(2)}`;
  }
  return path;
}

function renderChart() {
  elements.chartGrid.replaceChildren();
  elements.chartSeries.replaceChildren();
  elements.chartLabels.replaceChildren();
  elements.chartLegend.replaceChildren();
  hideChartTooltip();
  if (!result) {
    elements.chartTitle.textContent = "等待有效参数";
    delete elements.chart.dataset.minimum;
    delete elements.chart.dataset.maximum;
    return;
  }
  const plot = { left: 56, right: 882, top: 18, bottom: 286 };
  let series;
  if (chartMode === "equity") {
    elements.chartTitle.textContent = "权益曲线";
    series = [
      { key: "strategy", values: result.equity, className: "series-equity", color: "#57e39a" },
      {
        key: "buy & hold",
        values: result.benchmark,
        className: "series-benchmark",
        color: "#64716b",
      },
    ];
  } else if (chartMode === "price") {
    if (result.indicators.rsi) {
      elements.chartTitle.textContent = "RSI 动量指标";
      series = [
        {
          key: "RSI",
          values: result.indicators.rsi.map((value, index) => ({
            date: bars[index].date,
            value,
          })),
          className: "series-fast",
          color: "#57e39a",
        },
      ];
    } else {
      elements.chartTitle.textContent = "价格与信号指标";
      series = [
        {
          key: "close",
          values: bars.map((bar) => ({ date: bar.date, value: bar.close })),
          className: "series-price",
          color: "#edf3ef",
        },
      ];
      if (result.indicators.fast) {
        series.push(
          {
            key: "fast SMA",
            values: result.indicators.fast.map((value, index) => ({
              date: bars[index].date,
              value,
            })),
            className: "series-fast",
            color: "#57e39a",
          },
          {
            key: "slow SMA",
            values: result.indicators.slow.map((value, index) => ({
              date: bars[index].date,
              value,
            })),
            className: "series-slow",
            color: "#f0bd66",
          },
        );
      }
      if (result.indicators.upper) {
        series.push(
          {
            key: "upper channel",
            values: result.indicators.upper.map((value, index) => ({
              date: bars[index].date,
              value,
            })),
            className: "series-fast",
            color: "#57e39a",
          },
          {
            key: "lower channel",
            values: result.indicators.lower.map((value, index) => ({
              date: bars[index].date,
              value,
            })),
            className: "series-slow",
            color: "#f0bd66",
          },
        );
      }
    }
  } else {
    elements.chartTitle.textContent = "水下回撤";
    series = [
      {
        key: "drawdown",
        values: result.metrics.drawdowns,
        className: "series-drawdown",
        color: "#f37c75",
        area: true,
      },
    ];
  }

  const allValues = series.flatMap((item) =>
    item.values
      .map((point) => point.value)
      .filter((value) => value != null && Number.isFinite(value)),
  );
  let minimum = Math.min(...allValues);
  let maximum = Math.max(...allValues);
  if (chartMode === "drawdown") maximum = 0;
  const rsiChart = chartMode === "price" && Boolean(result.indicators.rsi);
  const padding = Math.max((maximum - minimum) * 0.08, Math.abs(maximum) * 0.01, 0.01);
  if (rsiChart) {
    minimum = 0;
    maximum = 100;
  } else {
    minimum -= chartMode === "drawdown" ? padding * 0.2 : padding;
    maximum += chartMode === "drawdown" ? 0 : padding;
  }
  const xScale = (index) =>
    plot.left + (index / Math.max(1, bars.length - 1)) * (plot.right - plot.left);
  const yScale = (value) =>
    plot.bottom -
    ((value - minimum) / Math.max(0.000001, maximum - minimum)) * (plot.bottom - plot.top);

  for (let index = 0; index <= 4; index += 1) {
    const y = plot.top + (index / 4) * (plot.bottom - plot.top);
    elements.chartGrid.append(
      svgElement("line", {
        x1: plot.left,
        x2: plot.right,
        y1: y,
        y2: y,
        class: "grid-line",
      }),
    );
    const value = maximum - (index / 4) * (maximum - minimum);
    const label = svgElement("text", {
      x: plot.left - 8,
      y: y + 3,
      "text-anchor": "end",
      class: "axis-label",
    });
    label.textContent =
      chartMode === "drawdown"
        ? `${(value * 100).toFixed(0)}%`
        : chartMode === "price"
          ? formatPrice(value)
          : value >= 1000
            ? `$${(value / 1000).toFixed(0)}k`
            : `$${value.toFixed(0)}`;
    elements.chartLabels.append(label);
  }

  for (const index of [
    0,
    Math.floor((bars.length - 1) / 3),
    Math.floor(((bars.length - 1) * 2) / 3),
    bars.length - 1,
  ]) {
    const label = svgElement("text", {
      x: xScale(index),
      y: 307,
      "text-anchor": index === 0 ? "start" : index === bars.length - 1 ? "end" : "middle",
      class: "axis-label",
    });
    label.textContent = bars[index].date.slice(0, 7);
    elements.chartLabels.append(label);
  }

  for (const item of series) {
    let path = pathFor(item.values, xScale, yScale);
    if (item.area && path) {
      path += `L${plot.right},${yScale(0)}L${plot.left},${yScale(0)}Z`;
    }
    elements.chartSeries.append(svgElement("path", { d: path, class: item.className }));
    const legend = document.createElement("span");
    legend.className = "legend-item";
    const dot = document.createElement("i");
    dot.className = "legend-dot";
    dot.style.background = item.color;
    const label = document.createElement("span");
    label.textContent = item.key;
    legend.append(dot, label);
    elements.chartLegend.append(legend);
  }
  elements.chart.dataset.minimum = String(minimum);
  elements.chart.dataset.maximum = String(maximum);
}

function renderTrades() {
  elements.tradesBody.replaceChildren();
  if (!result) {
    elements.tradeSummary.textContent = "等待有效回测";
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.textContent = "修正参数后重新运行回测";
    row.append(cell);
    elements.tradesBody.append(row);
    return;
  }
  const visibleTrades = result.trades.slice(0, 500);
  elements.tradeSummary.textContent =
    result.trades.length > visibleTrades.length
      ? `${result.trades.length} 笔已平仓交易 · 表格显示前 ${visibleTrades.length} 笔`
      : `${result.trades.length} 笔已平仓交易`;
  if (!result.trades.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.textContent = "当前参数没有产生已平仓交易";
    row.append(cell);
    elements.tradesBody.append(row);
    return;
  }
  visibleTrades.forEach((trade, index) => {
    const row = document.createElement("tr");
    const values = [
      String(index + 1).padStart(2, "0"),
      trade.entryDate,
      trade.exitDate,
      formatPrice(trade.entryPrice),
      formatPrice(trade.exitPrice),
      trade.reason === "stop" ? "STOP" : trade.reason === "end" ? "END" : "SIGNAL",
      formatPercent(trade.return, 2),
      formatMoney(trade.pnl),
    ];
    values.forEach((value, cellIndex) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (cellIndex >= 6) cell.className = trade.pnl >= 0 ? "positive" : "negative";
      row.append(cell);
    });
    elements.tradesBody.append(row);
  });
  if (result.trades.length > visibleTrades.length) {
    const row = document.createElement("tr");
    row.className = "empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.textContent = `另有 ${result.trades.length - visibleTrades.length} 笔交易未在面板中展开；保存报告可查看前 1000 笔。`;
    row.append(cell);
    elements.tradesBody.append(row);
  }
}

function run() {
  elements.runBacktest.disabled = true;
  setRunState("RUNNING");
  try {
    applyRunResult(runBacktest(bars, currentConfiguration()));
    renderDataset();
    setRunState("COMPLETE");
    void saveUiState();
    return true;
  } catch (error) {
    clearRunResult();
    const message = error instanceof Error ? error.message : "回测失败";
    setRunState("ERROR", "error");
    notify(message, "error");
    return false;
  } finally {
    elements.runBacktest.disabled = false;
  }
}

async function loadCsv() {
  const operationWorkspaceEpoch = workspaceEpoch;
  const path = elements.dataPath.value.trim();
  if (!isSafeCsvPath(path)) {
    return notify("请输入安全的 repo 相对 CSV 路径", "error");
  }
  elements.loadData.disabled = true;
  setRunState("LOADING");
  try {
    const file = await hostCall("workspace.readText", { path });
    if (operationWorkspaceEpoch !== workspaceEpoch) return;
    const loadedBars = parseOhlcvCsv(file.content);
    const loadedResult = runBacktest(loadedBars, currentConfiguration());
    const baseName = path
      .split("/")
      .pop()
      .replace(/\.csv$/i, "")
      .slice(0, 120);
    bars = loadedBars;
    dataset = {
      kind: "repo",
      path,
      name: baseName.toUpperCase(),
      source: path,
    };
    applyRunResult(loadedResult);
    renderDataset();
    setRunState("COMPLETE");
    void saveUiState();
    notify(`已载入 ${bars.length} 根 K 线`);
  } catch (error) {
    if (operationWorkspaceEpoch !== workspaceEpoch) return;
    setRunState("ERROR", "error");
    notify(error instanceof Error ? error.message : "数据加载失败", "error");
  } finally {
    if (operationWorkspaceEpoch === workspaceEpoch) {
      elements.loadData.disabled = context.trusted !== true;
    }
  }
}

function strategyLabel(strategy) {
  if (strategy.type === "sma-cross") return `SMA ${strategy.fast}/${strategy.slow}`;
  if (strategy.type === "rsi-reversion") {
    return `RSI ${strategy.period} · ${strategy.oversold}/${strategy.overbought}`;
  }
  return `Breakout ${strategy.lookback}`;
}

function strategySlug(strategy) {
  const numberSlug = (value) => String(value).replace(".", "p");
  if (strategy.type === "sma-cross") return `sma-${strategy.fast}-${strategy.slow}`;
  if (strategy.type === "rsi-reversion") {
    return `rsi-${strategy.period}-${numberSlug(strategy.oversold)}-${numberSlug(strategy.overbought)}`;
  }
  return `breakout-${strategy.lookback}`;
}

function datasetSlug() {
  const name = dataset.kind === "demo" ? "demo" : dataset.name;
  const readable =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "dataset";
  if (dataset.kind === "demo") return readable;
  const fingerprint = fingerprintBars(bars).split(":").at(-1).slice(0, 8);
  return `${readable}-${fingerprint}`;
}

function strategySpec() {
  const configuration = currentConfiguration();
  return {
    format: "codeshell.quant-strategy",
    version: 1,
    name: `${dataset.name} ${strategyLabel(configuration.strategy)}`,
    dataset: dataset.path ?? "synthetic-demo",
    sample: {
      bars: bars.length,
      from: bars[0].date,
      to: bars.at(-1).date,
      fingerprint: fingerprintBars(bars),
    },
    strategy: configuration.strategy,
    execution: {
      initialCapital: configuration.initialCapital,
      feeBps: configuration.feeBps,
      slippageBps: configuration.slippageBps,
      stopLossPct: configuration.stopLossPct,
    },
  };
}

function configurationSlug(spec) {
  return fingerprintText(JSON.stringify({ strategy: spec.strategy, execution: spec.execution }))
    .split(":")
    .at(-1);
}

async function saveStrategy() {
  const operationWorkspaceEpoch = workspaceEpoch;
  elements.saveStrategy.disabled = true;
  try {
    if (!run()) return;
    const spec = strategySpec();
    const path = `quant/strategies/${datasetSlug()}-${strategySlug(spec.strategy)}-${configurationSlug(spec)}.quant.json`;
    await writeRepoText(path, `${JSON.stringify(spec, null, 2)}\n`);
    notify(`策略已保存到 ${path}`);
  } catch (error) {
    if (operationWorkspaceEpoch !== workspaceEpoch) return;
    notify(error instanceof Error ? error.message : "策略保存失败", "error");
  } finally {
    if (operationWorkspaceEpoch === workspaceEpoch) {
      elements.saveStrategy.disabled = context.trusted !== true;
    }
  }
}

function reportMarkdown() {
  const spec = strategySpec();
  const metrics = result.metrics;
  const quality = analyzeDataset(bars);
  const reportedTrades = result.trades.slice(0, 1_000);
  const tradeLines =
    reportedTrades.length > 0
      ? reportedTrades
          .map(
            (trade, index) =>
              `| ${index + 1} | ${trade.entryDate} | ${trade.exitDate} | ${trade.reason} | ${formatPercent(trade.return, 2)} | ${formatMoney(trade.pnl)} |`,
          )
          .concat(
            result.trades.length > reportedTrades.length
              ? [
                  `| … | — | — | omitted | — | ${result.trades.length - reportedTrades.length} additional trades |`,
                ]
              : [],
          )
          .join("\n")
      : "| — | — | — | — | — | No closed trades |";
  return [
    `# ${markdownPlainText(spec.name)}`,
    "",
    `Dataset: ${markdownInlineCode(spec.dataset)} (${bars[0].date} to ${bars.at(-1).date}, ${bars.length} daily bars)`,
    "",
    "## Data checks",
    "",
    quality.warnings.length === 0
      ? "All built-in data checks passed."
      : `${quality.warnings.length} warning(s):`,
    ...quality.warnings.map((warning) => `- ${warning.code}: ${warning.message}`),
    "",
    "## Configuration",
    "",
    fencedMarkdown(JSON.stringify(spec, null, 2), "json"),
    "",
    "## Results",
    "",
    `- Final equity: ${formatMoney(metrics.finalEquity)}`,
    `- Total return: ${formatPercent(metrics.totalReturn)}`,
    `- Annualized return: ${formatPercent(metrics.annualizedReturn)}`,
    `- Buy-and-hold return: ${formatPercent(metrics.benchmarkReturn)}`,
    `- Excess return: ${formatPercent(metrics.excessReturn)}`,
    `- Annualized volatility: ${formatPercent(metrics.annualizedVolatility)}`,
    `- Maximum drawdown: ${formatPercent(metrics.maximumDrawdown)}`,
    `- Sharpe ratio: ${metrics.sharpe.toFixed(2)}`,
    `- Calmar ratio: ${metrics.calmar == null ? "n/a" : metrics.calmar.toFixed(2)}`,
    `- Profit factor: ${metrics.profitFactor == null ? "n/a" : metrics.profitFactor.toFixed(2)}`,
    `- Average trade return: ${formatPercent(metrics.averageTradeReturn)}`,
    `- Exposure: ${(metrics.exposure * 100).toFixed(1)}%`,
    `- Win rate: ${(metrics.winRate * 100).toFixed(1)}% (${metrics.trades} trades)`,
    "",
    "## Trades",
    "",
    "| # | Entry | Exit | Reason | Return | P&L |",
    "|---:|---|---|---|---:|---:|",
    tradeLines,
    "",
    "## Methodology and limitations",
    "",
    "Signals are computed after a daily close and execute at the next bar's open. The test is long-only and includes the configured fees, slippage, and simplified intraday stop behavior.",
    "",
    "This research output is not investment advice. Validate adjusted pricing, data quality, liquidity, corporate actions, survivorship bias, and out-of-sample performance before drawing conclusions.",
    "",
  ].join("\n");
}

async function saveReport() {
  const operationWorkspaceEpoch = workspaceEpoch;
  elements.saveReport.disabled = true;
  try {
    if (!run()) return;
    const spec = strategySpec();
    const path = `quant/reports/${datasetSlug()}-${strategySlug(spec.strategy)}-${configurationSlug(spec)}-report.md`;
    await writeRepoText(path, reportMarkdown());
    notify(`报告已保存到 ${path}`);
  } catch (error) {
    if (operationWorkspaceEpoch !== workspaceEpoch) return;
    notify(error instanceof Error ? error.message : "报告保存失败", "error");
  } finally {
    if (operationWorkspaceEpoch === workspaceEpoch) {
      elements.saveReport.disabled = context.trusted !== true;
    }
  }
}

function updateParameterVisibility() {
  const type = elements.strategyType.value;
  elements.smaParams.hidden = type !== "sma-cross";
  elements.rsiParams.hidden = type !== "rsi-reversion";
  elements.breakoutParams.hidden = type !== "breakout";
}

function saveUiState(workspaceRoot = context.cwd ?? null) {
  let configuration;
  try {
    configuration = currentConfiguration();
  } catch {
    return Promise.resolve();
  }
  return hostCall("storage.set", {
    key: scopedStorageKey("configuration", workspaceRoot ?? "preview"),
    value: {
      workspaceRoot,
      ...configuration,
      dataPath: elements.dataPath.value.trim(),
    },
  }).catch(() => undefined);
}

function resetUiState() {
  elements.strategyType.value = "sma-cross";
  elements.fastPeriod.value = "20";
  elements.slowPeriod.value = "50";
  elements.rsiPeriod.value = "14";
  elements.rsiOversold.value = "30";
  elements.rsiOverbought.value = "65";
  elements.breakoutPeriod.value = "20";
  elements.initialCapital.value = "100000";
  elements.feeBps.value = "5";
  elements.slippageBps.value = "2";
  elements.stopLoss.value = "8";
  elements.dataPath.value = "";
}

function restoreUiState(value) {
  if (!value || typeof value !== "object") return;
  const strategy = value.strategy;
  if (["sma-cross", "rsi-reversion", "breakout"].includes(strategy?.type)) {
    elements.strategyType.value = strategy.type;
  }
  if (strategy?.fast != null) elements.fastPeriod.value = strategy.fast;
  if (strategy?.slow != null) elements.slowPeriod.value = strategy.slow;
  if (strategy?.period != null) elements.rsiPeriod.value = strategy.period;
  if (strategy?.oversold != null) elements.rsiOversold.value = strategy.oversold;
  if (strategy?.overbought != null) elements.rsiOverbought.value = strategy.overbought;
  if (strategy?.lookback != null) elements.breakoutPeriod.value = strategy.lookback;
  if (value.initialCapital != null) elements.initialCapital.value = value.initialCapital;
  if (value.feeBps != null) elements.feeBps.value = value.feeBps;
  if (value.slippageBps != null) elements.slippageBps.value = value.slippageBps;
  if (value.stopLossPct != null) elements.stopLoss.value = value.stopLossPct;
  if (typeof value.dataPath === "string") elements.dataPath.value = value.dataPath;
  updateParameterVisibility();
}

async function restoreWorkspaceState(workspaceIdentity, storageRoot, epoch) {
  const saved = await hostCall("storage.get", {
    key: scopedStorageKey("configuration", storageRoot),
  }).catch(() => null);
  if (epoch !== workspaceEpoch || (context.cwd ?? null) !== workspaceIdentity) return;
  resetUiState();
  restoreUiState(saved?.workspaceRoot === workspaceIdentity ? saved : null);
  updateParameterVisibility();
  renderDataset();
  run();
}

function updateChartTooltip(event) {
  if (!result) return;
  const rect = elements.chart.getBoundingClientRect();
  const relativeX = (event.clientX - rect.left) / rect.width;
  const plotStart = 56 / 900;
  const plotEnd = 882 / 900;
  const normalized = Math.max(0, Math.min(1, (relativeX - plotStart) / (plotEnd - plotStart)));
  const index = Math.round(normalized * (bars.length - 1));
  const x = 56 + (index / Math.max(1, bars.length - 1)) * (882 - 56);
  elements.chartCursor.setAttribute("x1", x);
  elements.chartCursor.setAttribute("x2", x);
  elements.chartCursor.hidden = false;
  let body;
  if (chartMode === "equity") {
    body = [
      bars[index].date,
      formatMoney(result.equity[index].value),
      `benchmark ${formatMoney(result.benchmark[index].value)}`,
    ];
  } else if (chartMode === "price") {
    body = result.indicators.rsi
      ? [
          bars[index].date,
          `RSI ${result.indicators.rsi[index]?.toFixed(1) ?? "—"}`,
          `close ${formatPrice(bars[index].close)}`,
        ]
      : [
          bars[index].date,
          formatPrice(bars[index].close),
          `volume ${Math.round(bars[index].volume).toLocaleString()}`,
        ];
  } else {
    body = [bars[index].date, formatPercent(result.metrics.drawdowns[index].value, 2)];
  }
  elements.chartTooltip.replaceChildren();
  body.forEach((line, lineIndex) => {
    const row = document.createElement(lineIndex === 1 ? "strong" : "span");
    row.textContent = line;
    elements.chartTooltip.append(row);
  });
  elements.chartTooltip.style.left = `${Math.min(rect.width - 140, Math.max(8, event.clientX - rect.left + 10))}px`;
  elements.chartTooltip.style.top = `${Math.max(8, event.clientY - rect.top - 20)}px`;
  elements.chartTooltip.hidden = false;
}

function hideChartTooltip() {
  elements.chartCursor.hidden = true;
  elements.chartTooltip.hidden = true;
}

async function submitAgentRequest() {
  const operationWorkspaceEpoch = workspaceEpoch;
  const request = elements.agentRequest.value.trim();
  if (!request) return notify("先填写希望 Agent 处理的问题", "error");
  if (context.busy) return notify("当前会话正在运行，请稍后再提交", "error");
  if (!run()) return;
  elements.submitAgent.disabled = true;
  try {
    const spec = strategySpec();
    const summary = result
      ? `当前结果：总收益 ${formatPercent(result.metrics.totalReturn)}，最大回撤 ${formatPercent(result.metrics.maximumDrawdown)}，Sharpe ${result.metrics.sharpe.toFixed(2)}。`
      : "";
    const prompt = [
      "请使用 quant-lab skill 处理下面的量化研究请求。",
      dataset.path
        ? `数据文件：${dataset.path}（${bars[0].date} 至 ${bars.at(-1).date}，${bars.length} 根日线）`
        : "当前面板使用合成演示数据；如需真实分析，请先准备 repo 内的 OHLCV CSV，并记录来源和截止日期。",
      `策略配置：${JSON.stringify(spec)}`,
      summary,
      "明确检查前视偏差、复权、交易成本、样本外验证和过拟合风险。不要把回测结果表述为投资建议。",
      "",
      `我的要求：${request}`,
    ].join("\n");
    await hostCall("agent.submitPrompt", { prompt });
    if (operationWorkspaceEpoch !== workspaceEpoch) return;
    elements.agentDialog.close();
    notify("已提交给当前 Agent");
  } catch (error) {
    if (operationWorkspaceEpoch !== workspaceEpoch) return;
    notify(error instanceof Error ? error.message : "提交失败", "error");
  } finally {
    if (operationWorkspaceEpoch === workspaceEpoch) {
      elements.submitAgent.disabled = context.busy;
    }
  }
}

function updateContext(next) {
  const previousWorkspaceRoot = typeof context.cwd === "string" ? context.cwd : null;
  const nextContext = { ...context, ...(next ?? {}) };
  const nextWorkspaceRoot = typeof nextContext.cwd === "string" ? nextContext.cwd : null;
  const workspaceChanged = contextInitialized && previousWorkspaceRoot !== nextWorkspaceRoot;
  if (workspaceChanged) {
    void saveUiState(previousWorkspaceRoot);
    bars = generateDemoBars();
    dataset = {
      kind: "demo",
      path: null,
      name: "DEMO / SYNTHETIC",
      source: "synthetic sample",
    };
    clearRunResult();
    workspaceEpoch += 1;
  }
  context = nextContext;
  contextInitialized = true;
  const workspaceUnavailable = context.trusted !== true;
  elements.loadData.disabled = workspaceUnavailable;
  elements.saveStrategy.disabled = workspaceUnavailable;
  elements.saveReport.disabled = workspaceUnavailable;
  elements.askAgent.disabled = Boolean(context.busy);
  elements.submitAgent.disabled = Boolean(context.busy);
  elements.agentState.textContent = context.busy
    ? "当前会话忙碌中"
    : context.trusted === false
      ? "工作区尚未信任"
      : "当前会话可用";
  if (workspaceChanged) {
    setRunState("SWITCHING");
    notify("工作区已切换；旧仓库行情已清除，正在载入新仓库参数");
    void restoreWorkspaceState(nextWorkspaceRoot, nextWorkspaceRoot ?? "preview", workspaceEpoch);
  }
}

elements.runBacktest.addEventListener("click", run);
elements.loadData.addEventListener("click", () => void loadCsv());
elements.dataPath.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void loadCsv();
});
elements.strategyType.addEventListener("change", () => {
  updateParameterVisibility();
  run();
});
for (const input of [
  elements.fastPeriod,
  elements.slowPeriod,
  elements.rsiPeriod,
  elements.rsiOversold,
  elements.rsiOverbought,
  elements.breakoutPeriod,
  elements.initialCapital,
  elements.feeBps,
  elements.slippageBps,
  elements.stopLoss,
]) {
  input.addEventListener("input", () => setRunState("PARAMS CHANGED"));
}
elements.saveStrategy.addEventListener("click", () => void saveStrategy());
elements.saveReport.addEventListener("click", () => void saveReport());
elements.askAgent.addEventListener("click", () => elements.agentDialog.showModal());
elements.submitAgent.addEventListener("click", () => void submitAgentRequest());
const chartTabs = [...document.querySelectorAll("[data-chart]")];
function activateChartTab(button, { focus = false } = {}) {
  chartMode = button.dataset.chart;
  for (const candidate of chartTabs) {
    const active = candidate === button;
    candidate.classList.toggle("active", active);
    candidate.setAttribute("aria-selected", String(active));
    candidate.tabIndex = active ? 0 : -1;
  }
  elements.chartWrap.setAttribute("aria-labelledby", button.id);
  if (focus) button.focus();
  renderChart();
}
for (const [index, button] of chartTabs.entries()) {
  button.addEventListener("click", () => activateChartTab(button));
  button.addEventListener("keydown", (event) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const targetIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? chartTabs.length - 1
          : delta
            ? (index + delta + chartTabs.length) % chartTabs.length
            : -1;
    if (targetIndex < 0) return;
    event.preventDefault();
    activateChartTab(chartTabs[targetIndex], { focus: true });
  });
}
for (const button of document.querySelectorAll("[data-prompt]")) {
  button.addEventListener("click", () => {
    elements.agentRequest.value = button.dataset.prompt;
    elements.agentRequest.focus();
  });
}
elements.chart.addEventListener("pointermove", updateChartTooltip);
elements.chart.addEventListener("pointerleave", hideChartTooltip);
window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  const activeTag = document.activeElement?.tagName;
  const interactive = ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(activeTag);
  if (event.key === "Enter" && !interactive && !elements.agentDialog.open) run();
});

async function initialize() {
  try {
    if (window.codeshellPanel?.getContext) updateContext(await window.codeshellPanel.getContext());
    else updateContext({ busy: false, trusted: true, cwd: "/preview/codeshell" });
    window.codeshellPanel?.on?.("context.changed", updateContext);
  } catch {
    updateContext({ busy: false, trusted: false });
  }
  const initializationWorkspaceEpoch = workspaceEpoch;
  const initializationWorkspaceIdentity = context.cwd ?? null;
  const initializationWorkspaceRoot = initializationWorkspaceIdentity ?? "preview";
  const saved = await hostCall("storage.get", {
    key: scopedStorageKey("configuration", initializationWorkspaceRoot),
  }).catch(() => null);
  if (
    initializationWorkspaceEpoch !== workspaceEpoch ||
    (context.cwd ?? null) !== initializationWorkspaceIdentity
  ) {
    return;
  }
  restoreUiState(saved?.workspaceRoot === initializationWorkspaceIdentity ? saved : null);
  updateParameterVisibility();
  renderDataset();
  run();
}

void initialize();
