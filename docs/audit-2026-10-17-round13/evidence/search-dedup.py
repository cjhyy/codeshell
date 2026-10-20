"""Read all historical Markdown and parsed JSON leaves; no product execution."""
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[3]
BASE = "7927a7c8b80b4aec710dee1f6d831ad1982bb466"
PATTERNS = {
    "target_helpers": r"sessionContentSearch|parseContentQuery|resolveContentMatch|searchFocus|resolveSearchOpener|rememberSearchDialogOpener|groupModelOptions|modelPickerPresentation|persistDefaultTextModel|modelSelection[.]ts",
    "identity_fallback": r"(?:engineSessionId|engine.session.id).{0,120}(?:fallback|回退|local.id|本地.{0,4}id)|(?:fallback|回退).{0,120}(?:engineSessionId|engine.session.id)",
    "content_search": r"(?:content.search|内容搜索|全文搜索).{0,120}(?:prefix|前缀|trim|空白|archiv|归档|resolve|映射|identity|身份)|(?:prefix|前缀|trim|空白|archiv|归档|resolve|映射).{0,120}(?:content.search|内容搜索|全文搜索)",
    "picker_focus": r"(?:model.picker|模型选择|search.dialog|搜索.{0,3}弹窗).{0,120}(?:group|分组|focus|焦点|provider|default|默认)",
}
compiled = {k: re.compile(v, re.I) for k, v in PATTERNS.items()}
hits = {k: [] for k in PATTERNS}
counts = {k: 0 for k in PATTERNS}
inventory = []
errors = []
scan = {"markdownFiles": 0, "jsonFiles": 0, "jsonStringLeaves": 0}

def leaves(value, loc="$"):
    if isinstance(value, str):
        yield loc, value
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from leaves(item, f"{loc}[{i}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from leaves(item, f"{loc}.{key}")

for directory in (ROOT / "docs", ROOT / "bugs"):
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix not in (".md", ".json"):
            continue
        relative = path.relative_to(ROOT).as_posix()
        if relative.startswith("docs/audit-2026-10-17-round13/"):
            continue
        try:
            raw = path.read_bytes()
            inventory.append({"path": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
            content = raw.decode("utf-8")
            if path.suffix == ".json":
                scan["jsonFiles"] += 1
                units = list(leaves(json.loads(content)))
                scan["jsonStringLeaves"] += len(units)
            else:
                scan["markdownFiles"] += 1
                units = [("$", content)]
            for location, text in units:
                for key, pattern in compiled.items():
                    for match in pattern.finditer(text):
                        counts[key] += 1
                        if len(hits[key]) < 120:
                            hits[key].append({"file": relative, "location": location, "snippet": text[max(0, match.start()-100):match.end()+240]})
        except Exception as error:
            errors.append({"file": relative, "error": str(error)})
out = {"frozenSource": BASE, "scope": "Every Markdown file and parsed JSON string leaf in docs/bugs including archive/_archive; current round13 excluded", "patterns": PATTERNS, "scanned": scan, "inventory": inventory, "parseErrors": errors, "matchCounts": counts, "maxContextsPerPattern": 120, "hits": hits}
output = pathlib.Path(__file__).with_suffix(".json")
output.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"output": output.relative_to(ROOT).as_posix(), "scanned": scan, "parseErrors": errors, "matchCounts": counts}))
