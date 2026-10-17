"""Assemble preserved audit metadata only; no product/test execution."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round13"
EV = OUT / "evidence"
BASE = "7927a7c8b80b4aec710dee1f6d831ad1982bb466"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((EV / name).read_text())

def save(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

def rows(data, key):
    return data if isinstance(data, list) else data[key]

findings = []
for row in read("history-findings.json"):
    source, line = row["file"], row["line"]
    blob = subprocess.check_output(["git", "show", BASE+":"+source], cwd=ROOT)
    assert 0 < line <= len(blob.decode().splitlines())
    h = next(n for n, text in enumerate((OUT/"history.md").read_text().splitlines(), 1) if text.startswith("#") and row["id"] in text)
    findings.append(dict(id=row["id"], priority=row["severity"], title=row["title"], source=source, line=line,
        report="history.md", reportLine=h, log="evidence/history-characterization.first.log", details=row,
        status="confirmed-at-frozen-source-baseline", runtimeRetested=False,
        isolation="homedir-only pre-import mock to owned temporary directory; real fs/nextTick, no HOME environment assignment"))
assert len(findings)==2 and all(r["priority"]=="P3" for r in findings)
assert not rows(read("search-findings.json"), "findings") and not rows(read("groups-findings.json"), "findings")
save("findings.json", dict(baseline=BASE,count=2,priorities={"P3":2},findings=findings))
candidates = read("history-candidates.json") + read("search-candidates.json") + read("groups-candidates.json")["candidates"]
assert len(candidates)==4
save("candidates.json", dict(baseline=BASE,count=4,candidates=candidates,
    note="Two actual pure/helper observations with unproven UI contract/reachability; two static patch-summary candidates after focused first-load failure. None counted confirmed."))
related=read("groups-related.json")["relatedObservations"]
assert len(related)==1
save("related.json",dict(baseline=BASE,count=1,observations=related,note="Old rename family association, not a new formal/candidate count."))

specs=[
 ("root-git-text-existing.first.log","root-git-text-existing.first.exit.json",True),
 ("history-characterization.first.log","history-characterization.first.exit.json",True),
 ("search-pure-contracts.first.log","search-pure-contracts.first.exit.txt",True),
 ("groups-existing-baseline.first.raw.log","groups-existing-baseline.first.exit.json",True),
 ("groups-patch-summary.first.raw.log","groups-patch-summary.first.exit.json",False),
]
runs=[]
for log_name,exit_name,expected_clean in specs:
    raw=(EV/log_name).read_bytes(); text=raw.decode()
    ep=EV/exit_name
    receipt=json.loads(ep.read_text()) if ep.suffix==".json" else read("search-pure-contracts.first.receipt.json")
    code=receipt["exitCode"] if ep.suffix==".json" else int(ep.read_text())
    command=receipt["command"]
    assert command[:4]==["node","scripts/run-bun-test-shard.mjs","--timeout","30000"]
    complete=re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.",text)
    def count(pattern,default=None):
        match=re.search(pattern,text,re.M)
        return int(match.group(1)) if match else default
    row=dict(log="evidence/"+log_name,exitFile="evidence/"+exit_name,command=command,firstRun=True,exitCode=code,completed=bool(complete),
        clean=bool(complete and code==0),passed=count(r"^\s*(\d+) pass\s*$"),failed=count(r"^\s*(\d+) fail\s*$"),
        errors=count(r"^\s*(\d+) error\s*$",0),expectations=count(r"^\s*(\d+) expect\(\) calls\s*$",0),
        skipped=int(complete.group(2)) if complete else None,sha256=sha(raw))
    assert row["clean"]==expected_clean,row
    if expected_clean:
        assert row["failed"]==row["skipped"]==row["errors"]==0 and row["passed"]==int(complete.group(1)),row
    else:
        assert code==row["failed"]==row["errors"]==1 and row["passed"]==0 and not complete,row
        row.update(disposition="SKIP entire focused patch-summary direction; wrong fixture relative import; no repair/rerun/alternate validation",plannedFocusedTests=7,focusedTestBodiesExecuted=0)
    runs.append(row)
clean=[r for r in runs if r["clean"]]
totals=dict(firstBunShards=5,completedCleanShards=4,passedTests=sum(r["passed"] for r in clean),expectations=sum(r["expectations"] for r in clean),
    skippedOrFilteredTests=sum(r["skipped"] for r in clean),failedShardsSeparatelyRetained=1,existingBaselineTests=54,newFocusedObservationsAndControls=12,
    failedShardPassedTests=0,failedShardFailures=1,failedShardErrors=1,failedFocusedTestBodiesExecuted=0)
assert totals["passedTests"]==66 and totals["expectations"]==146
save("validation.json",dict(baseline=BASE,totals=totals,runs=runs,notes=[
 "Five first raw combined stdout/stderr logs and exits preserved before inspection. Four completed clean; one focused fixture load failed. No product rerun or alternate validation.",
 "Clean 66 = 54 existing + 12 focused; shared history log counted once for two findings and candidate. Failed planned seven bodies never loaded and are not counted passed or skipped clean tests.",
 "History uses actual helpers/fs/nextTick under pre-import homedir-only mock; no environment HOME/home/CODEX_HOME assignment or operator history access. React/Ink/UI lifecycle and Esc consumption source-only.",
 "Same-tick flush candidate lacks ordinary TUI reachability; explicit flush recovers. Cross-start disk undo not executed or claimed.",
 "Search actual pure parser and owned memory settings callbacks only; Main/IPC/UI/debounce not executed. modelPicker DD6-04 old failure remains skipped.",
 "Groups baseline validates existing functions only; both new patch-summary candidates and Move remain static after focused load failure. No real ApplyPatch, UI or Git producer.",
 "Root Git parser/slug existing pure tests only; old A03/A04 excluded. Additional transcript review source-only and test-source truncation disclosed; old i18n route not restored.",
 "No models/paid APIs/accounts/user data/external messages/native apps/PTY/auth/permission/security/custody/watchdog experiments, shared deps/dist build or full build/typecheck/lint/test.",
]))

sources={"CODESHELL.md","AGENTS.md","package.json","bun.lock","tsconfig.json"}; worker_source_checks=[]
for path in OUT.glob("*.md"):
    sources.update(re.findall(r"\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b",path.read_text()))
for path in EV.glob("*source-manifest.json"):
    data=json.loads(path.read_text())
    for row in data.get("files",data.get("sources",[])):
        name=row["path"];sources.add(name);blob=subprocess.check_output(["git","show",BASE+":"+name],cwd=ROOT)
        expected=row.get("sha256",row.get("frozenSha256",row.get("frozenSha")))
        assert expected==sha(blob),(path.name,name)
        worker_source_checks.append(dict(manifest=path.name,path=name,sha256=expected))
manifest=[];unresolved=[]
for name in sorted(sources):
    result=subprocess.run(["git","show",BASE+":"+name],cwd=ROOT,capture_output=True); path=ROOT/name
    if result.returncode or not path.is_file():unresolved.append(name);continue
    manifest.append(dict(path=name,bytes=len(result.stdout),sha256=sha(result.stdout),frozenBlobVerified=True,currentWorkingTreeMatchesFrozenBlob=path.read_bytes()==result.stdout))
assert not unresolved,unresolved
save("source-manifest.json",dict(baseline=BASE,assemblyWorkingTreeHead=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT).decode().strip(),
    files=manifest,workerSourceChecks=worker_source_checks,unresolvedReferences=unresolved,note="Selected source pins and current equality; not full-file/transitive/full repository review coverage."))
artifact_checks=[]
for name in ["history-artifact-receipt.json","search-artifact-receipt.json","groups-artifact-receipt.json"]:
    data=read(name)
    for row in data.get("files",data.get("artifacts",[])):
        path=ROOT/row["path"] if row["path"].startswith("docs/") else OUT/row["path"];raw=path.read_bytes()
        assert len(raw)==row["bytes"] and sha(raw)==row["sha256"],(name,row["path"])
        artifact_checks.append(dict(receipt=name,path=str(path.relative_to(ROOT)),sha256=sha(raw)))
save("worker-integrity.json",dict(baseline=BASE,artifactChecks=artifact_checks,sourceCheckCount=len(worker_source_checks),productTestsRerun=False))
files=[]
for path in sorted(OUT.rglob("*")):
    if path.is_file() and path.name!="evidence-index.json":
        raw=path.read_bytes();files.append(dict(path=str(path.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
save("evidence-index.json",dict(baseline=BASE,algorithm="sha256",files=files,note="Self excluded; raw logs retained verbatim, tool transcriptions labeled. Assembler executes no product/test code."))
print(json.dumps(dict(findings=2,candidates=4,related=1,totals=totals,sources=len(manifest),workerArtifacts=len(artifact_checks),evidenceFiles=len(files))))
