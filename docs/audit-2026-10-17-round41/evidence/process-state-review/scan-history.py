from pathlib import Path
import datetime, hashlib, json, subprocess

ROOT = Path("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell")
OUT = Path("/tmp/codeshell-audit-round43-process-state-review")
SOURCE = "packages/server/src/panels/process-state.ts"
SHA = "9614623cb89fbd49914595b977e9ffae515966680b3a375115c1526b16ca2ca6"
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
sha = lambda b: hashlib.sha256(b).hexdigest()

def dump(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

result = subprocess.run(["rg", "--files", "--hidden", "--no-ignore", "docs", "bugs", "-g", "*.md", "-g", "*.MD", "-g", "*.json"], cwd=ROOT, capture_output=True, text=True, check=True)
allpaths = sorted(set(result.stdout.splitlines()))
prefixes = ("docs/audit-2026-10-17-round40/", "docs/audit-2026-10-17-round41/", "docs/audit-2026-10-17-round42/", "docs/audit-2026-10-17-round43/")
excluded = [p for p in allpaths if p.startswith(prefixes)]
paths = [p for p in allpaths if p not in set(excluded)]
blobs = {p: (ROOT / p).read_bytes() for p in paths}
rows = [{"path": p, "bytes": len(b), "sha256": sha(b), "kind": "json" if p.lower().endswith(".json") else "md"} for p, b in blobs.items()]
(OUT / "history-inventory.raw.txt").write_text(result.stdout)
dump("history-initial-pins.json", {"capturedUTC": now(), "scope": "All selected docs/bugs bytes pinned before this fresh literal-keyword / recursive JSON value scan; not borrowed from a previous round.", "files": rows, "excluded": excluded})
needles = {
    "source_path": [SOURCE],
    "source_filename": ["process-state.ts"],
    "source_sha": [SHA],
    "state_contract": ["panels/process-state", "PanelProcessState"],
}
needles = {k: [v.casefold() for v in values] for k, values in needles.items()}
totals = {k: 0 for k in needles}
hits = {k: [] for k in needles}
cap = 160
scalars = 0
strings = 0
errors = []
same_rows = []

def units(value, ptr="", parent=None):
    global scalars, strings
    if isinstance(value, dict):
        if SOURCE in value.values() and SHA in value.values():
            same_rows.append({"path": CURRENT_PATH, "jsonPointer": ptr, "row": value})
        for key, item in value.items():
            escaped = str(key).replace("~", "~0").replace("/", "~1")
            yield from units(item, ptr + "/" + escaped, value)
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from units(item, ptr + "/" + str(i), value)
    else:
        scalars += 1
        if isinstance(value, str):
            strings += 1
            yield ptr, value, parent

for CURRENT_PATH, blob in blobs.items():
    text = blob.decode("utf8")
    if CURRENT_PATH.lower().endswith(".json"):
        try:
            content = list(units(json.loads(text)))
        except Exception as error:
            errors.append({"path": CURRENT_PATH, "error": repr(error)})
            continue
    else:
        content = [("", text, None)]
    for pointer, value, parent in content:
        folded = value.casefold()
        for key, terms in needles.items():
            for term in terms:
                totals[key] += folded.count(term)
                start = 0
                while len(hits[key]) < cap:
                    found = folded.find(term, start)
                    if found < 0:
                        break
                    end = found + len(term)
                    # The exact ASCII source path/SHA have stable offsets. Other
                    # casefolded non-ASCII text is navigation, not source ranges.
                    context = value[max(0, found-350):min(len(value), end+700)]
                    row = parent if isinstance(parent, dict) and value in (SOURCE, SHA) else None
                    hits[key].append({"path": CURRENT_PATH, "jsonPointer": pointer if CURRENT_PATH.lower().endswith(".json") else None, "line": value.count("\n", 0, found)+1, "needle": term, "context": context, "immediateParentForExactValue": row, "sourceSha256": sha(blob)})
                    start = end
summary = {
    "scannedUTC": now(),
    "scope": "All docs/bugs MD text and recursive JSON scalar values including archives. Exact mutable audit40 / future41/42/43 excluded; frozen39 included if present. Keys are not searched as text.",
    "method": {"literalCasefoldedNeedles": needles, "capPerGroup": cap, "notSemanticExhaustion": True, "samePathShaRows": "Structured immediate-object metadata lookup; no product source execution."},
    "inventory": {"discovered": len(allpaths), "included": len(paths), "excluded": len(excluded), "md": sum(x["kind"]=="md" for x in rows), "json": sum(x["kind"]=="json" for x in rows), "bytes": sum(x["bytes"] for x in rows), "jsonStringValues": strings, "jsonScalarValues": scalars, "jsonParseErrors": errors, "archiveBySubstring": sum("archiv" in p.lower() for p in paths), "includesFrozenRound39": any(p.startswith("docs/audit-2026-10-17-round39/") for p in paths)},
    "hitTotals": totals,
    "retained": {k: len(v) for k, v in hits.items()},
    "files": rows,
    "samePathShaRowsCount": len(same_rows),
    "productAttempts": 0,
    "gitCommands": 0,
}
dump("history.json", summary)
dump("history-contexts.json", {"createdUTC": now(), "hits": hits, "samePathShaRows": same_rows, "scope": "Navigation and stored metadata only. Explicit actual selected semantic ranges will be recorded separately."})
print(json.dumps({"inventory": summary["inventory"], "hitTotals": totals, "retained": summary["retained"], "samePathShaRows": len(same_rows)}, ensure_ascii=False, indent=2))
