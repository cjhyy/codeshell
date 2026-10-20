"""Metadata-only prior MD/JSON-value inventory; never imports product code."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round26/evidence/service-dedup.json"
EXCLUDED = "docs/audit-2026-10-17-round26/"
PATTERNS = {
    "exact": r"review-service(?:\.test)?\.ts|desktop-services\.review-diff\.test\.ts|ReviewService|ReviewAiPromptRequest|getGitDiffForReview|prepareReviewPrompt",
    "scope": r"(?:review|审查).{0,130}(?:multi.repo|multiple.repo|多仓|rootId|selected.commit|partial|snapshot|unborn|merge.base|binary|truncat|范围|超限|部分失败)|(?:snapshot|merge.base|多仓|partial).{0,100}(?:review|审查)",
    "mechanism": r"(?:review|审查).{0,130}(?:silently|missing|drop|empty|wrong|丢失|漏|错误|不完整|截断)|(?:scope|repository).{0,80}(?:error|fail).{0,80}(?:review|审查)",
}
CAP = 100
regexes = {key: re.compile(value, re.I) for key, value in PATTERNS.items()}
counts = {key: 0 for key in PATTERNS}
contexts = {key: [] for key in PATTERNS}
inventory = []
errors = []
strings = 0
scalars = 0
markdown = 0
json_files = 0


def values(value, location="$ "):
    global strings, scalars
    if isinstance(value, dict):
        for key, child in value.items():
            yield from values(child, location.rstrip() + "[" + json.dumps(key, ensure_ascii=False) + "]")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from values(child, location.rstrip() + "[" + str(index) + "]")
    else:
        scalars += 1
        if isinstance(value, str):
            strings += 1
        yield location.rstrip(), value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


files = sorted(
    path
    for root in [ROOT / "docs", ROOT / "bugs"]
    for path in root.rglob("*")
    if path.is_file()
    and path.suffix.lower() in [".md", ".json"]
    and not path.relative_to(ROOT).as_posix().startswith(EXCLUDED)
)
for path in files:
    raw = path.read_bytes()
    relative = path.relative_to(ROOT).as_posix()
    inventory.append({"path": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    if path.suffix.lower() == ".md":
        markdown += 1
        selected = ((str(index), line) for index, line in enumerate(raw.decode("utf-8").splitlines(), 1))
    else:
        json_files += 1
        try:
            selected = values(json.loads(raw))
        except Exception as error:
            errors.append({"path": relative, "error": str(error)})
            continue
    for location, text in selected:
        for key, regex in regexes.items():
            if regex.search(text):
                counts[key] += 1
                if len(contexts[key]) < CAP:
                    contexts[key].append({"path": relative, "location": location, "excerpt": text[:900], "valueCharacters": len(text)})

result = {
    "baseline": "6d61f57ade1ef1b9fdc4d33020652007d995e7a7",
    "roots": ["docs", "bugs"],
    "excluded": EXCLUDED,
    "archivesIncluded": True,
    "inventory": inventory,
    "totals": {"files": len(files), "markdown": markdown, "json": json_files, "stringLeaves": strings, "scalarLeaves": scalars, "parseErrors": len(errors)},
    "parseErrors": errors,
    "patterns": PATTERNS,
    "matchCounts": counts,
    "contextCapEach": CAP,
    "contexts": contexts,
    "limitations": ["JSON scalar values searched, not object keys; Markdown searched per line.", "Each saved excerpt at most900characters; total matches and context caps differ.", "Inventory/hash and regex navigation are not full semantic reading or proof of novelty.", "All product/import/test/fixture/VM/native/Git/network attempts zero."],
}
OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"totals": result["totals"], "matchCounts": counts, "savedContexts": {key: len(rows) for key, rows in contexts.items()}, "productAttempts": 0}))
