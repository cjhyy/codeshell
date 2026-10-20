from pathlib import Path
import hashlib,json,subprocess,time
base="9b667863e8a8eb91db7b1f99eb9876169dcf19ec"
e=Path("docs/audit-2026-10-17-round27/evidence")
plan=json.loads((e/"root-run-plan.json").read_text())
raw=e/"root-containment-first.raw.log";exitfile=e/"root-containment-first.exit.json"
assert not raw.exists() and not exitfile.exists(),"First evidence cannot be overwritten"
assert hashlib.sha256((e/"root-containment.test.ts").read_bytes()).hexdigest()==plan["fixtureSha256"]
started=time.monotonic()
with raw.open("wb") as output:
 proc=subprocess.run(plan["argv"],stdout=output,stderr=subprocess.STDOUT)
result=dict(baseline=base,argv=plan["argv"],attempt=1,exitCode=proc.returncode,elapsedSeconds=round(time.monotonic()-started,3),raw=str(raw),rawBytes=raw.stat().st_size,rawSha256=hashlib.sha256(raw.read_bytes()).hexdigest(),combinedStdoutStderr=True,rawAndExitSavedBeforeInspection=True,productReruns=0)
exitfile.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
print(json.dumps(dict(exitCode=proc.returncode,rawSaved=str(raw),exitSaved=str(exitfile))))
