"""Root-owned audit metadata assembly. No product imports or tests."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round29"
EV = OUT / "evidence"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read(name):
    return json.loads((EV / name).read_text())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


plan = read("integration-plan.json")
baseline = plan["baseline"]
main = plan["refreshedMain"]
assert git("rev-parse", "main").decode().strip() == main
assert git("rev-parse", "HEAD").decode().strip() == main
manifests = [
    "root-source-manifest.json",
    "runtime-source-manifest.json",
    "room-source-manifest.json",
    "stop-source-manifest.json",
    "review-root-runtime-source-manifest.json",
    "review-room-stop-source-manifest.json",
]
checks = []
pins = {}
for name in manifests:
    source_data = read(name)
    for original in source_data.get("files", source_data.get("sourcePins", [])):
        row = dict(original)
        row["sha256"] = row.get("sha256", row.get("initialSha256"))
        row["selectedLineRanges"] = row.get("selectedLineRanges", row.get("ranges", []))
        if "finishSha256" in row:
            assert row["sha256"] == row["finishSha256"]
        path = row["path"]
        assert not path.startswith("docs/audit-2026-10-17-round29/")
        raw = (ROOT / path).read_bytes()
        assert len(raw) == row["bytes"] and sha(raw) == row["sha256"], (name, path)
        for start, end in row.get("selectedLineRanges", []):
            assert 1 <= start <= end <= len(raw.splitlines()), (name, path, start, end)
        previous = pins.get(path)
        assert previous is None or previous == row["sha256"]
        pins[path] = row["sha256"]
        checks.append(dict(manifest=name, path=path, sha256=row["sha256"],
                           coverage=row.get("coverage"), rootBoundFrozenGitBlob=True,
                           note="Original full/selected ranges, pin timing and same-prep-read limits remain authoritative."))

hash_only = []
for row in read("runtime-prep/selection.json")["selectedMainSources"]:
    hash_only.append(dict(path=row["path"], sha256=row["firstFilesystemSha256"],
                          coverage="Earlier coverage inventory selection hash only; semantic read separately declared once by runtime author"))
for row in read("stop-initial-source-pins.json")["files"]:
    if row["path"] in read("stop-source-manifest.json")["inventoryOnlyNotSemanticallyRead"]:
        hash_only.append(dict(path=row["path"], sha256=row["firstFilesystemSha256"],
                              coverage="Stop initial inventory only; not semantically read"))
for row in read("review-room-stop-source-manifest.json")["hashOnlyFiles"]:
    hash_only.append(dict(path=row["path"], sha256=row["sha256"], coverage=row["coverage"]))
for row in hash_only:
    if row["path"] in pins:
        assert pins[row["path"]] == row["sha256"]
    pins[row["path"]] = row["sha256"]
files = []
for path, expected in sorted(pins.items()):
    frozen = git("show", baseline + ":" + path)
    current = (ROOT / path).read_bytes()
    main_raw = git("show", main + ":" + path)
    assert sha(frozen) == expected, path
    assert current == main_raw, path
    files.append(dict(path=path, bytes=len(frozen), sha256=expected,
                      currentBytes=len(current), currentSha256=sha(current),
                      mainBytes=len(main_raw), mainSha256=sha(main_raw),
                      currentWorkingTreeMatchesFrozenBlob=current == frozen,
                      mainMatchesFrozenBlob=main_raw == frozen,
                      currentWorkingTreeMatchesMain=True))
write(OUT / "source-manifest.json", dict(baseline=baseline, mainHead=main, files=files,
    workerSourceChecks=checks, priorPrepHashOnlyChecks=hash_only,
    changedFromFrozenPaths=[x["path"] for x in files if not x["currentWorkingTreeMatchesFrozenBlob"]],
    note="Runtime prep10 source rows reused by its formal manifest are the same semantic read, not another10 checks. No full inventory rescan. Hash-only rows are not semantic coverage."))

receipts = ["root-artifact-receipt.json", "runtime-artifact-receipt.json",
            "room-author-receipt.json", "stop-artifact-receipt.json",
            "runtime-prep-copy-receipt.json", "review-root-runtime-artifact-receipt.json"]
receipt_checks = []
for name in receipts:
    for row in read(name)["files"]:
        target = row.get("destination", row.get("path"))
        path = ROOT / target if target.startswith("docs/") else OUT / target
        raw = path.read_bytes()
        assert len(raw) == row["bytes"] and sha(raw) == row["sha256"], (name, target)
        if "source" in row:
            assert Path(row["source"]).read_bytes() == raw
        receipt_checks.append(dict(receipt=name, path=target, bytes=len(raw), sha256=sha(raw)))
write(EV / "root-author-copy-checks.json", dict(checks=receipt_checks,
    authorArtifactChecks=sum(1 for x in receipt_checks if x["receipt"] not in ["runtime-prep-copy-receipt.json", "review-root-runtime-artifact-receipt.json"]),
    reviewReceiptChecks=sum(1 for x in receipt_checks if x["receipt"] == "review-root-runtime-artifact-receipt.json"),
    verbatimCopyChecks=sum(1 for x in receipt_checks if x["receipt"] == "runtime-prep-copy-receipt.json"),
    productExecution=False))

for kind in ["findings", "candidates", "related"]:
    for scope in ["root", "runtime", "room", "stop"]:
        data = read(scope + "-" + kind + ".json")
        assert data == [] or data.get("count") == 0, (scope, kind)
    write(OUT / (kind + ".json"), dict(baseline=baseline, count=0,
          **{kind: []}, note="Old exclusions and historical candidates are not new related findings."))
for scope in ["root", "runtime", "room", "stop"]:
    assert read(scope + "-validation.json")["runs"] == []
write(OUT / "validation.json", dict(baseline=baseline, runs=[],
    totals=dict(productAttempts=0, testRuns=0, passedTests=0, expectations=0,
                productImports=0, productReruns=0),
    authorValidations=["evidence/" + x + "-validation.json" for x in ["root", "runtime", "room", "stop"]],
    mode="static-only", rawLogs=[],
    note="Existing declarations, old test receipts and static source protections are never counted as current passes."))

history = read("root-dedup.json")
summary = dict(baseline=baseline, mainHead=main, formal=0, candidates=0, related=0,
               sourcePins=len(files), activeSourceChecks=len(checks), hashOnlyChecks=len(hash_only),
               authorArtifactChecks=49, verbatimPrepCopies=13, history=history["totals"],
               productRuns=0, oldFailedDirectionsRemainSkipped=True, goalStillActive=True)
write(OUT / "coverage.json", summary)
(EV / "root-qc.md").write_text("""# Root metadata review

