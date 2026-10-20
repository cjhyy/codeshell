import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BATCH = ROOT / "docs/audit-2026-10-17-round19"
patterns = {
    "exact_simple_diff": r"renderDiffPreview|diffLines|simple-diff(?:\.ts)?",
    "known_lcs_cost": r"(?:simple[- ]diff|renderDiffPreview|LCS).{0,120}(?:O\(n|quadratic|平方|成本|内存)",
    "preview_newline_blank": r"(?:undo|预览|preview|simple[- ]diff).{0,120}(?:trailing|空文件|末尾换行|空行|newline|blank)|(?:trailing|空文件|末尾换行|空行|newline|blank).{0,120}(?:undo|预览|preview|simple[- ]diff)",
    "preview_markdown_fence": r"(?:undo|diff|预览|preview).{0,120}(?:fenc|backtick|代码围栏|代码块|反引号)|(?:fenc|backtick|代码围栏|反引号).{0,120}(?:undo|diff|预览|preview)",
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
    "base": "5f5cf69df8526470700712a4dc2d5ae6bd2da132",
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
(BATCH / "evidence/simplediff-dedup.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"statistics": stats, "matchCounts": output["matchCounts"]}, ensure_ascii=False))
