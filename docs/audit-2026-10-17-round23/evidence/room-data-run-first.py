from pathlib import Path
import subprocess,json,hashlib,time
OUT=Path(__file__).resolve().parent;BASE=OUT.parents[2];raw=OUT/"room-data-first.raw.log";exitfile=OUT/"room-data-first.exit.json"
assert not raw.exists() and not exitfile.exists(),"First evidence must never be overwritten"
argv=["node","scripts/run-bun-test-shard.mjs","--timeout","30000","docs/audit-2026-10-17-round23/evidence/room-data-mobile-history.test.ts"];started=time.monotonic()
with raw.open("xb") as output:p=subprocess.run(argv,cwd=BASE,stdout=output,stderr=subprocess.STDOUT)
r={"frozenHead":"c1d007ed0af1eca9b56b32fabbb0ea2401037ee1","argv":argv,"cwd":str(BASE),"attempt":1,"exitCode":p.returncode,"elapsedSeconds":round(time.monotonic()-started,3),"raw":"evidence/room-data-first.raw.log","rawBytes":raw.stat().st_size,"rawSha256":hashlib.sha256(raw.read_bytes()).hexdigest(),"combinedStdoutStderr":True,"rawAndExitSavedBeforeInspection":True,"productReruns":0}
with exitfile.open("x") as receipt:receipt.write(json.dumps(r,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"exitCode":p.returncode,"rawSaved":str(raw),"exitSaved":str(exitfile)}))
