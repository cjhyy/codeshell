import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BATCH = ROOT / "docs/audit-2026-10-17-round19"
BASE = "5f5cf69df8526470700712a4dc2d5ae6bd2da132"
patterns = {
    "exact_leaf": r"stream-timing|stampStreamEvent|createRunTiming",
    "timing_contract": r"(?:monotonic|单调|logical submission|逻辑.{0,8}(?:计时|时钟)).{0,100}(?:duration|terminal|complete|持续|耗时|结束)|(?:durationMs|completedAt|startedAt).{0,90}(?:replay|child|parent|回放|子|父)",
    "source_timestamp": r"(?:timestamp|时间戳).{0,100}(?:journal|reconnect|invalid|stable|回放|重连|保留|无效)",
    "excluded_recorder_direction": r"recorder.{0,80}midnight|midnight.{0,80}recorder|recorder.{0,80}跨日|跨日.{0,80}recorder",
}
compiled = {key: re.compile(value, re.I) for key, value in patterns.items()}
inventory = subprocess.check_output(
    ["rg", "--files", "docs", "bugs", "-g", "*.md", "-g", "*.json"],
    cwd=ROOT, text=True,
).splitlines()
files = [path for path in sorted(inventory) if not (ROOT / path).is_relative_to(BATCH)]
stats = {"files": len(files), "markdownFiles": 0, "jsonFiles": 0, "jsonStringLeaves": 0, "jsonScalarLeaves": 0, "readOrParseErrors": []}
matches = {key: [] for key in patterns}
contexts = {key: [] for key in patterns}
context_cap = 18

def scan_text(path, locator, value):
    for key, regex in compiled.items():
        for found in regex.finditer(value):
            matches[key].append({"path": path, "locator": locator, "offset": found.start()})
            if len(contexts[key]) < context_cap:
                contexts[key].append({"path": path, "locator": locator, "context": value[max(0, found.start()-100):found.end()+160]})

def scan_json(path, value, locator="$"):
    if isinstance(value, dict):
        for key, child in value.items():
            scan_json(path, child, f"{locator}[{json.dumps(key, ensure_ascii=False)}]")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            scan_json(path, child, f"{locator}[{index}]")
    else:
        stats["jsonScalarLeaves"] += 1
        if isinstance(value, str):
            stats["jsonStringLeaves"] += 1
            scan_text(path, locator, value)

for path in files:
    try:
        value = (ROOT / path).read_text(encoding="utf-8")
        if path.endswith(".json"):
            stats["jsonFiles"] += 1
            scan_json(path, json.loads(value))
        else:
            stats["markdownFiles"] += 1
            for index, line in enumerate(value.splitlines(), 1):
                scan_text(path, f"line:{index}", line)
    except Exception as error:
        stats["readOrParseErrors"].append({"path": path, "error": str(error)})

output = {
    "base": BASE,
    "scope": "all inventoried docs/bugs Markdown and recursively parsed JSON scalar values, including archives; current batch excluded",
    "statistics": stats,
    "inventorySha256": hashlib.sha256("\n".join(files).encode()).hexdigest(),
    "patterns": patterns,
    "matchCounts": {key: len(value) for key, value in matches.items()},
    "matchingFiles": {key: sorted({row["path"] for row in value}) for key, value in matches.items()},
    "contextsPerPatternCap": context_cap,
    "contexts": contexts,
    "allMatchLocators": matches,
    "limitations": "Patterns are retrieval indexes, not proof of semantic exhaustion. Context caps do not cap counts. Non-string scalar values are counted but cannot match these string patterns.",
}
(BATCH / "evidence/timing-dedup.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"statistics": stats, "matchCounts": output["matchCounts"], "exactLeafFiles": output["matchingFiles"]["exact_leaf"]}, ensure_ascii=False))
