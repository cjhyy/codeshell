from pathlib import Path
import subprocess,json,hashlib,sys,datetime
root=Path(__file__).resolve().parents[3]
evidence=Path(__file__).resolve().parent
name=sys.argv[1];paths=sys.argv[2:]
log=evidence/(name+".first.raw.log"); receipt=evidence/(name+".first.exit.json")
if log.exists() or receipt.exists():raise RuntimeError("first evidence already exists; refusing rerun")
cmd=["node","scripts/run-bun-test-shard.mjs","--timeout","30000",*paths]
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
with log.open("wb") as f: result=subprocess.run(cmd,cwd=root,stdout=f,stderr=subprocess.STDOUT)
b=log.read_bytes()
r={"command":cmd,"cwd":str(root),"startedAt":started,"exitCode":result.returncode,"rawLog":str(log.relative_to(root)),"rawBytes":len(b),"rawSha256":hashlib.sha256(b).hexdigest(),"firstOnly":True,"reruns":0}
receipt.write_text(json.dumps(r,indent=2)+"\n")
print(json.dumps(r))
