from pathlib import Path
import json,hashlib,datetime,re,collections
r=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');o=r/'docs/audit-2026-10-17-round50';e=o/'evidence'
def sha(b):return hashlib.sha256(b).hexdigest()
def put(p,a):p.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n')
old=r/'docs/audit-2026-10-17-round48/recorded-findings-catalog.json';a=json.loads(old.read_text());b=json.loads(json.dumps(a));f=json.loads((o/'findings.json').read_text())['findings'];assert len(f)==1 and f[0]['id']=='DESKTOP-R50-01'
b['createdUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat();b['scope']='113 dated formal historical records through formal50; not current unresolved count, not complete runtime revalidation.';b['baseline']=json.loads((o/'source-manifest.json').read_text())['baseline'];b['predecessorCatalog']={'path':str(old.relative_to(r)),'bytes':old.stat().st_size,'sha256':sha(old.read_bytes()),'rowsPreservedUnchanged':112}
b['findings'].append({'id':f[0]['id'],'priority':'P3','title':f[0]['title'],'sourceRound':50,'canonicalFindings':'docs/audit-2026-10-17-round50/findings.json','baseline':b['baseline'],'originalStatus':'static-confirmed; runtime unvalidated','originalFixedFlag':False,'originalMainSourceDisposition':None,'statusInterpretation':'Dated source-only confirmation plus independent static review; no actual UI/run or current-unfixed revalidation inferred.'})
raw=(o/'findings.json').read_bytes();b['sourceDocuments'].append({'round':50,'path':'docs/audit-2026-10-17-round50/findings.json','bytes':len(raw),'sha256':sha(raw),'originalReportedCount':1,'baselineBlobMatches':False,'bindingNote':'New documentation at formal50; baseline source pins bound separately, not an existing findings blob at read baseline.'})
b['counts']={'formalRecordRows':113,'uniqueIds':113,'byPriority':{'P2':44,'P3':69},'rounds':50};assert b['findings'][:112]==a['findings'];assert collections.Counter(x['priority'] for x in b['findings'])=={'P2':44,'P3':69};put(o/'recorded-findings-catalog.json',b)
text=(r/'docs/audit-2026-10-17-round48/ALL-ISSUES.md').read_text();rows=[line for line in text.splitlines() if re.match(r'\| \[[^]]+\]\([^)]*\) \| P[23] \| ',line)];assert len(rows)==112
rows.append('| [DESKTOP-R50-01](findings.json) | P3 | 带工具的活跃回合把目标进度纳入过程分组后，丢失“再续”回调与按钮（静态确认，未运行复验） |')
intro='''# 全部113项正式历史问题与审查范围\n\n截至正式50，累计 **113项历史问题：44项P2、69项P3**。下表逐项列全，ID指向原报告；原112项的历史优先级和记录保留。新增DESKTOP-R50-01由GOAL-R91-C1单次晋升，未把独立复核计成第二项。**这不是当前仍未修复113项的判断。**\n\n剩余审查数量目前不能精确统计。可复算总体台账仍截至冻结45：\n\n| 台账分类 | TS/TSX路径数 | 含义 |\n| --- | ---: | --- |\n| 有同SHA全文记录 | 304 | 保留原审读目的，不等于所有行为正确 |\n| 只有选段记录 | 169 | 不能标为全文 |\n| 无法确认覆盖 | 4170 | 可能含旧读/未适配记录，不能当作未读 |\n\n分母4643含测试及辅助文件；4339=169+4170只表示这份台账不能确认全文的路径数，不是精确剩余工作或剩余bug数。46–50没有倒填，非TS/TSX、运行环境和完整机制不计入该分母；全仓审查尚未完成。[覆盖原说明](../audit-2026-10-17-round47/README.md)。\n\n† 三项在正式44有源码针对原触发条件的处理记录，运行尚未复验；‡ WEB-R8-01有原目录并发源码处理记录，也未运行复验。其他条目没有本稿可用的最新修复状态认证，不能据此断定目前仍未修。\n\n| 原ID（原报告） | 原级别 | 问题简题 |\n| --- | --- | --- |\n'''
footer='''\n† [正式44源码复核](../audit-2026-10-17-round44/evidence/source-status-review/review.md)。原112条逐行来自[正式48清单](../audit-2026-10-17-round48/ALL-ISSUES.md)，没有整体重新运行或修复状态认证。完整机器目录见[113项目录](recorded-findings-catalog.json)，本批新增条件见[正式50说明](README.md)。\n'''
(o/'ALL-ISSUES.md').write_text(intro+'\n'.join(rows)+'\n'+footer)
anchors=[]
for stem,receipt in [('root-scroll-review','reviewer-receipt.json'),('scroll-review','reviewer-receipt.json'),('trace-query-review','reviewer-receipt.json'),('frontier-selection','artifact-receipt.json'),('plugin-presentation','reviewer-receipt.json'),('composer-suggestions','reviewer-receipt.json'),('param-controls','artifact-receipt.json'),('goal-progress','reviewer-receipt.json'),('goal-extend-review','reviewer-receipt.json'),('packet-review','reviewer-receipt.json')]:
 # A packet may use a different unique self-excluded receipt; inspect exact filenames only.
 p=e/stem
 if not (p/receipt).is_file():
  choices=[n for n in ['artifact-receipt.json','reviewer-receipt.json','author-receipt.json'] if (p/n).is_file()];assert len(choices)==1;(receipt,)=choices
 for n in [('review.md' if stem=='goal-extend-review' else 'report.md'),'source-manifest.json',receipt]:
  q=p/n;raw=q.read_bytes();anchors.append({'path':str(q.relative_to(o)),'bytes':len(raw),'sha256':sha(raw)})
put(e/'freeze-checks.json',{'expectedCount':30,'checks':anchors,'scope':'Ten frozen packets report/source-manifest/receipt anchors only; own-author distinctions and original read-time limits retained.'})
print(json.dumps({'catalogRows':113,'P2':44,'P3':69,'tableRows':len(rows),'freezeAnchors':len(anchors)}))
