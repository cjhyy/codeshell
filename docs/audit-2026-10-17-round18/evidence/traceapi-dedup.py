import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BATCH = ROOT / "docs/audit-2026-10-17-round18"
patterns = {
    "exact_remote_trace_api": r"createRemoteModelTraceApi|model-trace-api(?:\.ts)?",
    "normal_trace_filter_encoding": r"(?:model[- ]trace|trace api|model history).{0,100}(?:URLSearchParams|cursor|encode|filter|查询|编码)|(?:URLSearchParams|查询|编码).{0,100}(?:model[- ]trace|model history)",
    "trace_page_passthrough": r"(?:model[- ]trace|model history).{0,100}(?:nextCursor|passthrough|透传|分页)",
}
compiled = {key: re.compile(value, re.I) for key, value in patterns.items()}
inventory = subprocess.check_output(["rg", "--files", "docs", "bugs", "-g", "*.md", "-g", "*.json"], cwd=ROOT, text=True).splitlines()
files = [path for path in sorted(inventory) if not (ROOT / path).is_relative_to(BATCH)]
stats = {"files": len(files), "markdownFiles": 0, "jsonFiles": 0, "jsonStringLeaves": 0, "jsonScalarLeaves": 0, "readOrParseErrors": []}
matches = {key: [] for key in patterns}
contexts = {key: [] for key in patterns}
context_cap = 20

def scan_text(path, locator, value):
    for key, regex in compiled.items():
        for found in regex.finditer(value):
            matches[key].append({"path": path, "locator": locator, "offset": found.start()})
            if len(contexts[key]) < context_cap:
                contexts[key].append({"path": path, "locator": locator, "context": value[max(0, found.start()-100):found.end()+180]})

def scan_json(path, value, locator="$ "):
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
    "base": "65691923fa629970ac26dc04e35362a9c4ab57a8",
    "scope": "all inventoried docs/bugs Markdown and recursively parsed JSON leaves, including archives; current batch excluded",
    "statistics": stats,
    "inventorySha256": hashlib.sha256("\n".join(files).encode()).hexdigest(),
    "patterns": patterns,
    "matchCounts": {key: len(value) for key, value in matches.items()},
    "matchingFiles": {key: sorted({row["path"] for row in value}) for key, value in matches.items()},
    "contextsPerPatternCap": context_cap,
    "contexts": contexts,
    "limitations": "Pattern hits are an index, not proof of exhaustive semantic deduplication; context caps do not cap counts.",
}
(BATCH / "evidence/traceapi-dedup.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"statistics": stats, "matchCounts": output["matchCounts"]}, ensure_ascii=False))
