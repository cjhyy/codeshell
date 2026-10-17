import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BATCH = ROOT / "docs/audit-2026-10-17-round20"
PATTERNS = {
    "exact_leaf": r"StreamAttempt|stream-attempt(?:\.ts)?",
    "stream_revoke": r"(?:tombstone|revoke|撤销).{0,120}(?:stream|retry|partial|请求|流式)|(?:stream|retry|partial|请求|流式).{0,120}(?:tombstone|revoke|撤销)",
    "history_projection": r"(?:stream_request_start|assistant_text|tool_start|tool_running|previousIds).{0,120}(?:retry|revoke|tombstone|baseline|历史|投影|重试)|(?:retry|revoke|tombstone|baseline|历史|投影|重试).{0,120}(?:stream_request_start|assistant_text|tool_start|tool_running|previousIds)",
    "request_accounting": r"(?:fallback|retry|重试).{0,120}(?:usage|account|cost|计费|token)|(?:usage|account|cost|计费|token).{0,120}(?:fallback|retry|重试)",
}
regexes = {key: re.compile(value, re.I) for key, value in PATTERNS.items()}
inventory = subprocess.check_output(["rg", "--files", "docs", "bugs", "-g", "*.md", "-g", "*.json"], cwd=ROOT, text=True).splitlines()
paths = [p for p in sorted(inventory) if not (ROOT / p).is_relative_to(BATCH)]
stats = {"files": len(paths), "markdownFiles": 0, "jsonFiles": 0, "jsonStringLeaves": 0, "jsonScalarLeaves": 0, "readOrParseErrors": []}
counts = {key: 0 for key in PATTERNS}
contexts = {key: [] for key in PATTERNS}
matching = {key: set() for key in PATTERNS}

def text(path, locator, value):
    for key, regex in regexes.items():
        for found in regex.finditer(value):
            counts[key] += 1
            matching[key].add(path)
            if len(contexts[key]) < 24:
                contexts[key].append({"path": path, "locator": locator, "context": value[max(0, found.start()-90):found.end()+180]})

def descend(path, value, locator="$"):
    if isinstance(value, dict):
        for key, child in value.items():
            descend(path, child, locator + "[" + json.dumps(key, ensure_ascii=False) + "]")
    elif isinstance(value, list):
        for i, child in enumerate(value):
            descend(path, child, f"{locator}[{i}]")
    else:
        stats["jsonScalarLeaves"] += 1
        if isinstance(value, str):
            stats["jsonStringLeaves"] += 1
            text(path, locator, value)

file_hashes = []
for path in paths:
    try:
        blob = (ROOT / path).read_bytes()
        file_hashes.append({"path": path, "sha256": hashlib.sha256(blob).hexdigest(), "bytes": len(blob)})
        value = blob.decode("utf-8")
        if path.endswith(".json"):
            stats["jsonFiles"] += 1
            descend(path, json.loads(value))
        else:
            stats["markdownFiles"] += 1
            for i, line in enumerate(value.splitlines(), 1):
                text(path, f"line:{i}", line)
    except Exception as error:
        stats["readOrParseErrors"].append({"path": path, "error": str(error)})
output = {"base": "d40dd06987a2e0c20c377e243cf5c4e4b549c9ec", "scope": "All inventoried docs/bugs Markdown plus recursively parsed JSON scalar values, including archive folders; round20 excluded", "statistics": stats, "inventorySha256": hashlib.sha256("\n".join(paths).encode()).hexdigest(), "inventory": file_hashes, "patterns": PATTERNS, "matchCounts": counts, "matchingFiles": {k: sorted(v) for k,v in matching.items()}, "contextsPerPatternCap": 24, "contexts": contexts, "limitations": "Pattern matches index possible overlaps; capped contexts do not cap counts and are not semantic exhaustion. Scalar counts include all null/boolean/number/string JSON leaves; only strings are searched."}
(BATCH / "evidence/streamattempt-dedup.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"statistics": stats, "matchCounts": counts}, ensure_ascii=False))
