import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PANEL_APP_MANIFEST_FILE,
  PanelAppManifest,
  installReviewedLocalPanelApp,
  listInstalledPanelApps,
  previewLocalPanelApp,
} from "../packages/core/src/panel-apps/index.js";
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
  relativeStrengthIndex,
  runBacktest,
  simpleMovingAverage,
} from "../examples/panel-apps/quant-lab/app/engine.mjs";

const ROOT = join(import.meta.dir, "..", "examples", "panel-apps", "quant-lab");

function trendingBars(count = 30) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index;
    return {
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      open: close - 0.25,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000,
    };
  });
}

describe("quant-lab engine", () => {
  test("parses chronological OHLCV data and rejects ambiguous rows", () => {
    expect(isSafeCsvPath("data/股票 日线.csv")).toBe(true);
    expect(isSafeCsvPath("../secret.csv")).toBe(false);
    expect(isSafeCsvPath("NODE_MODULES/secret.csv")).toBe(false);
    expect(isSafeCsvPath("C:/secret.csv")).toBe(false);
    expect(isSafeCsvPath("data/NUL.csv")).toBe(false);
    expect(isSafeCsvPath("data/COM1.prices.csv")).toBe(false);
    expect(isSafeCsvPath("data/trailing./secret.csv")).toBe(false);
    expect(isSafeCsvPath("data/trailing /secret.csv")).toBe(false);
    expect(markdownInlineCode("data/a`b.csv")).toBe("``data/a`b.csv``");
    expect(markdownPlainText("<img>\n&")).toBe("&lt;img&gt; &amp;");
    expect(markdownPlainText("[look](javascript:alert(1))")).toBe(
      "\\[look\\]\\(javascript:alert\\(1\\)\\)",
    );
    expect(fencedMarkdown('{"path":"```"}', "json")).toBe('````json\n{"path":"```"}\n````');
    const bars = parseOhlcvCsv(
      [
        "date,open,high,low,close,volume",
        "2026-01-03,11,12,10,11.5,1200",
        "2026-01-02,10,11,9,10.5,1000",
      ].join("\n"),
    );
    expect(bars.map((bar) => bar.date)).toEqual(["2026-01-02", "2026-01-03"]);
    expect(bars[1].volume).toBe(1200);
    expect(() =>
      parseOhlcvCsv(
        ["date,open,high,low,close", "2026-01-02,10,9,8,10", "2026-01-03,10,11,9,10"].join("\n"),
      ),
    ).toThrow(/inconsistent OHLC/);
    expect(() =>
      parseOhlcvCsv(
        ["date,open,high,low,close", "2026-01-02,10,11,9,10", "2026-01-02,10,11,9,10"].join("\n"),
      ),
    ).toThrow(/duplicates date/);
    expect(() =>
      parseOhlcvCsv(
        [
          "date,open,open,high,low,close",
          "2026-01-02,10,10,11,9,10",
          "2026-01-03,11,11,12,10,11",
        ].join("\n"),
      ),
    ).toThrow(/duplicate open columns/);
    expect(() =>
      parseOhlcvCsv(
        ["date,open,high,low,close", "2026-02-31,10,11,9,10", "2026-03-02,10,11,9,10"].join("\n"),
      ),
    ).toThrow(/invalid date/);
  });

  test("computes stable SMA and Wilder RSI indicators", () => {
    expect(simpleMovingAverage([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    const rsi = relativeStrengthIndex([1, 2, 3, 4, 5, 6], 3);
    expect(rsi.slice(0, 3)).toEqual([null, null, null]);
    expect(rsi[3]).toBe(100);
    expect(rsi[5]).toBe(100);
    expect(relativeStrengthIndex([5, 5, 5, 5, 5], 3).at(-1)).toBe(50);
  });

  test("surfaces deterministic dataset quality warnings", () => {
    const bars = trendingBars(30);
    bars[4] = { ...bars[4], volume: 0 };
    bars[5] = { ...bars[5], close: bars[4].close * 1.5, high: bars[4].close * 1.6 };
    const quality = analyzeDataset(bars);
    expect(quality.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["short-sample", "missing-volume", "weekend-bars", "large-jump"]),
    );
    expect(analyzeDataset(bars)).toEqual(quality);
  });

  test("executes a close signal at the next bar open and applies costs", () => {
    const bars = trendingBars();
    const base = {
      strategy: { type: "sma-cross", fast: 2, slow: 3 },
      initialCapital: 100_000,
      feeBps: 0,
      slippageBps: 0,
      stopLossPct: 0,
    };
    const clean = runBacktest(bars, base);
    const costly = runBacktest(bars, { ...base, feeBps: 20, slippageBps: 10 });
    // The first valid crossover exists after the third close; execution is the following open.
    expect(clean.trades[0].entryDate).toBe(bars[3].date);
    expect(clean.trades[0].reason).toBe("end");
    expect(costly.metrics.finalEquity).toBeLessThan(clean.metrics.finalEquity);
    expect(clean.metrics.maximumDrawdown).toBeLessThanOrEqual(0);
    expect(clean.metrics.benchmarkReturn).toBeGreaterThan(0);
    expect(Number.isFinite(clean.metrics.annualizedVolatility)).toBe(true);
    expect(clean.metrics.averageTradeReturn).toBeGreaterThan(0);

    const stopBars = trendingBars();
    stopBars[6] = { ...stopBars[6], low: 1 };
    const stopped = runBacktest(stopBars, { ...base, stopLossPct: 5 });
    expect(stopped.trades[0].reason).toBe("stop");
    expect(stopped.trades[1].entryDate).not.toBe(stopped.trades[0].exitDate);

    const intradayOnly = trendingBars(20).map((bar, index) =>
      index >= 3 ? { ...bar, low: 1 } : bar,
    );
    const intradayStops = runBacktest(intradayOnly, { ...base, stopLossPct: 5 });
    expect(intradayStops.trades.every((trade) => trade.reason === "stop")).toBe(true);
    expect(intradayStops.metrics.exposure).toBeGreaterThan(0);
  });

  test("runs all bundled strategies against deterministic demo data", () => {
    const bars = generateDemoBars(260);
    expect(fingerprintText("abc")).toBe("fnv1a32:1a47e90b");
    expect(fingerprintBars(bars)).toBe(fingerprintBars(generateDemoBars(260)));
    expect(fingerprintBars(bars)).not.toBe(fingerprintBars(generateDemoBars(261)));
    const strategies = [
      { type: "sma-cross", fast: 20, slow: 50 },
      { type: "rsi-reversion", period: 14, oversold: 30, overbought: 65 },
      { type: "breakout", lookback: 20 },
    ];
    for (const strategy of strategies) {
      const run = runBacktest(bars, {
        strategy,
        initialCapital: 100_000,
        feeBps: 5,
        slippageBps: 2,
        stopLossPct: 8,
      });
      expect(run.equity).toHaveLength(260);
      expect(Number.isFinite(run.metrics.finalEquity)).toBe(true);
      expect(Number.isFinite(run.metrics.sharpe)).toBe(true);
    }
  });

  test("rejects invalid strategy and cost assumptions instead of producing misleading output", () => {
    const bars = generateDemoBars(60);
    const base = {
      initialCapital: 100_000,
      feeBps: 5,
      slippageBps: 2,
      stopLossPct: 8,
    };
    expect(() =>
      runBacktest(bars, {
        ...base,
        strategy: { type: "sma-cross", fast: 50, slow: 20 },
      }),
    ).toThrow(/fast < slow/);
    expect(() =>
      runBacktest(bars, {
        ...base,
        strategy: { type: "rsi-reversion", period: 14, oversold: 70, overbought: 30 },
      }),
    ).toThrow(/oversold < overbought/);
    expect(() =>
      runBacktest(bars, {
        ...base,
        stopLossPct: -1,
        strategy: { type: "breakout", lookback: 20 },
      }),
    ).toThrow(/between 0%/);
    expect(() =>
      runBacktest(bars, {
        ...base,
        slippageBps: 10_000,
        strategy: { type: "breakout", lookback: 20 },
      }),
    ).toThrow(/between 0 and 10000 bps/);
    expect(() => generateDemoBars(Number.POSITIVE_INFINITY)).toThrow(/integer between 1 and 5000/);
    expect(() =>
      runBacktest([...bars].reverse(), {
        ...base,
        strategy: { type: "breakout", lookback: 20 },
      }),
    ).toThrow(/strictly chronological/);
    const invalidBars = structuredClone(bars);
    invalidBars[4].high = Number.NaN;
    expect(() =>
      runBacktest(invalidBars, {
        ...base,
        strategy: { type: "breakout", lookback: 20 },
      }),
    ).toThrow(/positive finite number/);
    expect(() =>
      runBacktest(bars, {
        ...base,
        strategy: { type: "sma-cross", fast: 10, slow: 59 },
      }),
    ).toThrow(/too few executable bars/);
  });
});

describe("quant-lab example Panel App", () => {
  test("declares and installs a standalone local research application", async () => {
    const manifest = PanelAppManifest.parse(
      JSON.parse(readFileSync(join(ROOT, PANEL_APP_MANIFEST_FILE), "utf-8")),
    );
    expect(manifest).toMatchObject({
      id: "quant-lab",
      entry: "app/index.html",
      icon: "line-chart",
    });
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["workspace.read", "workspace.write", "agent.submitPrompt"]),
    );

    const home = mkdtempSync(join(tmpdir(), "quant-lab-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const preview = await previewLocalPanelApp({ kind: "dir", path: ROOT });
      await installReviewedLocalPanelApp(
        { kind: "dir", path: ROOT },
        preview.reviewToken,
        "2026-07-28T00:00:00.000Z",
      );
      expect(await listInstalledPanelApps()).toEqual([
        expect.objectContaining({
          id: "quant-lab",
          entry: "app/index.html",
        }),
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ships a CSP-compatible app with no direct network dependency", () => {
    const html = readFileSync(join(ROOT, "app", "index.html"), "utf-8");
    const app = readFileSync(join(ROOT, "app", "app.js"), "utf-8");
    const schema = JSON.parse(
      readFileSync(join(ROOT, "app", "formats", "quant-strategy-v1.schema.json"), "utf-8"),
    );
    expect(html).toContain('<script type="module" src="./app.js"></script>');
    expect(html).toContain('id="data-quality"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toMatch(/<script(?![^>]+src=)/);
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        format: { const: "codeshell.quant-strategy" },
        version: { const: 1 },
      },
    });
    const boundIds = [...app.matchAll(/querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);
    expect([...new Set(boundIds)].filter((id) => !html.includes(`id="${id}"`))).toEqual([]);
    expect(app).toContain('"workspace.readText"');
    expect(app).toContain('"workspace.writeText"');
    expect(app).toContain("result.trades.slice(0, 500)");
    expect(app).toContain("fingerprintBars(bars).split");
    expect(app).toContain("configurationSlug(spec)");
    expect(app).toContain("activateChartTab");
    expect(app).toContain("const loadedResult = runBacktest(loadedBars");
    expect(app).toContain("clearRunResult");
    expect(app).toContain('scopedStorageKey("configuration", workspaceRoot ?? "preview")');
    expect(app).toContain("if (event.defaultPrevented) return");
    expect(app).toContain("const workspaceUnavailable = context.trusted !== true");
    expect(app).toContain("void saveUiState(previousWorkspaceRoot)");
    expect(app).toContain("contextInitialized && previousWorkspaceRoot !== nextWorkspaceRoot");
    expect(app).toContain("(context.cwd ?? null) !== workspaceIdentity");
    expect(app).toContain("saved?.workspaceRoot === workspaceIdentity");
    expect(app).toContain("旧仓库行情已清除");
    expect(app).toContain("operationWorkspaceEpoch !== workspaceEpoch");
    expect(app).not.toMatch(/\bfetch\s*\(/);
    expect(app).not.toContain("https://");
  });
});
