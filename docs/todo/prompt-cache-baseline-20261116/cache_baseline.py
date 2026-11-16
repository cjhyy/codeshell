#!/usr/bin/env python3
"""Prompt-cache baseline for a CodeShell home directory.

Reads only local diagnostics and prints aggregates. It never prints prompt
text, session titles or file paths.

Sources
  ~/.code-shell/logs/engine-*.log            llm.request / llm.request.end / engine.run
  ~/.code-shell/sessions/.model-traces/records/*.json   one record per model call
  ~/.code-shell/sessions/pet-*/transcript.jsonl         run_result records only

Usage
  python3 cache_baseline.py [--home ~/.code-shell] [--model openai/gpt-6.1-sol ...]

Method
  Table 1 (cost by purpose) sums the trace records, which carry the call's
  purpose (main, aux_summary, subagent, ...) and the pricing snapshot. The
  cached-input price in that snapshot is an estimate (input x 0.1).

  Table 2 (loss attribution) walks consecutive main-loop requests of one
  session in the engine log, separately for each cache strategy, because the
  strategy changed with the application version (openai-implicit before
  0.10.0, openai-hybrid from 0.10.0). In an append-only world the whole
  previous prompt is a prefix of the next one, so
      loss = max(0, min(prev.prompt, cur.prompt) - cur.cacheRead)
  and each loss above max(2000, 5%) goes into the first bucket that applies:
      first request     no earlier request of the same strategy in the session
      cold              the gap exceeds the strategy's retention
                        (5 minutes implicit, 30 minutes hybrid)
      restart or config tools, system and config fingerprints all changed, or
                        the config fingerprint changed. Fingerprints are HMACs
                        with a per-process key, so a worker restart looks the
                        same as a model or route switch.
      head: ...         tools and/or system fingerprint changed within one process
      run start         first request of a run
      mid-run           anything else
  The fingerprint does not cover the first user-context message, so an edited
  instruction file shows up as run start or mid-run.
  Test fixtures write to the same log; only real session id shapes are kept.

  Table 3 gives reuse = min(cur.cacheRead, expected) / expected for run starts
  inside the retention window with an unchanged head, and for consecutive
  requests inside a run, plus main-loop request sizes from the trace records.

  Table 4 (Mimi runs) reads only the run_result records of pet sessions'
  transcripts: timestamp, step count and token usage.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import glob
import json
import os
import re
import statistics

KINDS = [
    ("work", re.compile(r"^s-[a-z0-9]{6,10}-[0-9a-f]{8}$")),
    ("mimi", re.compile(r"^pet-[0-9a-f]{8}-[0-9a-f]{4}-")),
    ("mimi-work", re.compile(r"^pet-work-[0-9a-f]{16,}$")),
    ("subagent", re.compile(r"^[A-Za-z0-9_-]{8}$")),
]
RETENTION = {"openai-hybrid": 1800, "openai-implicit": 300}
CAUSES = [
    "mid-run",
    "run start",
    "cold",
    "head: tools only",
    "head: system only",
    "head: tools + system",
    "restart or config",
    "first request",
]


def kind_of(sid: str | None) -> str | None:
    for name, rx in KINDS:
        if rx.match(sid or ""):
            return name
    return None


def ts(value: str) -> float:
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def day(value: float) -> str:
    return datetime.datetime.fromtimestamp(value).strftime("%Y-%m-%d")


def load_requests(home: str, models: set[str]) -> tuple[list[dict], collections.Counter]:
    requests: list[dict] = []
    skipped: collections.Counter = collections.Counter()
    last_end: dict[str, dict] = {}
    run_started: dict[str, bool] = {}
    for path in sorted(glob.glob(os.path.join(home, "logs", "engine-*.log"))):
        with open(path, errors="ignore") as handle:
            for line in handle:
                if '"llm.request' not in line and '"engine.run"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                sid = row.get("sid")
                kind = kind_of(sid)
                if not kind:
                    continue
                msg, data = row.get("msg"), row.get("d") or {}
                if msg == "engine.run":
                    run_started[sid] = True
                elif msg == "llm.request.end":
                    last_end[sid] = data
                elif msg == "llm.request":
                    usage = data.get("usage") or {}
                    end = last_end.pop(sid, None) or {}
                    if not usage.get("promptTokens"):
                        continue
                    if end.get("model") not in models:
                        skipped[end.get("model") or "unknown"] += 1
                        continue
                    prefix = data.get("promptPrefix") or {}
                    requests.append(
                        {
                            "t": ts(row["t"]),
                            "sid": sid,
                            "kind": kind,
                            "strategy": end.get("cacheStrategy") or "unknown",
                            "prompt": usage.get("promptTokens") or 0,
                            "read": usage.get("cacheReadTokens") or 0,
                            "tools": prefix.get("toolsHash"),
                            "system": prefix.get("systemHash"),
                            "config": (prefix.get("configHash"), prefix.get("cacheScopeHash")),
                            "fingerprint": bool(prefix),
                            "run_start": run_started.pop(sid, False),
                        }
                    )
    return requests, skipped


def classify(prev: dict | None, row: dict) -> tuple[str, int, int]:
    """Return (cause, lost tokens, expected reusable tokens)."""
    if prev is None or prev["strategy"] != row["strategy"]:
        return "first request", row["prompt"] - row["read"], 0
    expected = min(prev["prompt"], row["prompt"])
    lost = max(0, expected - row["read"])
    if lost <= max(2000, 0.05 * expected):
        return "ok", lost, expected
    if row["t"] - prev["t"] > RETENTION.get(row["strategy"], 300):
        return "cold", lost, expected
    tools, system = row["tools"] != prev["tools"], row["system"] != prev["system"]
    if row["config"] != prev["config"]:
        return "restart or config", lost, expected
    if tools and system:
        return "head: tools + system", lost, expected
    if tools:
        return "head: tools only", lost, expected
    if system:
        return "head: system only", lost, expected
    return ("run start" if row["run_start"] else "mid-run"), lost, expected


def attribution(requests: list[dict]) -> None:
    by_session: dict[str, list[dict]] = collections.defaultdict(list)
    for request in requests:
        by_session[request["sid"]].append(request)

    totals: dict[tuple, collections.Counter] = collections.defaultdict(collections.Counter)
    loss: dict[tuple, collections.Counter] = collections.defaultdict(collections.Counter)
    events: dict[tuple, collections.Counter] = collections.defaultdict(collections.Counter)
    span: dict[str, list[float]] = {}
    sessions: dict[tuple, set] = collections.defaultdict(set)
    starts: dict[str, list[float]] = collections.defaultdict(lambda: [0, 0.0, 0.0])
    inside: dict[str, list[float]] = collections.defaultdict(lambda: [0.0, 0.0])
    for rows in by_session.values():
        rows.sort(key=lambda r: r["t"])
        prev = None
        for row in rows:
            key = (row["strategy"], row["kind"])
            total = totals[key]
            total["requests"] += 1
            total["prompt"] += row["prompt"]
            total["read"] += row["read"]
            total["no_fingerprint"] += 0 if row["fingerprint"] else 1
            sessions[key].add(row["sid"])
            bounds = span.setdefault(row["strategy"], [row["t"], row["t"]])
            bounds[0], bounds[1] = min(bounds[0], row["t"]), max(bounds[1], row["t"])
            cause, lost, expected = classify(prev, row)
            loss[key][cause] += lost
            events[key][cause] += 1
            if prev is not None and prev["strategy"] == row["strategy"]:
                total["new_tail"] += max(0, row["prompt"] - prev["prompt"])
                if cause in ("ok", "run start", "mid-run"):
                    cell = starts[row["strategy"]] if row["run_start"] else None
                    if cell is not None:
                        cell[0] += 1
                        cell[1] += expected
                        cell[2] += min(row["read"], expected)
                    else:
                        inside[row["strategy"]][0] += expected
                        inside[row["strategy"]][1] += min(row["read"], expected)
            prev = row

    print("\nTable 2. Main-loop loss attribution by cache strategy (engine log)")
    for strategy in sorted(span, key=lambda name: span[name][0]):
        keys = [key for key in totals if key[0] == strategy]
        prompt = sum(totals[key]["prompt"] for key in keys)
        read = sum(totals[key]["read"] for key in keys)
        print(
            f"\n[{strategy}] {day(span[strategy][0])} -> {day(span[strategy][1])}: "
            f"{sum(totals[key]['requests'] for key in keys)} requests, "
            f"{len(set().union(*(sessions[key] for key in keys)))} sessions, "
            f"input {prompt / 1e6:.2f}M, hit {100 * read / prompt:.1f}%, "
            f"new tail {sum(totals[key]['new_tail'] for key in keys) / 1e6:.2f}M, "
            f"requests without fingerprint {sum(totals[key]['no_fingerprint'] for key in keys)}"
        )
        kinds = sorted({key[1] for key in keys}, key=lambda name: -totals[(strategy, name)]["prompt"])
        header = "".join(f"{name + ' M':>12s}" for name in kinds)
        print(f"{'cause':22s} {'events':>7s} {'lost M':>8s} {'% loss':>7s} {'% input':>8s}{header}")
        whole = sum(tokens for key in keys for cause, tokens in loss[key].items() if cause != "ok") or 1
        for cause in CAUSES:
            tokens = sum(loss[key][cause] for key in keys)
            count = sum(events[key][cause] for key in keys)
            if not count:
                continue
            per_kind = "".join(f"{loss[(strategy, name)][cause] / 1e6:12.2f}" for name in kinds)
            print(
                f"{cause:22s} {count:7d} {tokens / 1e6:8.2f} {100 * tokens / whole:6.1f}% "
                f"{100 * tokens / prompt:7.1f}%{per_kind}"
            )
        print(f"{'total':22s} {'':7s} {whole / 1e6:8.2f} {'':7s} {100 * whole / prompt:7.1f}%")

    print("\nTable 3. Reuse of the previous request (retention window, head unchanged)")
    print(f"{'strategy':18s} {'run starts':>10s} {'expected M':>10s} {'reuse %':>8s} {'inside-run reuse %':>19s}")
    for strategy in sorted(span, key=lambda name: span[name][0]):
        count, expected, read = starts[strategy]
        within = inside[strategy]
        print(
            f"{strategy:18s} {count:10d} {expected / 1e6:10.2f} {100 * read / max(1, expected):8.1f} "
            f"{100 * within[1] / max(1, within[0]):19.1f}"
        )


def cost_by_purpose(home: str, models: set[str]) -> None:
    rows: dict[tuple, collections.Counter] = collections.defaultdict(collections.Counter)
    first, last, price, app_estimate = 1e18, 0.0, None, 0.0
    sizes: list[int] = []
    for path in glob.glob(os.path.join(home, "sessions", ".model-traces", "records", "*.json")):
        try:
            with open(path) as handle:
                record = json.load(handle)
        except (OSError, ValueError):
            continue
        if record.get("model") not in models:
            continue
        kind = kind_of(record.get("sessionId") or "") or "other"
        usage = record.get("usage") or {}
        purpose = record.get("purpose") or "?"
        row = rows[(kind, purpose)]
        row["calls"] += 1
        row["prompt"] += usage.get("promptTokens") or 0
        row["read"] += usage.get("cacheReadTokens") or 0
        row["out"] += usage.get("completionTokens") or 0
        app_estimate += record.get("estimatedCostUsd") or 0
        if purpose == "main":
            sizes.append(usage.get("promptTokens") or 0)
        started = record.get("startedAt") or 0
        first, last = min(first, started), max(last, started)
        price = price or record.get("pricing")
    if not rows:
        print("\nTable 1. No trace records for the selected models.")
        return
    price = price or {}
    p_in, p_read, p_out = price.get("input") or 0, price.get("cacheRead") or 0, price.get("output") or 0

    def usd(row: collections.Counter) -> float:
        return ((row["prompt"] - row["read"]) * p_in + row["read"] * p_read + row["out"] * p_out) / 1e6

    print(f"\nTable 1. Cost by purpose (trace records, {day(first / 1000)} -> {day(last / 1000)})")
    print(
        f"prices per 1M tokens: input {p_in}, cached input {p_read} "
        f"({'estimated' if price.get('cachePricesEstimated') else 'listed'}), output {p_out}; "
        "no cache-write premium"
    )
    print(f"{'kind':10s} {'purpose':18s} {'calls':>6s} {'input M':>9s} {'hit %':>6s} {'uncached M':>10s} {'USD':>8s}")
    total: collections.Counter = collections.Counter()
    total_usd = 0.0
    for key, row in sorted(rows.items(), key=lambda item: -usd(item[1])):
        if not row["prompt"]:
            continue
        cost = usd(row)
        total_usd += cost
        total.update(row)
        print(
            f"{key[0]:10s} {key[1][:18]:18s} {row['calls']:6d} {row['prompt'] / 1e6:9.2f} "
            f"{100 * row['read'] / row['prompt']:6.1f} {(row['prompt'] - row['read']) / 1e6:10.2f} {cost:8.2f}"
        )
    print(
        f"{'total':10s} {'':18s} {total['calls']:6d} {total['prompt'] / 1e6:9.2f} "
        f"{100 * total['read'] / total['prompt']:6.1f} {(total['prompt'] - total['read']) / 1e6:10.2f} {total_usd:8.2f}"
    )
    floor = (total["prompt"] * p_read + total["out"] * p_out) / 1e6
    print(f"floor if every input token were a cache read: {floor:.2f} USD")
    print(f"the application's own estimate for the same calls (with a 1.25x write premium): {app_estimate:.2f} USD")
    if sizes:
        sizes.sort()
        big = sum(size for size in sizes if size > 150_000)
        print(
            f"main-loop request size: median {int(statistics.median(sizes))}, "
            f"p90 {sizes[int(len(sizes) * 0.9)]}, max {sizes[-1]}; "
            f"requests above 150K carry {100 * big / max(1, sum(sizes)):.0f}% of main-loop input"
        )


def mimi_runs(home: str, since_days: int) -> None:
    cutoff = datetime.datetime.now().timestamp() - since_days * 86400
    runs: list[tuple[float, int, int, int]] = []
    for path in glob.glob(os.path.join(home, "sessions", "pet-*", "transcript.jsonl")):
        if kind_of(os.path.basename(os.path.dirname(path))) != "mimi":
            continue
        with open(path, errors="ignore") as handle:
            for line in handle:
                if '"run_result"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                result = (row.get("data") or {}).get("result") or {}
                usage = result.get("usage") or {}
                runs.append(
                    (
                        row.get("timestamp", 0) / 1000,
                        result.get("turnCount") or 0,
                        usage.get("promptTokens") or 0,
                        usage.get("cacheReadTokens") or 0,
                    )
                )
    runs = sorted(run for run in runs if run[0] >= cutoff)
    if len(runs) < 2:
        print(f"\nTable 4. Mimi runs: fewer than two runs in the last {since_days} days.")
        return
    gaps: collections.Counter = collections.Counter()
    for earlier, later in zip(runs, runs[1:]):
        gap = later[0] - earlier[0]
        gaps["<=5m" if gap <= 300 else "5-30m" if gap <= 1800 else ">30m"] += 1
    steps = [run[1] for run in runs if run[1]]
    per_step = sorted(run[2] / run[1] for run in runs if run[1] and run[2])
    prompt = sum(run[2] for run in runs)
    print(f"\nTable 4. Mimi runs in the last {since_days} days (run_result records only)")
    print(f"runs {len(runs)}; hit {100 * sum(run[3] for run in runs) / max(1, prompt):.1f}%")
    print("gap to previous run: " + ", ".join(f"{name} {gaps[name]}" for name in ("<=5m", "5-30m", ">30m")))
    print(f"steps per run: median {statistics.median(steps)}, mean {sum(steps) / len(steps):.1f}, max {max(steps)}")
    if per_step:
        print(f"input tokens per step: median {int(statistics.median(per_step))}, p90 {int(per_step[int(len(per_step) * 0.9)])}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--home", default=os.path.expanduser("~/.code-shell"))
    parser.add_argument("--model", action="append", default=None)
    parser.add_argument("--mimi-days", type=int, default=32, help="window for Table 4")
    args = parser.parse_args()
    models = set(args.model or ["openai/gpt-6.1-sol"])
    cost_by_purpose(args.home, models)
    requests, skipped = load_requests(args.home, models)
    attribution([request for request in requests if request["kind"] != "subagent"])
    if skipped:
        print("\nmain-loop requests of other models left out: " + ", ".join(f"{name} {count}" for name, count in skipped.most_common()))
    mimi_runs(args.home, args.mimi_days)


if __name__ == "__main__":
    main()
