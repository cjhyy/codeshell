"""Freeze finite ordinary theme data/path reading; no product execution."""
from pathlib import Path
import json,hashlib,datetime
ROOT=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT=Path('/tmp/codeshell-audit-round166-desktop-theme-window')
def sha(b):return hashlib.sha256(b).hexdigest()
def write(n,v):(OUT/n).write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def union(rs):
 s={i for a,z in rs for i in range(a,z+1)};o=[]
 for i in sorted(s):
  if o and o[-1][1]+1==i:o[-1][1]=i
  else:o.append([i,i])
 return o
pins={r['path']:r for n in ['initial-pins.json','producer-before-pins.json'] for r in json.loads((OUT/n).read_text())['files']}
display={}
for n in [1,2]:
 for p,ranges in json.loads((OUT/f'source-read-0{n}-ranges.json').read_text()):display.setdefault(p,[]).extend(ranges)
scopes={
 'packages/desktop/src/main/theme-pack-conversion.ts':[[1,61]],
 'packages/desktop/src/main/theme-asset-url.ts':[[1,70]],
 'packages/desktop/src/main/theme-asset-protocol.ts':[[20,27],[49,85],[90,108],[110,127],[137,140]],
 'packages/core/src/themes/installer.ts':[[80,91],[170,188],[201,210],[427,514],[614,619]],
 'packages/core/src/themes/manifest.ts':[[69,79],[125,146],[150,188],[193,195]],
 'packages/core/src/themes/paths.ts':[[38,55]],
 'packages/desktop/src/shared/theme-packs.ts':[[1,53]],
 'packages/desktop/src/main/index.ts':[[3478,3480],[4964,4967],[4985,4994],[4996,5002]],
}
full={'packages/desktop/src/main/theme-pack-conversion.ts','packages/desktop/src/main/theme-asset-url.ts','packages/desktop/src/shared/theme-packs.ts'}
files=[];hashonly=[]
for p,r in pins.items():
 raw=(ROOT/p).read_bytes();assert len(raw)==r['bytes'] and sha(raw)==r['sha256'];lines=len(raw.splitlines())
 if p not in scopes:
  hashonly.append(dict(r,coverage='hash-only',semanticLineCount=0,scope='Only shared query source byte pin, prior window-state cause gate, or same-SHA instruction reuse. No Root product body reading.'));continue
 semantic=union(scopes[p]);shown=union(display[p]);shown_set={i for a,z in shown for i in range(a,z+1)}
 assert all(1<=a<=z<=lines for a,z in semantic+shown)
 assert all(i in shown_set for a,z in semantic for i in range(a,z+1))
 files.append(dict(r,coverage='full' if p in full else 'selected',selectedLineRanges=semantic,bodyDisplayedLineRanges=shown,semanticLineCount=sum(z-a+1 for a,z in semantic),bodyDisplayedLineCount=sum(z-a+1 for a,z in shown),semanticFull=p in full,newUniqueCoverageClaim=False,endingSha256=sha(raw),scope='Ordinary validated id/canonical local asset name -> InstalledTheme -> renderer pack URL -> URL/MIME/range response fields. Full labels only for whole text of small conversion/URL/type leaves; no real installation, Electron startup, media decode/playback, file custody/race/security or renderer application verification.',overlap='Core themes manifest/paths original R7 same-SHA full reading retained; selected reuse does not become newly unique. Main index is selected only.'))
history=[]
for name in ['prior-canonical-pins.json','old-theme-before-pins.json']:
 j=json.loads((OUT/name).read_text());rr=j.get('files',[]) if isinstance(j,dict) else j
 for r in rr:
  raw=(ROOT/r['path']).read_bytes();assert len(raw)==r['bytes'] and sha(raw)==r['sha256']
  history.append(dict(r,coverage='selected-metadata' if 'root-dedup' not in r['path'] else 'navigation-only-metadata',scope='Only exact selected original objects/ranges in prior-canonical-read.json and old-theme-canonical-read.json; not whole history or source semantic reading.'))
