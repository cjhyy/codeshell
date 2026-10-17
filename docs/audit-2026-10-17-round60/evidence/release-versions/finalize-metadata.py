from pathlib import Path
import datetime
import hashlib
import json
import re

REPO = Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT = Path('/tmp/codeshell-audit-round152-release-versions')
NOW = datetime.datetime.now(datetime.timezone.utc).isoformat()

def sha(data):
    return hashlib.sha256(data).hexdigest()

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def numbers(spans):
    return {n for a, b in spans for n in range(a, b + 1)}

def spans(values):
    result = []
    for n in sorted(set(values)):
        if result and result[-1][1] + 1 == n:
            result[-1][1] = n
        else:
            result.append([n, n])
    return result

initial = json.loads((OUT / 'initial-pins.json').read_text())
pins = initial['files'] + json.loads((OUT / 'chain-pins.json').read_text()) + json.loads((OUT / 'manifest-test-pins.json').read_text())
pin_map = {p['path']: p for p in pins}
old_metadata_paths = ['docs/audit-2026-10-16/root.md']
for path in old_metadata_paths:
    pin_map.pop(path)

# These ranges describe source already displayed/read. No product methods run.
semantic = {
    'scripts/verify-release-versions.ts': [[1, 189]],
    'scripts/package-release-audit-config.ts': [[1, 184]],
    'scripts/release.ts': [[45, 182]],
    'scripts/publish-release-packages.ts': [[410, 426], [459, 470]],
    '.github/workflows/release.yml': [[23, 50], [74, 109], [117, 135]],
    '.github/workflows/release-recovery.yml': [[78, 84]],
    'packages/core/src/index.ts': [[7, 7]],
    'tests/package-boundaries.test.ts': [[239, 306]],
}
body = {
    'scripts/verify-release-versions.ts': [[1, 189]],
    'scripts/package-release-audit-config.ts': [[1, 297]],
    'scripts/release.ts': [[43, 197]],
    'scripts/publish-release-packages.ts': [[410, 470]],
    '.github/workflows/release.yml': [[1, 368]],
    '.github/workflows/release-recovery.yml': [[1, 128]],
    'package.json': [[1, 129]],
    'bun.lock': [[1, 280]],
    'tests/package-boundaries.test.ts': [[239, 306]],
}
nav_patterns = {
    'scripts/release.ts': r'verify-release|version|run\(',
    'scripts/publish-release-packages.ts': r'verifyRelease|collectRelease|process.exit|main\(',
    'packages/core/src/index.ts': r'VERSION',
    'tests/package-boundaries.test.ts': r'verifyRelease|collectRelease|version|^describe|^  (test|it)',
}
projected = {r['path']: r['fields'] for r in json.loads((OUT / 'manifest-field-projection.json').read_text())['files']}
rows = []
for path, pin in pin_map.items():
    data = (REPO / path).read_bytes()
    text = data.decode()
    lines = text.splitlines()
    assert sha(data) == pin['sha256'], path
    instruction = path in ('CODESHELL.md', 'AGENTS.md')
    row = dict(pin)
    row['lineCount'] = len(lines)
    row.pop('lines', None)
    row['category'] = 'instruction-hash-reuse' if instruction else ('test-declaration' if path.startswith('tests/') else 'product-or-release-data')
    row['bodyDisplayedLineRanges'] = body.get(path, [])
    row['bodyDisplayedLineCount'] = len(numbers(row['bodyDisplayedLineRanges']))
    nav = []
    if path in nav_patterns:
        nav = [n for n, line in enumerate(lines, 1) if re.search(nav_patterns[path], line)]
    row['additionalNavigationLineRanges'] = spans(set(nav) - numbers(row['bodyDisplayedLineRanges']))
    row['selectedLineRanges'] = semantic.get(path, [])
    if path == 'package.json' or path in projected:
        obj = json.loads(text)
        # Semantic focus: identity/version/public-private and current own-package
        # dependency scalar values. Other printed dependency values are incidental.
        selected = {n for n, line in enumerate(lines, 1) if re.search(r'^\s*"(?:name|version|private|publishConfig|access)"\s*:', line)}
        selected.update(n for n, line in enumerate(lines, 1) if re.search(r'^\s*"@cjhyy/code-shell[^" ]*"\s*:\s*"workspace:', line))
        if path == 'package.json':
            selected.update(range(68, 71))
        row['selectedLineRanges'] = spans(selected)
        row['semanticJsonPointers'] = ['/' + key for key in ('name', 'version', 'private', 'publishConfig') if key in obj]
        row['semanticJsonPointers'] += ['/' + section + '/' + key.replace('~', '~0').replace('/', '~1') for section in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies') for key in obj.get(section, {}) if key.startswith('@cjhyy/code-shell')]
        if path != 'package.json':
            row['displayedJsonPointers'] = ['/' + k for k in projected[path]]
            row['projectionDisplayNote'] = 'JSON field values printed in a synthesized one-line representation, not source lines/full source body. Exact source line display total is not asserted.'
    if path == 'bun.lock':
        selected = {n for n, line in enumerate(lines[:280], 1) if re.search(r'^  "workspaces"|^    "|^      "(?:name|version)"|^\s*"@cjhyy/code-shell', line)}
        row['selectedLineRanges'] = spans(selected)
        row['truncatedNavigation'] = {'query': '^  "(workspaces|overrides|packages)"|^    "|^      "(name|version)"', 'firstOutputTruncated': True, 'allActuallyVisibleExtraLinesNotCertified': True, 'fullRawAvailableOnlyAsLaterRecapture': 'lock-navigation.recaptured.stdout', 'semanticExpansionFromTruncatedOrRecapturedExtraLines': 0}
    row['semanticLineCount'] = len(numbers(row['selectedLineRanges']))
    row['coverage'] = 'hash-only' if instruction else ('full' if path == 'scripts/verify-release-versions.ts' else 'selected')
    row['semanticFull'] = path == 'scripts/verify-release-versions.ts'
    row['displayedLineRanges'] = spans(numbers(row['bodyDisplayedLineRanges']) | set(nav))
    row['displayedLineCount'] = len(numbers(row['displayedLineRanges']))
    if path == 'bun.lock' or path in projected:
        row['displayedLineCount'] = None
        row['displayedLineCountLimitation'] = 'Bounded body ranges are exact; truncated navigation or synthesized JSON projection is not converted into an exact total source-line display count.'
    row['oldCoverageLimitation'] = 'R6 listed this release family as read but its source-manifest note explicitly denies a full-depth coverage claim. This packet is a bounded overlapping review, not evidence of first-ever reading.' if path in ('scripts/verify-release-versions.ts', 'scripts/package-release-audit-config.ts', 'scripts/release.ts', 'scripts/publish-release-packages.ts', 'package.json') else 'No inference of historical unread status.'
    if instruction:
        row['instructionReuse'] = 'Previously fully read instructions, same SHA; no new body read in prep152.'
    rows.append(row)

product = [r for r in rows if r['category'] == 'product-or-release-data']
tests = [r for r in rows if r['category'] == 'test-declaration']
summary = {'sourceRows': len(rows), 'semanticProductRows': len(product), 'semanticProductLines': sum(r['semanticLineCount'] for r in product), 'testDeclarationRows': len(tests), 'testDeclarationLines': sum(r['semanticLineCount'] for r in tests), 'semanticFullRows': 1, 'instructionHashOnlyRows': 2, 'boundedBodyDisplayedLines': sum(r['bodyDisplayedLineCount'] for r in rows), 'allDisplayUnionCount': None, 'allDisplayUnionLimitation': 'Lock navigation was truncated and manifest JSON projections are not original source-line display. Do not add attempted/machine-matched lines as semantic reading.'}
save('source-manifest.json', {'atUTC': NOW, 'rootReportedBaseline': initial['rootReportedBaseline'], 'gitCertified': False, 'purpose': 'Static release version producer/check/caller contract; no global coverage upgrade', 'files': rows, 'summary': summary})

r6 = json.loads((REPO / 'docs/audit-2026-10-17-round6/source-manifest.json').read_text())
a11 = json.loads((REPO / 'docs/audit-2026-10-16/findings.json').read_text())['issues'][10]
save('canonical-history-read.json', {'sharedNavigation': 'history-projection.json', 'actuallyRead': [{'path': 'docs/audit-2026-10-17-round6/source-manifest.json', 'pointers': ['/files/94', '/note', '/baseline', '/assemblyWorkingTreeHead'], 'sourceRow': r6['files'][94], 'scopeNote': r6['note']}, {'path': 'docs/audit-2026-10-17-round6/root-package.md', 'lineRanges': [[1,25]], 'note': 'Historical tests/results are read as old metadata, never rerun or borrowed as prep152 validation.'}, {'path': 'docs/audit-2026-10-16/findings.json', 'pointers': ['/issues/10'], 'value': a11}, {'path': 'docs/audit-2026-10-16/root.md', 'lineRanges': [[88,100]], 'semanticOldCauseRanges': [[91,97]]}], 'gateDecision': 'Known same-SHA earlier read overlap, without explicit same-SHA full-depth certification in canonical R6. Proceeded with finite actual version-consistency contract review; no unread/first-full claim.', 'oldCauseExclusion': 'A11 task-branch --push integration/tag problem, not a new package-version finding. No revalidation of push behavior.'})

save('classification.json', {'formal': [], 'candidates': [], 'newRelated': [], 'counts': {'formal': 0, 'candidates': 0, 'newRelated': 0}, 'oldExcluded': [{'id':'A11','cause':'release --push may tag task-branch HEAD not merged into main','canonical':'docs/audit-2026-10-16/findings.json#/issues/10','countedAsNewRelated':False}], 'negative': 'No new ordinary-input counterexample established in the selected version-sync producer/check/caller chain. This is not release readiness or CI/native/npm correctness certification.'})

save('diagnostics.json', {'productExecution': 0, 'gitCommands': 0, 'buildTestInstallReleaseExecution': 0, 'networkNativeExecution': 0, 'firstInventoryExit': 0, 'firstMetadataError': None, 'firstTruncation': {'operation': 'Combined static release/publish/manifest fields/lock navigation/test navigation output', 'toolDiagnostic': ['Warning: truncated output (original token count: 10028)', 'Total output lines: 404', 'Warning: truncated output (original token count: 88784)', 'Total output lines: 1707'], 'cause': 'Lock navigation pattern ^    " also matched the packages dependency block, producing an oversized display.', 'firstCombinedRawCapturedToFile': False, 'limitation': 'Original first tool display is retained in conversation only. Do not label later recapture as original raw or claim all matched lines read.', 'recovery': 'Bounded lock 1–280 and test 239–306 read; same navigation stdout/stderr/exit later recaptured to explicit *.recaptured.* files without printing. No product rerun or expanded semantics.'}, 'pinTiming': 'All product/instruction before pins precede own body/navigation. Canonical metadata before pins are separate. No initial null hashes were retrofilled.', 'sourceReadingEnded': NOW, 'mechanismLimits': ['No actual Bun verifier invocation, import or error exit observed.', 'No package build/install/packing/publication or registry/CI-host operation.', 'No general release-authorization, credentials/native/signing or recovery mechanism certification.', 'Only current repository package declaration and ordinary supported bump forms; arbitrary invalid semver/nonexistent-package fixtures were not used.']})

metadata_pins = json.loads((OUT/'canonical-pins.json').read_text()) + [json.loads((OUT/'old-a11-pin.json').read_text())] + [p for p in pins if p['path'] in old_metadata_paths]
projection = json.loads((OUT/'history-projection.json').read_text())
metadata_pins += [projection['sharedBatch']]
ending = []
for pin in list(pin_map.values()) + metadata_pins:
    p = Path(pin['path']) if Path(pin['path']).is_absolute() else REPO / pin['path']
    b = p.read_bytes()
    ending.append({'path': pin['path'], 'beforeSha256': pin['sha256'], 'endingSha256': sha(b), 'bytes': len(b), 'unchanged': pin['sha256'] == sha(b)})
assert all(r['unchanged'] for r in ending)
save('ending-checks.json', {'atUTC': NOW, 'files': ending, 'sourceInstructionChecks': len(pin_map), 'boundedCanonicalAndSharedMetadataChecks': len(metadata_pins), 'allUnchanged': True, 'historyLimitation': 'Rehashed shared batch and personally read bounded canonical inputs only; not a fresh rehash/rescan of all 6126 historical documents.', 'gitOrFrozenBlobVerificationExecuted': False})

report = f'''# 发布版本一致性有限静态审查

新增 **0 formal / 0 candidate / 0 related**。Root 给定基线 `{initial['rootReportedBaseline']}`；本代理未运行 Git 或发布校验，不认证实际发布结果。

实际读取 `verify-release-versions.ts` 1–189：清单双向覆盖根 manifest 与 `packages/*/package.json`，逐包核 name/version/public-private，核 core VERSION、lock workspace 名称/版本及自有包旧版本字符串；收集错误后抛出，脚本入口 catch 设置 `exitCode=1`。当前声明为 15 包（10 public、5 private）；实际 manifest 的版本字段均为 0.9.45，自有依赖字段使用 workspace 引用。这里只读普通发布数据，未执行该校验得出 pass。

普通 producer `release.ts` 45–182 仅接受稳定版、rc.N、beta.N，先校验 current，再改同一声明清单和 core，调用 Bun 更新 lock，最后校验 target。`publish-release-packages.ts` 410–426 在提交命令前校验 rootVersion，459–470 有失败退出设置。release workflow 23–50 以 tag 去前缀作为校验参数，recovery 78–84 使用 `set -euo pipefail`；实际 workflow 退出结果未运行观测。现有 package-boundaries 测试只读 239–306 的声明，未借历史 R6 pass 作为本包验证。

R6 canonical `/files/94` 与当前 verifier 同 SHA，但原 manifest 明确为 selected evidence、不是 full-depth coverage claim；原报告 1–25 已读，保留已读重叠，不称历史未读或首次全文。旧 A11 原 `/issues/10` 与 root.md91–97 是任务分支推送/tag 集成关系问题，单独排除，不新增 related。共享历史机器导航含 6126 MD/JSON、4322397 value scalars，纳冻 59/排 60+、含 archive，verifier 33 命中全部保留（cap100、errors[]）；这不是亲读全部历史或所有 cause 无匹配的证明。

准确范围见 [source-manifest](source-manifest.json)：{summary['semanticProductRows']} 个产品/发布数据 semantic rows、{summary['semanticProductLines']} 行；测试声明 {summary['testDeclarationLines']} 行；目标全文 1，其他 selected，指令 hash-only 2。JSON 字段投影与过宽 lock 导航截断单列，不把完整显示、机器命中或 raw recapture 当语义阅读。一次过宽导航的首诊断及原 raw 未落盘限制见 [diagnostics](diagnostics.json)。

未建立新的普通输入反例；不推断所有依赖协议、CI 主机、打包、native、权限/签名或发布链正确。产品/helper/import/fixture/test/build/install/release/native/network/Git 执行均 0，未改产品。{len(pin_map)} 个源/指令 pin 与 {len(metadata_pins)} 个有限 canonical/shared 元数据结束 SHA 均未变；不是全历史结束复扫。[history](canonical-history-read.json)、[projection](history-projection.json)、[classification](classification.json)、[ending](ending-checks.json)、[receipt](artifact-receipt.json)。
'''
(OUT/'report.md').write_text(report)
save('artifact-receipt.json', {'atUTC': NOW, 'selfExcluded': 'artifact-receipt.json', 'files': [{'path': p.name, 'bytes': p.stat().st_size, 'sha256': sha(p.read_bytes())} for p in sorted(OUT.iterdir()) if p.is_file() and p.name != 'artifact-receipt.json'], 'productExecution': 0, 'gitCommands': 0, 'note': 'Metadata-only receipt generation; no author/product method or verifier executed. Self excluded intentionally.'})
print(json.dumps({'summary': summary, 'endingChecks': len(ending), 'artifacts': len(list(OUT.iterdir()))}, ensure_ascii=False))
for name in ['report.md','source-manifest.json','artifact-receipt.json']:
    b=(OUT/name).read_bytes();print(name,len(b),sha(b))
