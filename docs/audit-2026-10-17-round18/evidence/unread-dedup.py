from pathlib import Path
import subprocess, json, re, hashlib

ROOT = Path.cwd()
BATCH = "docs/audit-2026-10-17-round18/"
BASE = "65691923fa629970ac26dc04e35362a9c4ab57a8"
patterns = {
    "helper_names": r"markSessionUnread|clearUnreadSession|pruneUnreadSessions",
    "unread_state": r"unreadSessionIds|(?:未读|unread).{0,100}(?:session|会话|list|列表|clear|清)",
    "list_active_clear": r"(?:session\.list\.ok|activeSessionId).{0,160}(?:unread|未读|clearUnreadSession|清除)",
    "selection_revision": r"conversationRevisionRef.{0,120}(?:unread|未读)|(?:unread|未读).{0,120}(?:boundSessionRef|activeSessionId|selectedSessionId)",
}
compiled = {k: re.compile(v, re.I) for k, v in patterns.items()}
files = sorted(p for p in subprocess.check_output(["rg", "--files", "--hidden", "docs", "bugs"], text=True).splitlines() if not p.startswith(BATCH) and Path(p).suffix.lower() in (".md", ".json"))
counts = {"md": 0, "json": 0, "stringLeaves": 0, "scalarLeaves": 0}
hits = {k: {"matches": 0, "contexts": []} for k in patterns}
errors = []
inventory = []
def inspect(value, location):
    for key, rx in compiled.items():
        for match in rx.finditer(value):
            hits[key]["matches"] += 1
            if len(hits[key]["contexts"]) < 40:
                hits[key]["contexts"].append({"location": location, "context": value[max(0, match.start()-140):min(len(value), match.end()+200)]})
def walk(value, location):
    if isinstance(value, str):
        counts["stringLeaves"] += 1
        counts["scalarLeaves"] += 1
        inspect(value, location)
    elif isinstance(value, dict):
        for key, child in value.items(): walk(child, location+"/"+str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value): walk(child, location+"/"+str(index))
    else: counts["scalarLeaves"] += 1
for path in files:
    raw = (ROOT/path).read_bytes()
    inventory.append({"path": path, "sha256": hashlib.sha256(raw).hexdigest()})
    try:
        if path.endswith(".md"):
            counts["md"] += 1
            for line, text in enumerate(raw.decode().splitlines(), 1): inspect(text, path+":"+str(line))
        else:
            counts["json"] += 1
            walk(json.loads(raw), path+"#")
    except Exception as error:
        errors.append({"path": path, "error": repr(error)})
result = {"baseCommit": BASE, "scope": "All prior docs/bugs MD and recursively parsed JSON value leaves, including archive/_archive; this batch excluded. JSON keys are not string leaves. Keyword contexts are bounded and are not exhaustive semantic proof.", "files": len(files), "counts": counts, "parseErrors": errors, "patterns": patterns, "contextCapPerPattern": 40, "matches": hits, "inventorySha256": hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()}
(ROOT/BATCH/"evidence/unread-dedup.json").write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n")
print(json.dumps({"files": len(files), "counts": counts, "parseErrors": errors, "matches": {k: v["matches"] for k, v in hits.items()}}, ensure_ascii=False))
