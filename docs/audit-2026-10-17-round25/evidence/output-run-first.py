from pathlib import Path
import hashlib,json,subprocess,time
base="8b9677c78d150abe9681a2f65ab8e55b1288be4b"
e=Path("docs/audit-2026-10-17-round25/evidence")
raw=e/"output-first.raw.log";exitfile=e/"output-first.exit.json"
assert not raw.exists() and not exitfile.exists(),"First evidence cannot be overwritten"
argv=["node","scripts/run-bun-test-shard.mjs","--timeout","30000","packages/core/src/runtime/output-clean.test.ts","docs/audit-2026-10-17-round25/evidence/output-crlf.test.ts"]
started=time.monotonic()
with raw.open("wb") as output:
 proc=subprocess.run(argv,stdout=output,stderr=subprocess.STDOUT)
result={"baseline":base,"argv":argv,"attempt":1,"exitCode":proc.returncode,"elapsedSeconds":round(time.monotonic()-started,3),"raw":str(raw),"rawBytes":raw.stat().st_size,"rawSha256":hashlib.sha256(raw.read_bytes()).hexdigest(),"combinedStdoutStderr":True,"rawAndExitSavedBeforeInspection":True,"productReruns":0}
exitfile.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"exitCode":proc.returncode,"rawSaved":str(raw),"exitSaved":str(exitfile)},ensure_ascii=False))
