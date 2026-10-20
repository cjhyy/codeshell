"""Metadata assembly only. Never runs or retries a product test."""
import hashlib,json,pathlib,re,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[3]
BASE="d5fae44358b3a92d4d02fd5fcc4ac21c56b2a08a"
OUT=pathlib.Path(__file__).resolve().parent
REL=OUT.relative_to(ROOT).as_posix()
def digest(data): return hashlib.sha256(data).hexdigest()
def write(name,value): (OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n")
def artifact(path):
 b=path.read_bytes();return {"path":path.relative_to(ROOT).as_posix(),"bytes":len(b),"sha256":digest(b)}
paths=[
 "CODESHELL.md",
 "packages/desktop/src/renderer/diff/parseUnifiedDiff.ts",
 "packages/desktop/src/renderer/diff/parseUnifiedDiff.test.ts",
 "packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx",
 "packages/desktop/src/renderer/diff/reviewScope.ts",
 "packages/desktop/src/renderer/diff/reviewScope.test.ts",
 "packages/desktop/src/renderer/keyboardShortcutHints.ts",
 "packages/desktop/src/renderer/keyboardShortcutHints.test.ts",
 "packages/desktop/src/renderer/tool-cards/utils.ts",
 "packages/desktop/src/renderer/tool-cards/utils.test.ts",
 "packages/desktop/src/renderer/tool-cards/FileToolCard.tsx",
 "packages/desktop/src/renderer/tool-cards/GenericToolCard.tsx",
 "packages/desktop/src/renderer/tool-cards/AgentToolCard.tsx",
 "packages/desktop/src/renderer/tool-cards/BashToolCard.tsx",
 "packages/desktop/src/main/desktop-services.ts",
 "packages/desktop/src/main/review-service.ts",
 "packages/core/src/tool-system/builtin/bash-output-style.ts",
 "packages/core/src/tool-system/builtin/write.ts",
]
sources=[]
for path in paths:
 frozen=subprocess.run(["git","show",f"{BASE}:{path}"],cwd=ROOT,check=True,stdout=subprocess.PIPE).stdout
 current=(ROOT/path).read_bytes()
 sources.append({"path":path,"frozenSha256":digest(frozen),"sha256":digest(current),"currentEqualsFrozen":current==frozen,"frozenBytes":len(frozen)})
write("desktop-source-manifest.json",{"frozenSource":BASE,"files":sources,"scope":"Inspected sources and exact baseline files; hash inclusion does not imply full-file behavioural coverage."})
finding={
 "id":"DESKTOP-R12-01","priority":"P3","title":"工具卡摘要截断拆开 Unicode 代理对",
 "file":"packages/desktop/src/renderer/tool-cards/utils.ts","line":13,
 "sourceBase":BASE,"evidenceLevel":"Actual production pure helper with valid Unicode input and real positive card limits; UI consumption source-only",
 "trigger":"Valid supplementary Unicode character straddles max-1 UTF-16 boundary at existing 70/80/90 card limits",
 "expected":"Truncated summaries remain well-formed Unicode text",
 "actual":"Returned text contains a lone high surrogate; standard UTF-8 roundtrip yields U+FFFD",
 "controls":"Short Unicode, complete emoji boundary, ASCII and BMP truncation",
 "limitations":"No UI mount, Electron, actual tool execution or file open; raw arguments remain intact",
 "relatedHistory":["CHD02: Chat attachment label implementation","HL-02: Host GitHub selection label implementation"],
 "report":"docs/audit-2026-10-17-round12/desktop.md",
 "fixture":f"{REL}/desktop-display-contracts.test.ts","rawLog":f"{REL}/desktop-display-contracts.first.log"
}
write("desktop-findings.json",{"sourceBase":BASE,"findings":[finding]})
candidate={"id":"DESKTOP-R12-C1","title":"Write 工具卡把字符串长度标为字节","file":"packages/desktop/src/renderer/tool-cards/FileToolCard.tsx","line":56,"evidenceLevel":"Source-only candidate","reason":"content.length is UTF-16 code units while B denotes bytes; ordinary Unicode differs from UTF-8 byte count","limits":"No actual component mount or production Write execution; not counted confirmed","sourceBase":BASE}
write("desktop-candidates.json",{"sourceBase":BASE,"candidates":[candidate]})
related={"id":"DESKTOP-R12-R1","title":"Header-only diff paths remain null","file":"packages/desktop/src/renderer/diff/parseUnifiedDiff.ts","line":48,"disposition":"Related extension of old R2-10; not an independent new finding","relatedId":"R2-10","actual":"Mode-only, empty additions/deletions, binary notices lose both paths; ordinary text hunk control correct","evidenceLevel":"Actual parser with synthetic Git-format strings; normal producer format from upstream official source and product caller source-only","limits":"No installed Git execution/capture or UI mounting","fixture":f"{REL}/desktop-display-contracts.test.ts","rawLog":f"{REL}/desktop-display-contracts.first.log"}
write("desktop-related.json",{"sourceBase":BASE,"observations":[related]})
runs=[]
for name,kind,files in [
 ("desktop-display-contracts","focused observations and controls",[f"{REL}/desktop-display-contracts.test.ts"]),
 ("desktop-existing-metadata","existing targeted pure metadata baseline",["packages/desktop/src/renderer/keyboardShortcutHints.test.ts","packages/desktop/src/renderer/tool-cards/utils.test.ts","packages/desktop/src/renderer/diff/reviewScope.test.ts"]),
]:
 log=OUT/f"{name}.first.log"; txt=log.read_text(); receipt=json.loads((OUT/f"{name}.first.receipt.json").read_text()); exitfile=OUT/f"{name}.first.exit.txt"; exitcode=int(exitfile.read_text())
 passm=re.search(r"^\s*(\d+) pass$",txt,re.M); expectm=re.search(r"^\s*(\d+) expect\(\) calls$",txt,re.M); failm=re.search(r"^\s*(\d+) fail$",txt,re.M)
 completed=re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures[.]",txt)
 runs.append({"name":name,"kind":kind,"attempt":1,"command":receipt["command"],"sourceBase":BASE,"fixtures":[artifact(ROOT/x) for x in files],"rawCombinedStdoutStderr":log.relative_to(ROOT).as_posix(),"rawLogSha256":digest(log.read_bytes()),"exitFile":exitfile.relative_to(ROOT).as_posix(),"exitFileSha256":digest(exitfile.read_bytes()),"exitCode":exitcode,"tests":int(passm[1]) if passm else 0,"expectCalls":int(expectm[1]) if expectm else 0,"failures":int(failm[1]) if failm else None,"skipped":int(completed[2]) if completed else None,"guardedCompletionPresent":bool(completed),"clean":exitcode==0 and bool(completed) and int(completed[3])==0})
write("desktop-validation.json",{
 "sourceBase":BASE,"confirmedFindings":[finding],"candidateIds":[candidate["id"]],"relatedObservationsNotCounted":[related["id"]],"runs":runs,
 "totals":{"cleanFirstShards":sum(r["clean"] for r in runs),"tests":sum(r["tests"] for r in runs if r["clean"]),"expectCalls":sum(r["expectCalls"] for r in runs if r["clean"]),"newFocusedTests":9,"baselineTests":23,"failures":sum(r["failures"] or 0 for r in runs),"skipped":sum(r["skipped"] or 0 for r in runs),"failedShards":sum(not r["clean"] for r in runs),"retries":0},
 "firstRunPolicy":"Each combined stdout/stderr log and exit file saved before inspection. Zero product failure/retry. Metadata-only errors and corrections disclosed in desktop-metadata-notes.md.",
 "scope":"Actual production pure metadata helper functions and standard UTF-8 encoders only. No UI/Electron/native/PTY/Git product process/model/network business call/user data/auth/security/custody experiment. Official web sources read only for normal patch format. No shared dependency/dist build or broad lint/typecheck/suite claims.",
 "sourceManifest":f"{REL}/desktop-source-manifest.json","dedup":f"{REL}/desktop-dedup.json","metadataNotes":f"{REL}/desktop-metadata-notes.md","externalSources":f"{REL}/desktop-external-sources.json"
})
owned=[ROOT/"docs/audit-2026-10-17-round12/desktop.md",*sorted(OUT.glob("desktop-*"))]
owned=[p for p in owned if p.is_file() and p.name!="desktop-artifact-receipt.json"]
write("desktop-artifact-receipt.json",{"sourceBase":BASE,"artifacts":[artifact(p) for p in owned],"selfExcluded":True,"policy":"Receipts and source manifests only; no test rerun."})
print(json.dumps({"sourceBase":BASE,"confirmed":1,"candidates":1,"relatedNotNew":1,"runs":len(runs),"tests":sum(r["tests"] for r in runs),"expectCalls":sum(r["expectCalls"] for r in runs),"sourceFiles":len(sources),"artifacts":len(owned),"currentSourceEqual":all(x["currentEqualsFrozen"] for x in sources)}))
