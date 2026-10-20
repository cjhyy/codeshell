"""Assemble indexes from immutable first-run logs; never executes product code."""
from pathlib import Path
import collections
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round5"
BASE = "9a421b3e65d5bfe662b78062cb86bd99483a683a"
def sha(data): return hashlib.sha256(data).hexdigest()
def save(name, data): (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
rows = [
    ("WEB-R5-01", "P2", "子代理事件改写主任务全局运行状态", "root-web.md", "packages/web/src/lib/streamReducer.ts", 206, ["root-web-state.first.log", "root-web-background.first.log"], "真实reducer/snapshot/Agent后台分支+内存spawner", "父terminal模拟；无真实Engine/Host/WS/UI；主后续生命周期或snapshot可恢复"),
    ("WEB-R5-02", "P3", "乱序结果回填遗漏正常显示清理", "root-web.md", "packages/web/src/lib/streamReducer.ts", 291, ["root-web-state.first.log"], "真实reducer有序/支持的乱序分支对照", "普通附注显示差异；未证明真实传输乱序/敏感泄露"),
    ("PROFILE-R5-01", "P2", "不同catalog source键碰撞并互相删除缓存", "profile.md", "packages/core/src/profile/catalog.ts", 94, ["profile-catalog-data.first.log"], "真实key/registry/reader/remover+自有tmp", "手动seed正常格式缓存；未clone/install/网络/真实Desktop/已安装profile删除"),
    ("PROMPT-01", "P3", "祖先local和后代project指令优先序违背声明", "prompt.md", "packages/core/src/prompt/instruction-scanner.ts", 108, ["prompt-instruction-order.first.log"], "真实scanner/composer/自有文件/注入boundary", "顺序合同偏差；未证明模型服从结果/安全影响"),
    ("CHAT-R5-01", "P2", "LINE原生按钮投影超过平台label/URI限制", "chat-text.md", "packages/chat/src/line.ts", 121, ["chat-line-button-contract.first.log"], "真实Mimi/Gateway/LINE send+内存transport", "当前内部schema接受；只观测超限请求，无真实平台拒绝/用户界面/重试结果"),
]
findings = []
for ident, priority, title, report, source, line, logs, level, limits in rows:
    heading_line = next(i for i, t in enumerate((OUT / report).read_text().splitlines(), 1) if t.startswith("#") and re.search(r"\b" + re.escape(ident) + r"\b", t))
    frozen = subprocess.check_output(["git", "show", BASE + ":" + source], cwd=ROOT).decode()
    assert 0 < line <= len(frozen.splitlines())
    assert all((OUT / "evidence" / log).is_file() for log in logs)
    findings.append(dict(id=ident, priority=priority, title=title, report=report, reportLine=heading_line,
        source=source, line=line, logs=["evidence/" + log for log in logs], evidenceLevel=level,
        limitations=limits, status="confirmed-at-frozen-source-baseline"))
save("findings.json", dict(baseline=BASE, count=len(findings), priorities=dict(collections.Counter(f["priority"] for f in findings)), findings=findings))
runs = []
for p in sorted((OUT / "evidence").glob("*.first.log")):
    text = p.read_text(errors="replace")
    if "bun test v" not in text: continue
    def count(pattern):
        match = re.search(pattern, text, re.M)
        return int(match.group(1)) if match else None
    complete = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    assert complete, p
    stem = p.name.removesuffix(".first.log")
    exits = [p.with_name(stem + suffix) for suffix in [".first.exit.txt", ".exit.txt", ".exit"]]
    exit_file = next(e for e in exits if e.is_file())
    row = dict(log=str(p.relative_to(OUT)), exitFile=str(exit_file.relative_to(OUT)), exitCode=int(exit_file.read_text().strip()),
        firstRun=True, completed=True, passed=count(r"^\s*(\d+) pass\s*$"), failed=count(r"^\s*(\d+) fail\s*$"),
        expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"), selectedTests=int(complete.group(1)), skipped=int(complete.group(2)),
        phase="existing-profile-baseline" if stem == "profile-baseline" else "focused-observation-and-controls", sha256=sha(p.read_bytes()))
    assert row["exitCode"] == row["failed"] == row["skipped"] == 0, row
    runs.append(row)
totals = dict(completedShards=len(runs), passedTests=sum(r["passed"] for r in runs), expectations=sum(r["expectations"] for r in runs),
    skippedOrFilteredTests=sum(r["skipped"] for r in runs), failedShardsSeparatelyRetained=0, existingBaselineTests=86, focusedTestsAndControls=18)
assert totals == dict(completedShards=7, passedTests=104, expectations=330, skippedOrFilteredTests=0, failedShardsSeparatelyRetained=0, existingBaselineTests=86, focusedTestsAndControls=18), totals
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs, notes=[
    "Shared Web evidence counted once, not per finding.",
    "Green wrong-behavior assertions reproduce bugs and controls, not product fixes.",
    "Profile baseline has exactly seven existing files; 104 is not a full repository gate or 104 new defect tests.",
    "WhatsApp first primary-source open failure is a research skip, not failed Bun fixture. DingTalk lacks exact readable primary contract.",
    "Prompt metadata count-parser failure is transparently transcribed; corrected assembly uses unchanged first logs and adds zero test execution.",
    "No previous failed CLI/recorder/summary/Discord direction revived; no product test retries this batch.",
    "Crossreviews and final material verifiers add zero product execution.",
    "No real models/servers/platform/account/Host/WS/DOM/Native/cross-platform/full build/typecheck/lint.",
    "Direct source and reused node_modules do not prove clean package/dist validation. Frozen baseline remains unchanged by main integration.",
]))
sources = {r[4] for r in rows}
for p in list(OUT.glob("*.md")) + list((OUT / "evidence").glob("*.json")):
    if p.name.endswith("dedup.json"): continue
    sources.update(re.findall(r"(?:packages|scripts)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|js|md)\b", p.read_text()))
sources.update(["CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json"])
sources.update("packages/" + name + "/package.json" for name in ["core", "coding", "chat", "web", "pet"])
manifest, unresolved = [], []
for name in sorted(sources):
    blob = subprocess.run(["git", "show", BASE + ":" + name], cwd=ROOT, capture_output=True)
    p = ROOT / name
    if blob.returncode or not p.is_file(): unresolved.append(name); continue
    manifest.append(dict(path=name, bytes=len(blob.stdout), sha256=sha(blob.stdout), frozenBlobVerified=True, currentWorkingTreeMatchesFrozenBlob=p.read_bytes()==blob.stdout))
save("source-manifest.json", dict(baseline=BASE, assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    files=manifest, unresolvedReferences=unresolved, note="SHA refers to frozen Git blobs. Current equality is separate; no rerun or full-depth review implied."))
files = []
for p in sorted(OUT.rglob("*")):
    if p.is_file() and p.name != "evidence-index.json":
        data = p.read_bytes(); files.append(dict(path=str(p.relative_to(OUT)), bytes=len(data), sha256=sha(data)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files, note="Self excluded. First stdout/stderr kept verbatim; hashes are material checks, not product tests."))
print(json.dumps(dict(findings=len(findings), priorities=dict(collections.Counter(f["priority"] for f in findings)), totals=totals, sources=len(manifest), unresolved=unresolved, evidenceFiles=len(files)),ensure_ascii=False))
