"""Assemble preserved audit metadata only; no product/test execution."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round14"
EV = OUT / "evidence"
BASE = "badc2262a90966f6f903977b849adf1f22b55e9f"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((EV / name).read_text())

def save(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

for name in ["utils-findings.json","web-findings.json","bytes-findings.json"]:
    data=read(name)
    assert not (data if isinstance(data,list) else data["findings"])
save("findings.json",dict(baseline=BASE,count=0,priorities={},findings=[],note="No new confirmed bugs; focused failures and incomplete candidate contracts are not formal findings."))
candidates=read("utils-candidates.json")["candidates"]+read("web-candidates.json")+read("bytes-candidates.json")["candidates"]
assert {r["id"] for r in candidates}=={"UTIL-R14-C1","UTIL-R14-C2","WEB-R14-C1","BYTES-R14-C1"}
save("candidates.json",dict(baseline=BASE,count=4,candidates=candidates,note="Three source-only candidates after first import failures; one actual byte rejection lacking independently valid sample/downstream support contract."))
related=read("utils-related.json")["related"]
assert len(related)==1 and related[0]["id"]=="UTIL-R14-R1"
save("related.json",dict(baseline=BASE,count=1,observations=related,note="Core truncator relates to old Desktop mechanism, no new runtime observation; Desktop repair does not prove Core fixed."))
save("addressed-sources.json",dict(baseline=BASE,count=2,sourceChanges=[
 dict(id="DESKTOP-R12-01",source="packages/desktop/src/renderer/tool-cards/utils.ts",changeCommit="9925b3282",disposition="Other-task source repair of surrogate boundary inspected; not retested here",oldFrozenReport="docs/audit-2026-10-17-round12/desktop.md"),
 dict(id="ATT-R9-01",source="packages/desktop/src/renderer/tool-cards/attachments.ts",changeCommit="3d6a1ec35",disposition="Other-task source repair preserves complete generated-image tail inspected; not retested here",oldFrozenReport="docs/audit-2026-10-17-round9/attachments.md"),
],runtimeRetested=False,report="baseline-refresh.md",note="Source-change status separate from new confirmed/candidate/related counts."))

specs=[
 ("root-trace-data.first.log","root-trace-data.first.exit.json",True),
 ("bytes-image-probe.first.log","bytes-image-probe.first.exit.json",True),
 ("web-room-history.first.raw.log","web-room-history.first.exit.json",True),
 ("utils-format-existing.first.raw.log","utils-format-existing.first.exit.json",True),
 ("web-user-display.first.raw.log","web-user-display.first.exit.json",False),
 ("utils-slice-columns.first.raw.log","utils-slice-columns.first.exit.json",False),
]
runs=[]
for log_name,exit_name,expected_clean in specs:
    raw=(EV/log_name).read_bytes();text=raw.decode();receipt=read(exit_name);code=receipt["exitCode"];command=receipt["command"]
    assert command[:4]==["node","scripts/run-bun-test-shard.mjs","--timeout","30000"]
    complete=re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.",text)
    def count(pattern,default=None):
        match=re.search(pattern,text,re.M)
        return int(match.group(1)) if match else default
    row=dict(log="evidence/"+log_name,exitFile="evidence/"+exit_name,command=command,firstRun=True,exitCode=code,completed=bool(complete),
        clean=bool(complete and code==0),passed=count(r"^\s*(\d+) pass\s*$"),failed=count(r"^\s*(\d+) fail\s*$"),
        errors=count(r"^\s*(\d+) error\s*$",0),expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"),
        skipped=int(complete.group(2)) if complete else None,sha256=sha(raw))
    assert row["clean"]==expected_clean,row
    if expected_clean:
        assert row["failed"]==row["skipped"]==row["errors"]==0 and row["passed"]==int(complete.group(1)),row
    else:
        assert code==row["failed"]==row["errors"]==1 and row["passed"]==0 and not complete,row
        row.update(disposition="SKIP entire corresponding focused direction; wrong fixture relative import; no repair/rerun/extraction/alternate validation",focusedTestBodiesExecuted=0)
    runs.append(row)
clean=[r for r in runs if r["clean"]]
totals=dict(firstBunShards=6,completedCleanShards=4,passedTests=sum(r["passed"] for r in clean),expectations=sum(r["expectations"] for r in clean),
    skippedOrFilteredTests=sum(r["skipped"] for r in clean),failedShardsSeparatelyRetained=2,existingBaselineTests=14,newFocusedObservationsAndControls=17,
    failedShardPassedTests=0,failedShardFailures=2,failedShardErrors=2,failedFocusedTestBodiesExecuted=0)
assert totals["passedTests"]==31 and totals["expectations"]==78
save("validation.json",dict(baseline=BASE,totals=totals,runs=runs,unexecutedFixtures=[dict(path="evidence/utils-cache-format-controls.test.ts",attempts=0,disposition="Wrong import retained unchanged, never launched; assertions are plans only")],notes=[
 "Six first raw combined stdout/stderr logs and exits saved before inspection; four completed clean, two focused import failures. No product rerun or alternate validation.",
 "Clean31=14 existing+17focused; failed raw reports separately retain0pass/1fail/1error each; source/test bodies not loaded. Absent expectation/skip summary remains null.",
 "Utils only existing six formatDuration cases dynamically pass; intl is static/dependency scope, not an independently validated baseline. Slice and unused cache fixture not restored.",
 "Web only existing roomHistory baseline dynamically passes; ordinary XML display projection remains static after focused load failure.",
 "Bytes actual probe/sanitizer in-memory maintained samples/subviews and candidate marker sequence only; no independent sample decoder, actual staging/upload or ordinary downstream lossless support contract.",
 "Trace presentation actual pure data helpers and key-echo callback only; components/selection/title hook/preload/backend/source fixes static, no Core/localization runtime.",
 "Old UTF-16 summary and generated-image attachment path branches changed by other tasks before freeze; source changes tracked separately, no old defect/fix runtime retest.",
 "No models/paid APIs/accounts/user data/external messages/network/socket/native apps/PTY/auth/permission/security/custody/watchdog experiments, shared deps/dist rebuild or full build/typecheck/lint/test.",
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
for name in ["utils-artifact-receipt.json","web-artifact-receipt.json","bytes-artifact-receipt.json"]:
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
print(json.dumps(dict(findings=0,candidates=4,related=1,totals=totals,sources=len(manifest),workerArtifacts=len(artifact_checks),evidenceFiles=len(files))))
