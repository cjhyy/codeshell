import React from "react";
import { useT } from "../i18n/I18nProvider";
import type { CacheChartData, CacheSeries, CacheVolume } from "./usageCacheSeries";
import {
  cacheFormatters,
  formatRate,
  niceMax,
  seriesColour,
  tickIndices,
} from "./usageCacheFormat";

/** Width of the y-axis column, which stays put while the plot beside it scrolls. */
const AXIS = 44;
const RIGHT = 16;
const TOP = 12;
const RATE_HEIGHT = 168;
const PANEL_GAP = 20;
const VOLUME_HEIGHT = 64;
const AXIS_BAND = 24;
const HEIGHT = TOP + RATE_HEIGHT + PANEL_GAP + VOLUME_HEIGHT + AXIS_BAND;
const VOLUME_TOP = TOP + RATE_HEIGHT + PANEL_GAP;
const VOLUME_BASE = VOLUME_TOP + VOLUME_HEIGHT;
/** Hourly data over a week needs more room than a narrow page has; the plot scrolls instead. */
const MIN_STEP = 6;
const SURFACE = "hsl(var(--cs-card))";

const rateY = (rate: number) => TOP + (1 - rate) * RATE_HEIGHT;

/** A bar segment whose top corners are rounded only when it is the data end. */
function segment(x: number, width: number, top: number, bottom: number, round: boolean): string {
  const radius = round ? Math.min(4, width / 2, bottom - top) : 0;
  return [
    `M${x},${bottom}`,
    `V${top + radius}`,
    `Q${x},${top} ${x + radius},${top}`,
    `H${x + width - radius}`,
    `Q${x + width},${top} ${x + width},${top + radius}`,
    `V${bottom}Z`,
  ].join("");
}

/** Consecutive measured buckets form a line; a measured bucket with no neighbour is a dot. */
function trace(entry: CacheSeries, x: (index: number) => number) {
  let path = "";
  const dots: number[] = [];
  entry.points.forEach((value, index) => {
    if (value.rate === null) return;
    const joined = index > 0 && entry.points[index - 1]!.rate !== null;
    path += `${joined ? "L" : "M"}${x(index)},${rateY(value.rate)}`;
    if (!joined && entry.points[index + 1]?.rate == null) dots.push(index);
  });
  return { path, dots };
}

/** Beside the crosshair when there is room; on a narrow page, pinned to the far edge instead. */
function tooltipPlacement(anchor: number, available: number): React.CSSProperties {
  const leftHalf = anchor <= available / 2;
  if (available < 560) return leftHalf ? { right: 8 } : { left: 8 };
  return leftHalf ? { left: anchor + 12 } : { left: anchor - 12, transform: "translateX(-100%)" };
}

