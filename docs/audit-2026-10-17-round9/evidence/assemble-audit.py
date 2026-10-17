"""Assemble audit metadata from preserved first observations; never execute tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round9"
EV = OUT / "evidence"
BASE = "248d091202869c07274adedf4fd50403105f1b1f"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


rows = [
    ("ATT-R9-01", "空格工作区中的完整产物路径被截断成错误附件路径", "attachments.md", "packages/desktop/src/renderer/tool-cards/attachments.ts", 56, "attachments-path-projection", "真实detector+自有tmp文件，producer和UI传播静态追踪", "不执行GenerateImage/provider/解码/UI/IPC/native打开；正确原路径仍在结果文本"),
    ("COST-R9-01", "独立CostTracker记录丢失完整模型标识并采用错误估价", "usage.md", "packages/core/src/cost-tracker.ts", 115, "root-usage-contracts", "真实公共standalone SDK+冻结bundled metadata；内存ledger正常对照", "仅未绑定CostTracker；当前EngineRuntime绑定账本，主流程正确；无实际账单/外部价格/网络验证"),
    ("SESSION-R9-01", "超工具调用上限的完成会话留下未配对持久化调用并阻断full fork", "session.md", "packages/core/src/engine/turn-loop.ts", 0, "session-call-cap", "实际Facade/TurnLoop/Transcript/SessionManager+fake model/executor", "无真实模型/网络/native；只确认full fork，resume有孤儿调用修补，不声称下一次send失败"),
]
session_data = json.loads((EV / "session-findings.json").read_text())
session_rows = session_data if isinstance(session_data, list) else session_data.get("findings", session_data.get("confirmedFindings", []))
session = next(row for row in session_rows if row["id"] == "SESSION-R9-01")
findings = []
for ident, title, report, source, line, run, level, limits in rows:
    if ident == "SESSION-R9-01":
        source = session.get("file", session.get("source"))
        line = session.get("line", session.get("startLine"))
    heading = next(n for n, text in enumerate((OUT / report).read_text().splitlines(), 1)
                   if text.startswith("#") and ident in text)
    blob = subprocess.check_output(["git", "show", BASE + ":" + source], cwd=ROOT)
    assert 0 < line <= len(blob.decode().splitlines()) and (EV / (run + ".first.log")).is_file()
    findings.append(dict(id=ident, priority="P3", title=title, report=report, reportLine=heading,
                         source=source, line=line, log="evidence/" + run + ".first.log",
                         evidenceLevel=level, limitations=limits, status="confirmed-at-frozen-source-baseline"))
save("findings.json", dict(baseline=BASE, count=len(findings), priorities={"P3": len(findings)}, findings=findings))
tools = json.loads((EV / "tools-candidates.json").read_text())
candidates = tools if isinstance(tools, list) else tools.get("candidates", [])
assert len(candidates) == 1
save("candidates.json", dict(baseline=BASE, count=1, candidates=candidates,
    otherStaticObservations=[
        dict(report="attachments.md", subject="Windows/backslash compatibility", status="static-only-not-promoted", reason="No Windows/native validation; no extra confirmed issue."),
        dict(report="attachments.md", subject="directory depth and truncated marker", status="static-only-not-promoted", reason="Consumer contract does not establish that depth omission must set truncated."),
    ]))

names = ["root-usage-contracts", "root-usage-existing-baseline", "attachments-path-projection",
         "attachments-existing-baseline", "tools-registry-replacement", "tools-surface-baseline",
         "session-roundtrip-controls", "session-existing-baseline", "session-call-cap"]
runs = []
for name in names:
    log = EV / (name + ".first.log")
    raw = log.read_bytes()
    text = raw.decode(errors="replace")
    exit_file = next(p for p in [EV / (name + suffix) for suffix in [".first.exit.txt", ".first.exit.json"]] if p.is_file())
    code = int(exit_file.read_text().strip()) if exit_file.suffix == ".txt" else json.loads(exit_file.read_text())["exitCode"]
    complete = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)

    def count(pattern):
        match = re.search(pattern, text, re.M)
        return int(match.group(1)) if match else None

    row = dict(log="evidence/" + log.name, exitFile="evidence/" + exit_file.name,
               firstRun=True, exitCode=code, completed=bool(complete),
               passed=count(r"^\s*(\d+) pass\s*$"), failed=count(r"^\s*(\d+) fail\s*$"),
               expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"),
               skipped=int(complete.group(2)) if complete else None, sha256=sha(raw))
    assert complete and code == row["failed"] == row["skipped"] == 0, row
    assert row["passed"] == int(complete.group(1))
    runs.append(row)
totals = dict(firstBunShards=len(runs), completedCleanShards=len(runs), passedTests=sum(r["passed"] for r in runs),
              expectations=sum(r["expectations"] for r in runs), skippedOrFilteredTests=sum(r["skipped"] for r in runs),
              failedShardsSeparatelyRetained=0, existingBaselineTests=106, newFocusedObservationsAndControls=17)
assert totals["passedTests"] == 123 and totals["expectations"] == 431, totals
assert totals["existingBaselineTests"] + totals["newFocusedObservationsAndControls"] == totals["passedTests"]
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs, notes=[
    "Raw first combined stdout/stderr and exit saved before inspection; no failed Bun shard or product rerun in this batch.",
    "123 tests comprise 106 existing baseline tests and 17 focused observations/controls; shared finding logs count once.",
    "Characterization tests assert observed wrong behavior and normal controls; passing logs do not mean product defects are fixed.",
    "One guessed renderer source filename failed and was skipped; navigation transcription is separate from runtime evidence.",
    "Metadata preflight/collection/citation corrections are labeled separately, add zero product executions, and do not recover skipped directions.",
    "Attachment formatter/UI propagation and Session resume repair are static evidence; native UI/providers/opening/user data were not exercised.",
    "Standalone cost finding excludes the bound ledger main route, verified with an in-memory correct control; no current external price or real bill claim.",
    "No real models, paid APIs, accounts, user data, external messages, native apps/PTY, auth/permission/security/custody/watchdog experiments, shared dist/dependency rebuild or full build/typecheck/lint/test.",
]))

sources = {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json"}
for path in OUT.glob("*.md"):
    sources.update(re.findall(r"\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b", path.read_text()))
for path in EV.glob("*source-manifest.json"):
    data = json.loads(path.read_text())
    for row in data.get("files", data.get("sources", data.get("paths", []))):
        if isinstance(row, dict) and isinstance(row.get("path"), str):
            sources.add(row["path"])
manifest, unresolved = [], []
for name in sorted(sources):
    blob = subprocess.run(["git", "show", BASE + ":" + name], cwd=ROOT, capture_output=True)
    path = ROOT / name
    if blob.returncode or not path.is_file():
        unresolved.append(name)
        continue
    manifest.append(dict(path=name, bytes=len(blob.stdout), sha256=sha(blob.stdout), frozenBlobVerified=True,
                         currentWorkingTreeMatchesFrozenBlob=path.read_bytes() == blob.stdout))
assert not unresolved, unresolved
save("source-manifest.json", dict(baseline=BASE,
    assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    files=manifest, unresolvedReferences=unresolved,
    note="Frozen Git blob SHA and current equality are distinct. Selected source inventory does not imply full-depth/full-file coverage."))
files = []
for path in sorted(OUT.rglob("*")):
    if path.is_file() and path.name != "evidence-index.json":
        raw = path.read_bytes()
        files.append(dict(path=str(path.relative_to(OUT)), bytes=len(raw), sha256=sha(raw)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files,
    note="Self excluded; first raw process logs retained verbatim. Tool response transcriptions labeled; metadata-only assembly executes no product/test code."))
print(json.dumps(dict(findings=len(findings), candidates=1, totals=totals, sources=len(manifest), evidenceFiles=len(files)), ensure_ascii=False))
