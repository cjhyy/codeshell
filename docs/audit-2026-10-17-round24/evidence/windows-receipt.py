from pathlib import Path
import hashlib,json,re,subprocess

root=Path.cwd()
batch=root/"docs/audit-2026-10-17-round24"
e=batch/"evidence"
baseline="c9056c8047a8e75ab2469e59bf1d3fedd9ad7272"
manifest=json.loads((e/"windows-source-manifest.json").read_text())
sourcechecks=[]
for item in manifest["sources"]:
    raw=(root/item["path"]).read_bytes()
    frozen=subprocess.check_output(["git","show",baseline+":"+item["path"]])
    sha=hashlib.sha256(raw).hexdigest()
    lines=len(raw.decode().splitlines())
    assert raw==frozen and sha==item["frozenSha256"]==item["currentSha256"]
    assert lines==item["lineCount"] and len(raw)==item["bytes"]
    assert all(1<=a<=z<=lines for a,z in item["ranges"])
    sourcechecks.append({"path":item["path"],"sha256":sha,"currentMatchesFrozen":True})

receiptpath=e/"windows-author-receipt.json"
# Receipt excludes itself from hashes; establish its path before self-link checks.
if not receiptpath.exists():
    receiptpath.write_text(json.dumps({"baseline":baseline,"preparing":True})+"\n")
report=batch/"windows-report.md"
links=[]
for match in re.finditer(r"\[[^\]]*\]\(([^)]+)\)",report.read_text()):
    dest=match.group(1)
    if re.match(r"[a-z]+://",dest):continue
    filepath,_,anchor=dest.partition("#")
    target=(report.parent/filepath).resolve()
    assert target.is_file(),dest
    row={"reference":dest,"path":str(target.relative_to(root)),"exists":True}
    if anchor.startswith("L"):
        lineno=int(anchor[1:])
        assert 1<=lineno<=len(target.read_text().splitlines()),dest
        row["lineInBounds"]=True
    links.append(row)
for p in sorted(e.glob("windows-*.json")):
    if p==receiptpath:continue
    json.loads(p.read_text())
metadata={"baseline":baseline,"sourceChecks":sourcechecks,"reportLinks":links,"jsonParseErrors":[],"productAttempts":0,"testAttempts":0,"productReruns":0}
(e/"windows-metadata-check.json").write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+"\n")
paths=sorted([report,*e.glob("windows-*")])
paths=[p for p in paths if p.is_file() and p!=receiptpath]
files=[{"path":str(p.relative_to(root)),"bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths]
receipt={"baseline":baseline,"report":str(report.relative_to(root)),"formalCount":0,"candidateCount":0,"relatedCount":0,"artifacts":files,"sourceChecks":len(sourcechecks),"markdownLinks":len(links),"productAttempts":0,"testAttempts":0,"productReruns":0,"productChanges":False,"gitWrites":False,"receiptExcludesItself":True,"rawLogs":[],"guardedRuns":0,"scope":"Deepstaticonly; no targetmodule/test/PowerShell/installer/process/native execution. Hashes donotattestsemanticcoverage or actualWindowsacceptance."}
receiptpath.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"artifacts":len(files),"sourceChecks":len(sourcechecks),"reportLinks":len(links),"productAttempts":0,"testAttempts":0,"productReruns":0}))