export function UsageCachePlot({
  data,
  visible,
  volume,
  label,
}: {
  data: CacheChartData;
  visible: CacheSeries[];
  volume: CacheVolume[];
  label: (entry: CacheSeries) => string;
}) {
  const { t, lang } = useT();
  const format = React.useMemo(() => cacheFormatters(lang), [lang]);
  const scroller = React.useRef<HTMLDivElement>(null);
  const [available, setAvailable] = React.useState(640);
  const [scrollLeft, setScrollLeft] = React.useState(0);
  const [active, setActive] = React.useState<number>();
  const hintId = React.useId();

  React.useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (element.clientWidth > 0) setAvailable(element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const count = data.buckets.length;
  const step = Math.max(MIN_STEP, (available - RIGHT) / count);
  const width = RIGHT + step * count;
  const x = (index: number) => (index + 0.5) * step;
  const ticks = tickIndices(data.buckets, data.bucketMs, step);
  const volumeMax = niceMax(Math.max(0, ...volume.map((value) => value.cached + value.uncached)));
  const volumeY = (value: number) => VOLUME_BASE - (value / volumeMax) * VOLUME_HEIGHT;
  const barWidth = Math.max(1, Math.min(24, step - 2));
  const current = active !== undefined && active < count ? active : undefined;

  const show = (index: number) => {
    const next = Math.max(0, Math.min(count - 1, index));
    setActive(next);
    const element = scroller.current;
    if (!element) return;
    // Keep the bucket being read on screen when the plot is wider than its frame.
    if (x(next) - step < element.scrollLeft) element.scrollLeft = Math.max(0, x(next) - step);
    else if (x(next) + step > element.scrollLeft + element.clientWidth)
      element.scrollLeft = x(next) + step - element.clientWidth;
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const from = current ?? (event.key === "ArrowLeft" ? count : -1);
    if (event.key === "ArrowRight") show(from + 1);
    else if (event.key === "ArrowLeft") show(from - 1);
    else if (event.key === "Home") show(0);
    else if (event.key === "End") show(count - 1);
    else if (event.key === "Escape") setActive(undefined);
    else return;
    event.preventDefault();
  };

  const anchor = current === undefined ? 0 : AXIS + x(current) - scrollLeft;
  const rows =
    current === undefined ? [] : visible.filter((entry) => entry.points[current]!.requests > 0);

  return (
    <div className="relative flex">
      {/* Same height and scales as the plot, so each label sits on its gridline. */}
      <svg
        data-cache-axis=""
        width={AXIS}
        height={HEIGHT}
        viewBox={`0 0 ${AXIS} ${HEIGHT}`}
        aria-hidden
        className="block shrink-0 text-[11px] tabular-nums"
      >
        {[0, 0.5, 1].map((rate) => (
          <text
            key={rate}
            x={AXIS - 8}
            y={rateY(rate)}
            dy="0.32em"
            textAnchor="end"
            className="fill-muted-foreground"
          >
            {formatRate(rate)}
          </text>
        ))}
        {[volumeMax, 0].map((value) => (
          <text
            key={value}
            x={AXIS - 8}
            y={volumeY(value)}
            dy="0.32em"
            textAnchor="end"
            className="fill-muted-foreground"
          >
            {format.compact(value)}
          </text>
        ))}
      </svg>
      <div
        ref={scroller}
        data-cache-plot=""
        role="group"
        tabIndex={0}
        aria-label={t("usagePage.cacheChartPlot", { count })}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(undefined)}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        className="min-w-0 flex-1 overflow-x-auto rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          aria-hidden
          className="block text-[11px] tabular-nums"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((rate) => (
            <g key={rate}>
              <line
                x1={0}
                x2={width - RIGHT}
                y1={rateY(rate)}
                y2={rateY(rate)}
                className={rate === 0 ? "stroke-border" : "stroke-border/50"}
              />
            </g>
          ))}
          <line
            x1={0}
            x2={width - RIGHT}
            y1={VOLUME_TOP}
            y2={VOLUME_TOP}
            className="stroke-border/50"
          />
          <line
            x1={0}
            x2={width - RIGHT}
            y1={VOLUME_BASE}
            y2={VOLUME_BASE}
            className="stroke-border"
          />
          {ticks.indices.map((index) => (
            <text
              key={index}
              x={x(index)}
              y={VOLUME_BASE + 16}
              textAnchor="middle"
              className="fill-muted-foreground"
            >
              {format.tick(data.buckets[index]!, data.bucketMs, ticks.daysOnly)}
            </text>
          ))}

          {volume.map((value, index) => {
            const left = x(index) - barWidth / 2;
            const cachedTop = volumeY(value.cached);
            // A surface-coloured gap, not an outline, separates the two parts of a bar.
            const gap = value.cached > 0 && value.uncached > 0 ? 2 : 0;
            const top = volumeY(value.cached + value.uncached);
            return (
              <g key={index} opacity={current === undefined || current === index ? 1 : 0.55}>
                {value.cached > 0 && (
                  <path
                    data-volume="cached"
                    d={segment(left, barWidth, cachedTop, VOLUME_BASE, value.uncached === 0)}
                    className="fill-foreground/75"
                  />
                )}
                {value.uncached > 0 && cachedTop - gap > top && (
                  <path
                    data-volume="uncached"
                    d={segment(left, barWidth, top, cachedTop - gap, true)}
                    className="fill-muted-foreground/60"
                  />
                )}
              </g>
            );
          })}

          {current !== undefined && (
            <line
              x1={x(current)}
              x2={x(current)}
              y1={TOP}
              y2={VOLUME_BASE}
              className="stroke-muted-foreground/70"
            />
          )}
          {visible.map((entry) => {
            const { path, dots } = trace(entry, x);
            const marked = current !== undefined && entry.points[current]!.rate !== null;
            return (
              <g key={entry.key}>
                <path
                  data-series-line={entry.key}
                  d={path}
                  fill="none"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  style={{ stroke: seriesColour(entry) }}
                />
                {[...dots, ...(marked && !dots.includes(current!) ? [current!] : [])].map(
                  (index) => (
                    <circle
                      key={index}
                      cx={x(index)}
                      cy={rateY(entry.points[index]!.rate!)}
                      r={4}
                      strokeWidth={2}
                      style={{ fill: seriesColour(entry), stroke: SURFACE }}
                    />
                  ),
                )}
              </g>
            );
          })}
          <rect
            data-cache-hit-area=""
            x={0}
            y={0}
            width={step * count}
            height={HEIGHT}
            fill="transparent"
            onPointerMove={(event) => {
              const offset = event.clientX - event.currentTarget.getBoundingClientRect().left;
              setActive(Math.max(0, Math.min(count - 1, Math.floor(offset / step))));
            }}
            onPointerLeave={() => setActive(undefined)}
          />
        </svg>
      </div>
      <p id={hintId} className="sr-only">
        {t("usagePage.cacheChartKeyboardHint")}
      </p>
      {current !== undefined && (
        <div
          data-cache-tooltip=""
          role="status"
          className="cs-popup-surface pointer-events-none absolute top-2 z-10 w-max max-w-[min(20rem,calc(100%-1rem))] rounded-lg px-3 py-2 text-xs"
          style={tooltipPlacement(anchor, AXIS + available)}
        >
          <p className="font-medium">
            {format.period(data.buckets[current]!, data.bucketEnds[current]!, data.bucketMs)}
          </p>
          {!rows.length && (
            <p className="mt-1 text-muted-foreground">{t("usagePage.cacheChartNoRequests")}</p>
          )}
          {rows.map((entry) => {
            const value = entry.points[current]!;
            return (
              <div key={entry.key} className="mt-2 flex items-start gap-2">
                <span
                  aria-hidden
                  className="mt-[7px] h-0.5 w-3 shrink-0 rounded-full"
                  style={{ background: seriesColour(entry) }}
                />
                <div className="min-w-0">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-semibold tabular-nums">
                      {value.rate === null
                        ? t("usagePage.cacheChartLowVolume")
                        : formatRate(value.rate)}
                    </span>
                    <span className="break-all text-muted-foreground">{label(entry)}</span>
                  </p>
                  <p className="tabular-nums text-muted-foreground">
                    {t("usagePage.cacheChartTipDetail", {
                      input: format.compact(value.promptTokens),
                      cached: format.compact(value.cacheReadTokens),
                      requests: format.full(value.requests),
                    })}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
