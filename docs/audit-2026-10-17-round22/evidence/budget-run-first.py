from pathlib import Path
import hashlib,json,subprocess,time
base="ab258c3f534b19014b2ed85da3111649f166ab86"
e=Path("docs/audit-2026-10-17-round22/evidence")
raw=e/"budget-first.raw.log";exitfile=e/"budget-first.exit.json"
assert not raw.exists() and not exitfile.exists(),"Never overwrite first evidence"
argv=["node","scripts/run-bun-test-shard.mjs","--timeout","30000","packages/core/src/engine/reactive-threshold.test.ts","docs/audit-2026-10-17-round22/evidence/budget-reactive-focused.test.ts"]
start=time.monotonic()
with raw.open("wb") as output:
 proc=subprocess.run(argv,stdout=output,stderr=subprocess.STDOUT)
result={"base":base,"argv":argv,"attempt":1,"exitCode":proc.returncode,"elapsedSeconds":round(time.monotonic()-start,3),"raw":str(raw),"rawBytes":raw.stat().st_size,"rawSha256":hashlib.sha256(raw.read_bytes()).hexdigest(),"combinedStdoutStderr":True,"rawAndExitSavedBeforeInspection":True,"productReruns":0}
exitfile.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"exitCode":proc.returncode,"rawSaved":str(raw),"exitSaved":str(exitfile)},ensure_ascii=False))