write('source-manifest.json',dict(baseline='d195788bc2c18cd85c81aea4a431ab29074df5cf',files=files,hashOnlyFiles=hashonly,historicalReportReads=history,productExecution=0,totals=dict(productSemanticFiles=len(files),full=len(full),selected=len(files)-len(full),semanticLines=sum(r['semanticLineCount'] for r in files),bodyDisplayedLines=sum(r['bodyDisplayedLineCount'] for r in files),testDeclarations=0),fullMeaning='Purpose-bound whole semantic source text, not complete behavior/platform/runtime verification. Complete display does not promote selected protocol/installer/paths/manifest/index.'))
write('classification.json',dict(formal=[],candidates=[],related=[],legacyWindowGate='Original May30 three window-state input/error-reporting observations kept as old dated causes, not revalidated or added to119 current-thread historical records. Window-state body reading0.',oldThemeOverlap='R7 manifest/paths explicit whole-text same SHA reused only minimum declaration selected; old renderer application navigation/glob failure and i18n experiments remain skipped.',productRuns=0))
write('diagnostics.json',dict(productFailures=0,metadataCommandFailures=0,presentation='First producer-history projection printed main/index1285 broad matches and exceeded tool budget:9751 original tokens/4500 budget. Unseen middle not counted read. Subsequent exact R7 original objects and20-line MD window displayed completely. Raw full scanner result stayed saved; no query rerun or fabricated raw transcript.',firstSourceHelperFailures=0,oldFailedDirections='R7 renderer application navigation and i18n/dependency experiment not resumed; no media/native/real theme registry interaction.'))
write('ending-checks.json',dict(sourceAndInstructionPins=len(pins),metadataPins=len(history),changed=[],allExplicitPinsUnchanged=True,productRuns=0))
totals=json.loads((OUT/'source-manifest.json').read_text())['totals']
(OUT/'report.md').write_text(f'''# Root166：主题资产数据链；窗口旧因排除

有限结论 **0 formal /0 candidate /0 new related**。基线d195788bc2c18cd85c81aea4a431ab29074df5cf；产品/helper/import/fixture/test/安装/媒体解码播放/Electron/真实设置/业务网络均0。

普通链已核：Core manifest id限定小写字母数字和短横线；installer170–210将各角色资源生成固定base+扩展名，427–514将其放入同`.cs-theme-assets/<file>`并保留appearance/frame/music字段，614–619读回匹配manifest.id。main4964–4967/4985–4994将InstalledTheme转renderer pack；conversion61行保留appearance控制与本地/HTTPS音乐互斥字段，只替换本地asset路径。URL70行按segment编码，parser只接受同两段canonical目录并解码；scheme id与installer约束一致，未建立合法普通名称的读写失配。

protocol141行全部显示，但只把普通URL/MIME、regular-file size/body/header/range字段与注册选段算语义；fs realpath/open/竞态/原生session机制停在显示边界。WAV本地生成同`.wav`且协议支持audio/wav，GET单range端点被钳到total；HEAD无body、header总长可见。未建立这条普通字段链反例，也不把有限0解释为资源权限、所有格式/播放器、I/O或native协议机制正确。

window-state-store只做hash/历史gate：原May30findings249–251与low_confirmed32已有非法存储值/静默I/O等旧意见，保持原日期/降级，不重报或把它们加到当前119；此轮窗口源码body0。原R7 root-metadata9明确Core themes manifest/paths完整读取，原manifest31/32同SHA；此次只为名字/字段补最小selected，重叠保留。R7 renderer应用导航glob和i18n失败方向继续SKIP，没有通过另一种动态方法恢复。

范围为{totals['productSemanticFiles']}产品files，{totals['full']}小叶全文（conversion/URL/shared types）+{totals['selected']}选段，语义{totals['semanticLines']}行、实际显示{totals['bodyDisplayedLines']}行；旧重复和consumer范围不能当新增唯一覆盖。测试声明/执行0。目录名、查询字节pin、完整显示与语义范围在[source manifest](source-manifest.json)分账。

共享首batch纳冻61排62+、6484 MD/JSON、4639853递归JSON value scalars、archive/hidden/unignored均含，errors[]。Root window196 cap100；theme conversion38/url37/protocol39均全保存。必要producer另一次有限query同6484输入：manifest87/paths73/installer67/shared types37全保存，main index1285只前100。机器访问不是全历史语义阅读；原窗口/主题canonical才是实际旧scope证据。

[首次共享扫描](history-first.stdout)、[原query](history-batch.json)、[producer query](producer-history-batch.json)、[原历史对象](prior-canonical-read.json)、[R7原scope](old-theme-canonical-read.json)、[实际正文01](source-read-01.txt)、[正文02](source-read-02.txt)、[诊断](diagnostics.json)、[分类](classification.json)、[结束pins](ending-checks.json)。首次producer metadata展示超预算如实保留，只把后续完整有界窗口计作亲读；没有产品失败/重跑。
''')
rows=[]
for p in sorted(OUT.rglob('*')):
 if p.is_file() and p.name!='artifact-receipt.json':
  raw=p.read_bytes();rows.append(dict(path=str(p.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
write('artifact-receipt.json',dict(frozenUTC=datetime.datetime.now(datetime.timezone.utc).isoformat(),selfExcluded=True,files=rows))
print(json.dumps(dict(files=len(rows)+1,totals=totals,anchors=[dict(path=n,bytes=len((OUT/n).read_bytes()),sha256=sha((OUT/n).read_bytes())) for n in ['report.md','source-manifest.json','artifact-receipt.json']]),ensure_ascii=False))
