from pathlib import Path
import hashlib,json,re,subprocess

base="c1d007ed0af1eca9b56b32fabbb0ea2401037ee1"
root=Path.cwd()
batch=root/"docs/audit-2026-10-17-round23"
e=batch/"evidence"
manifest=json.loads((e/"cron-source-manifest.json").read_text())
sourcechecks=[]
for item in manifest["files"]:
    name=item["path"]
    raw=(root/name).read_bytes()
    frozen=subprocess.check_output(["git","show",f"{base}:{name}"])
    sha=hashlib.sha256(raw).hexdigest()
    assert sha==item["sha256"]==item["frozenSha256"]
    assert raw==frozen
    sourcechecks.append({"path":name,"sha256":sha,"matchesFrozen":True})

report=batch/"cron-report.md"
# Self is excluded from hashes; establish its path before self-link navigation.
receiptpath=e/"cron-artifact-receipt.json"
if not receiptpath.exists():
    receiptpath.write_text(json.dumps({"base":base,"preparing":True})+"\n")
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
raw=e/"cron-first.raw.log"
exitdata=json.loads((e/"cron-first.exit.json").read_text())
assert hashlib.sha256(raw.read_bytes()).hexdigest()==exitdata["rawSha256"]
assert raw.stat().st_size==exitdata["rawBytes"]
assert exitdata["exitCode"]==0
assert "Completed Bun shard: 7 tests, 0 skipped; 0 failures." in raw.read_text()
metadata={"base":base,"sourceChecks":sourcechecks,"reportLinks":links,"rawHashMatchesExit":True,"jsonParseErrors":[],"productReruns":0}
for p in sorted(e.glob("cron-*.json")):
    if p.name=="cron-artifact-receipt.json":continue
    json.loads(p.read_text())
(e/"cron-metadata-check.json").write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+"\n")
paths=sorted([report,*e.glob("cron-*")])
paths=[p for p in paths if p.is_file() and p.name!="cron-artifact-receipt.json"]
files=[{"path":str(p.relative_to(root)),"bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths]
receipt={"base":base,"report":str(report.relative_to(root)),"formalCount":0,"candidateCount":0,"relatedCount":0,"files":files,"productChanges":False,"gitWrites":False,"receiptExcludesItself":True,"rawLogs":[str(raw.relative_to(root))],"sourceChecks":len(sourcechecks),"guardedRuns":1,"productReruns":0}
(e/"cron-artifact-receipt.json").write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"artifacts":len(files),"sourceChecks":len(sourcechecks),"reportLinks":len(links),"guardedRuns":1,"productReruns":0}))
