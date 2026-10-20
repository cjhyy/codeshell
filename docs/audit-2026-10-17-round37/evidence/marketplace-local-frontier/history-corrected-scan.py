from pathlib import Path
import datetime, hashlib, json, re, subprocess

ROOT = Path("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell")
OUT = Path("/tmp/codeshell-audit-round37-marketplace-local-frontier")
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
sha = lambda b: hashlib.sha256(b).hexdigest()

def dump(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

q = "[" + chr(34) + chr(39) + chr(96) + "]"
patterns = {
    "helper": r"uninstallTarget|getUninstallTarget|resolveUninstallTarget",
    "quoted_marketplace_local": r"marketplace[^\n]{0,120}" + q + "local" + q + "|" + q + "local" + q + r"[^\n]{0,120}marketplace",
    "literal_namespace": r"(?:marketplace|marketplaces)[^\n]{0,180}(?:collision|reserved|literal|namespace|同名|碰撞|保留)|(?:collision|reserved|literal|namespace|同名|碰撞|保留)[^\n]{0,180}(?:marketplace|marketplaces)",
    "old_branch": r"missing.local|truthy.local|marketplace\s*(?:===|!==|:|=)\s*" + q + "local" + q,
    "source_name": r"(?:marketplaceName|marketplace\s+name|marketplace[^\n]*named)[^\n]{0,120}local",
    "unquoted_marketplace_local": r"marketplace(?:Name|_name)?[^\n]{0,120}local|local[^\n]{0,120}marketplace(?:Name|_name)?",
    "name_local_literal": r"(?:name|命名|名称)[^\n]{0,120}" + q + "local" + q,
    "local_collision": r"(?:collision|collid|reserved|同名|碰撞|保留名)[^\n]{0,140}local|local[^\n]{0,140}(?:collision|collid|reserved|同名|碰撞|保留名)",
    "chinese_market_local": r"(?:市场|市集)[^\n]{0,120}local|local[^\n]{0,120}(?:市场|市集)",
}
compiled = {key: re.compile(value, re.I) for key, value in patterns.items()}
result = subprocess.run(["rg", "--files", "--hidden", "--no-ignore", "docs", "bugs", "-g", "*.md", "-g", "*.MD", "-g", "*.json"], cwd=ROOT, capture_output=True, text=True, check=True)
allpaths = sorted(set(result.stdout.splitlines()))
excluded = [p for p in allpaths if re.search(r"^docs/audit-2026-10-17-round(?:35|36|37)(?:/|$)", p)]
paths = [p for p in allpaths if p not in set(excluded)]
blobs = {p: (ROOT / p).read_bytes() for p in paths}
rows = [{"path": p, "bytes": len(b), "sha256": sha(b), "kind": "json" if p.lower().endswith(".json") else "md"} for p, b in blobs.items()]
dump("history-corrected-initial-pins.json", {"capturedUTC": now(), "phase": "Current dated bytes pinned before corrected-regex scanning. Does not replace child initial dated scan.", "files": rows, "excluded": excluded})
totals = {k: 0 for k in patterns}
hits = {k: [] for k in patterns}
scalar = 0
strings = 0
errors = []
cap = 400

def units(value, ptr=""):
    global scalar, strings
    if isinstance(value, dict):
        for key, item in value.items():
            escaped = str(key).replace("~", "~0").replace("/", "~1")
            yield from units(item, ptr + "/" + escaped)
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from units(item, ptr + "/" + str(i))
    else:
        scalar += 1
        if isinstance(value, str):
            strings += 1
            yield ptr, value

for p, blob in blobs.items():
    text = blob.decode("utf8")
    if p.lower().endswith(".json"):
        try:
            content = list(units(json.loads(text)))
        except Exception as error:
            errors.append({"path": p, "error": repr(error)})
            continue
    else:
        content = [("", text)]
    for pointer, value in content:
        for key, rx in compiled.items():
            for match in rx.finditer(value):
                totals[key] += 1
                if len(hits[key]) < cap:
                    a, b = max(0, match.start() - 350), min(len(value), match.end() + 700)
                    hits[key].append({"path": p, "jsonPointer": pointer if p.lower().endswith(".json") else None, "line": value.count("\n", 0, match.start()) + 1, "matched": match.group(), "context": value[a:b], "sourceSha256": sha(blob)})
old = json.loads((OUT / "history-peer/history.json").read_text())
oldrows = {row["path"]: row for row in old["files"]}
newrows = {row["path"]: row for row in rows}
changed = [{"path": p, "initialBytes": oldrows[p]["bytes"], "initialSha256": oldrows[p]["sha256"], "currentBytes": row["bytes"], "currentSha256": row["sha256"]} for p, row in newrows.items() if p in oldrows and row["sha256"] != oldrows[p]["sha256"]]
summary = {"scannedUTC": now(), "scope": "All current dated docs/bugs MD and recursive JSON scalar values including archives; exact audit35/36/37 excluded. Corrected regex supplement; old scan and receipt remain byte-identical.", "method": {"patterns": patterns, "capPerPattern": cap, "mdWholeText": True, "jsonRecursiveValuesOnlyNoKeys": True, "notSemanticExhaustion": True}, "inventory": {"discovered": len(allpaths), "included": len(paths), "excluded": len(excluded), "md": sum(x["kind"] == "md" for x in rows), "json": sum(x["kind"] == "json" for x in rows), "bytes": sum(x["bytes"] for x in rows), "jsonStringValues": strings, "jsonScalarValues": scalar, "jsonParseErrors": errors}, "hitTotals": totals, "retained": {k: len(v) for k, v in hits.items()}, "comparedToChildInitial": {"added": sorted(set(newrows)-set(oldrows)), "removed": sorted(set(oldrows)-set(newrows)), "changed": changed}, "productAttempts": 0, "gitCommands": 0}
dump("history-corrected.json", summary)
dump("history-corrected-contexts.json", {"createdUTC": now(), "hits": hits, "method": "Bounded excerpts for navigation; actual selected reading is recorded separately."})
print(json.dumps({"inventory": summary["inventory"], "totals": totals, "retained": summary["retained"], "datedChanges": summary["comparedToChildInitial"]}, ensure_ascii=False, indent=2))
