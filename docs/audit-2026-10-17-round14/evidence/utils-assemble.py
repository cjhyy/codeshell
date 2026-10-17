# Metadata assembly only. Never imports product modules or executes tests.
from pathlib import Path
import json,subprocess,hashlib,re
root=Path(__file__).resolve().parents[3]
e=Path(__file__).resolve().parent
base="badc2262a90966f6f903977b849adf1f22b55e9f"
paths=[
"packages/core/src/utils/semver.ts","packages/core/src/utils/memoize.ts","packages/core/src/utils/sliceAnsi.ts","packages/core/src/utils/format.ts","packages/core/src/utils/toolDisplay.ts","packages/core/src/utils/format.test.ts","packages/core/src/utils/intl.ts",
"packages/core/src/plugins/pluginCommandsLoader.ts","packages/core/src/skills/scanner.ts",
"packages/tui/src/render/wrap-text.ts","packages/tui/src/render/render-border.ts","packages/tui/src/render/output.ts","packages/tui/src/render/wrapAnsi.ts","packages/tui/src/render/stringWidth.ts","packages/tui/src/cli/output/renderer.ts","packages/tui/src/ui/components/ToolCall.tsx",
]
sources=[]
for path in paths:
 blob=subprocess.check_output(["git","show",base+":"+path],cwd=root)
 cur=(root/path).read_bytes()
 sha=hashlib.sha256(blob).hexdigest()
 sources.append({"path":path,"frozenBytes":len(blob),"bytes":len(cur),"sha256":sha,"frozenSha256":sha,"currentSha256":hashlib.sha256(cur).hexdigest(),"currentMatchesFrozen":cur==blob,"scope":("existing six-test baseline executed" if path.endswith("/format.test.ts") else "formatDuration baseline only; other exports not exercised" if path.endswith("/format.ts") else "statically read; imported dependency only; no independent Intl verification" if path.endswith("/intl.ts") else "static only; Slice source was not loaded")})
(e/"utils-source-manifest.json").write_text(json.dumps({"frozenBase":base,"sources":sources},ensure_ascii=False,indent=2)+"\n")
runs=[]
for name in ["utils-slice-columns","utils-format-existing"]:
 receipt=json.loads((e/(name+".first.exit.json")).read_text())
 b=(e/(name+".first.raw.log")).read_bytes();text=b.decode()
 assert receipt["rawBytes"]==len(b) and receipt["rawSha256"]==hashlib.sha256(b).hexdigest()
 def n(pattern):
  m=re.search(pattern,text);return int(m.group(1)) if m else 0
 runs.append({"name":name,"command":receipt["command"],"rawLog":receipt["rawLog"],"exitReceipt":str((e/(name+".first.exit.json")).relative_to(root)),"exitCode":receipt["exitCode"],"firstOnly":True,"attempts":1,"reruns":0,"pass":n(r"\b(\d+) pass\b"),"fail":n(r"\b(\d+) fail\b"),"errors":n(r"\b(\d+) error\b"),"expect":n(r"\b(\d+) expect\(\) calls") if "Completed Bun shard:" in text else None,"testBodiesExecuted":6 if name=="utils-format-existing" else 0,"completed":("Completed Bun shard:" in text),"status":"clean-first-run" if receipt["exitCode"]==0 and "Completed Bun shard:" in text else "SKIP-first-fixture-import-failure"})
v={"frozenBase":base,"formalCount":0,"candidateCount":2,"relatedCount":1,"runs":runs,"cleanTotals":{"groups":1,"pass":6,"fail":0,"skipped":0,"expect":6},"failedFirstTotals":{"groups":1,"pass":0,"fail":1,"errors":1,"expect":None,"testBodiesExecuted":0},"unexecuted":[{"fixture":"docs/audit-2026-10-17-round14/evidence/utils-cache-format-controls.test.ts","attempts":0,"reason":"Retains same wrong relative import; preserved without repair or execution. No test assertions constitute runtime evidence."}],"limits":["No production Slice module was loaded; all Slice observations remain static candidates.","No replacement or retry execution occurred.","Existing baseline covers six sub-second formatDuration cases only.","No actual renderer, terminal, network, native process, user data, real scans, or tool was invoked."]}
(e/"utils-validation.json").write_text(json.dumps(v,ensure_ascii=False,indent=2)+"\n")
artifacts=[]
for f in sorted([e.parent/"utils.md",*e.glob("utils-*")]):
 if not f.is_file() or f.name=="utils-artifact-receipt.json":continue
 b=f.read_bytes();artifacts.append({"path":str(f.relative_to(root)),"bytes":len(b),"sha256":hashlib.sha256(b).hexdigest()})
(e/"utils-artifact-receipt.json").write_text(json.dumps({"frozenBase":base,"metadataOnly":True,"artifacts":artifacts},ensure_ascii=False,indent=2)+"\n")
print(json.dumps({"sources":len(sources),"artifacts":len(artifacts),"cleanTotals":v["cleanTotals"],"failedFirstTotals":v["failedFirstTotals"],"allCurrentMatchesFrozen":all(x["currentMatchesFrozen"] for x in sources)}))