Four author reports and their classification/validation/source manifests were read. All remain0formal/0candidate/0new-related. Room R17 candidate, native Browser Stop and old user-display failures remain historical exclusions. No product run or substitute validation was added.

All49 author artifact rows,2 independent reviewer receipt rows and13 verbatim prep copies are independently byte/hash checked in [author checks](root-author-copy-checks.json). Copied prep retains its32c parent/time/old history2677; formal history2765 includes frozen Round28 and excludes current29. Runtime formalization reuses the same semantic reading.

Root source binding separates author read-time pins, full/selected scope, frozen b348/current/main and inventory hash-only rows. Late first pins remain late/null. The ignored approvals test is hash-only. No filename inventory or keyword count is an audit completion percentage.

Root metadata discovery errors and stop locator error remain in their original notes. Current ordinary source review found no concrete new counterexample; this is not a claim of whole-repository correctness. No product code changed.
""")
(OUT / "README.md").write_text(f"""# 第29批：队列、回放与消息状态静态审查

本批 **0新增正式问题、0候选、0新关联**；未修改产品。冻结提交 `{baseline}`，整合前main `{main}`。审查仍在继续，不代表全仓完成或没有其他bug。

- [Core队列与Web回放](runtime-report.md)：取消、晚到结果与历史liveness合同。
- [房间历史与消息映射](room-report.md)：分页完整性和普通工具事件DTO。
- [Stop目标选择](stop-report.md)：override/active/running优先级及真实入口。
- [输出恢复与流信封](root-report.md)：私有候选提交、输入锚点及legacy事件。

全部为静态阅读，**0产品/测试执行、0pass、0expect**，旧失败方向继续跳过。源码范围、首次hash时序和限制分别保留；原prep阅读没有重复计数。全历史去重含归档MD及递归JSON值，共2765文件，关键词上下文不是语义穷尽。

[分类](findings.json)、[候选](candidates.json)、[旧关联分类](related.json)、[验证](validation.json)、[源码绑定](source-manifest.json)、[覆盖口径](coverage.json)、[材料索引](evidence-index.json) 可复核。独立复核见 [Root/runtime](evidence/review-root-runtime.md)、[room/stop](evidence/review-room-stop.md) 和 [Root材料检查](evidence/root-qc.md)。
""")
print(json.dumps(summary, ensure_ascii=False))
