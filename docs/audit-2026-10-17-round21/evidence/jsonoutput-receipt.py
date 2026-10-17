from pathlib import Path
import hashlib,json,re,subprocess
root=Path.cwd();batch=root/"docs/audit-2026-10-17-round21";out=batch/"evidence";base="615e4e4dd3a61b1ad132ab4f3683985a0d582386"
sha=lambda b:hashlib.sha256(b).hexdigest()
manifest=json.loads((out/"jsonoutput-source-manifest.json").read_text())
for item in manifest["files"]:
 data=(root/item["path"]).read_bytes();frozen=subprocess.run(["git","show",base+":"+item["path"]],capture_output=True,check=True).stdout
 assert sha(data)==item["currentSha256"] and sha(frozen)==item["frozenSha256"] and data==frozen
 for selected in item["ranges"]:
  if re.match(r"^\d+-\d+",selected):assert int(re.match(r"^\d+-(\d+)",selected)[1])<=item["lineCount"]
pre=json.loads((out/"jsonoutput-preflight.json").read_text());assert sha((out/"jsonoutput-focused.test.ts").read_bytes())==pre["fixtureSha256"]
ex=json.loads((out/"jsonoutput-first.exit.json").read_text());raw=(out/"jsonoutput-first.raw.log").read_bytes();assert sha(raw)==ex["rawSha256"] and len(raw)==ex["rawBytes"] and ex["exitCode"]==0
assert b"16 pass" in raw and b"52 expect() calls" in raw and b"Completed Bun shard: 16 tests, 0 skipped; 0 failures." in raw
links=[]
for match in re.finditer(r"\[[^\]]+\]\(([^)]+)\)",(batch/"json-output.md").read_text()):
 target=match[1];pathpart,sep,line=target.partition("#L");dest=(batch/pathpart).resolve();assert dest.is_file(),target
 if sep:assert 1<=int(line)<=len(dest.read_bytes().splitlines()),target
 links.append(target)
files=[]
for p in sorted([batch/"json-output.md",*out.glob("jsonoutput-*")]):
 if p.name=="jsonoutput-artifact-receipt.json":continue
 data=p.read_bytes();files.append({"path":p.relative_to(root).as_posix(),"sha256":sha(data),"bytes":len(data)})
receipt={"base":base,"report":"docs/audit-2026-10-17-round21/json-output.md","formalCount":0,"candidateCount":0,"relatedCount":0,"files":files,"selfExcluded":True,"rawLogsPreservedVerbatim":True,"rawAndExitSavedBeforeInspection":True,"metadataOnlyReview":{"reportLinksChecked":len(links),"allTargetsExist":True,"referencedLinesInBounds":True,"sourceCurrentHashesChecked":len(manifest["files"]),"fixtureUnchangedSincePreflight":True,"rawMatchesExitReceipt":True,"artifactHashesChecked":len(files)},"limitations":"Receipt self excluded; source/hash/link verification only; no product reruns."}
(out/"jsonoutput-artifact-receipt.json").write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"files":len(files),"sourcePins":len(manifest["files"]),"links":len(links),"passed":True}))
