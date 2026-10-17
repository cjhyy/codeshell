"""Search bounded contexts in historical Markdown and parsed JSON; no test execution."""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = pathlib.Path(__file__).with_suffix(".json")
PATTERNS = {
    "target_paths": r"tool-cards/attachments\.ts|detectAttachments|AttachmentCard|input-attachments\.ts|attachmentSession|buildPathAttachment",
    "space_path": r"(?:attachment|artifact|附件).{0,100}(?:spaces?|空格|backslash|Windows)|(?:spaces?|空格|backslash|Windows).{0,100}(?:attachment|artifact|附件)",
    "tokenizer": r"PATH_TOKEN_RE|path.{0,30}(?:tokeni[sz]|split|截断)|(?:路径|文件名).{0,30}(?:拆分|截断|正则)",
    "directory_depth": r"directoryTree|MAX_DIRECTORY_TREE_DEPTH|(?:目录树|directory tree).{0,70}(?:depth|深度|truncated|截断)",
}
compiled = {k: re.compile(v, re.I) for k, v in PATTERNS.items()}
hits = {k: [] for k in PATTERNS}
counts = {k: 0 for k in PATTERNS}
scan = {"markdownFiles": 0, "jsonFiles": 0, "jsonStringLeaves": 0}
errors = []


def leaves(value, location="$"):
    if isinstance(value, str):
        yield location, value
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from leaves(item, f"{location}[{index}]")
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from leaves(item, f"{location}.{key}")


for directory in (ROOT / "docs", ROOT / "bugs"):
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or path.suffix not in (".md", ".json"):
            continue
        relative = path.relative_to(ROOT).as_posix()
        if relative.startswith("docs/audit-2026-10-17-round9/"):
            continue
        try:
            value = path.read_text()
            if path.suffix == ".json":
                scan["jsonFiles"] += 1
                units = list(leaves(json.loads(value)))
                scan["jsonStringLeaves"] += len(units)
            else:
                scan["markdownFiles"] += 1
                units = [("$", value)]
            for location, text in units:
                for name, pattern in compiled.items():
                    for match in pattern.finditer(text):
                        counts[name] += 1
                        if len(hits[name]) < 100:
                            hits[name].append({
                                "file": relative,
                                "location": location,
                                "snippet": text[max(0, match.start() - 100):match.end() + 240],
                            })
        except Exception as error:
            errors.append({"file": relative, "error": str(error)})

OUT.write_text(json.dumps({
    "frozenSource": "248d091202869c07274adedf4fd50403105f1b1f",
    "scope": "All .md and parsed .json under docs/ and bugs/, including archive/ and _archive/; current round excluded.",
    "patterns": PATTERNS,
    "scanned": scan,
    "parseErrors": errors,
    "matchCounts": counts,
    "maxContextsPerPattern": 100,
    "hits": hits,
    "assessment": {
        "newCandidate": "Whitespace segmentation of complete artifact paths was not found as a matching historical finding in the searched contexts. This is a keyword/record search, not semantic proof of exhaustive deduplication.",
        "knownExcluded": [
            "Write undefined/empty result success heuristic: docs/archive/review-2026-05-30/low_confirmed.json and siblings.",
            "Related whitespace category: Core run/ArtifactTracker.ts shell redirection parser in May findings/low_confirmed; independent consumer/input contract, not the renderer detector.",
            "Input staged attachment hash/TOCTOU/session-policy issues: existing July records, excluded scope.",
            "Legacy/modern history attachment presentation: docs/review-2026-10-12 rounds 24/25, excluded duplicate family.",
            "Non-vision image downgrade: July review and current documented intentional downgrade, not promoted.",
        ],
    },
}, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"output": str(OUT.relative_to(ROOT)), "scanned": scan, "parseErrors": errors, "matchCounts": counts}))
