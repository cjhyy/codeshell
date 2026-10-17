from pathlib import Path
import json,re,hashlib,datetime
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell');O=Path('/tmp/codeshell-audit-round162-user-status');p=O/'checks.json';before=p.read_bytes();(O/'checks.first.json').write_bytes(before);d=json.loads(before);cat=json.loads((R/'docs/audit-2026-10-17-round58/recorded-findings-catalog.json').read_text());md=(R/'docs/audit-2026-10-17-round58/ALL-ISSUES.md').read_text();rows={}
for line in md.splitlines():
 m=re.match(r'^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(P[0-3])\s*\|\s*(.*?)\s*\|\s*$',line)
 if m:rows[m[1]]={'link':m[2],'priority':m[3],'title':m[4].replace('\\|','|')}
def clean(t):return re.sub(r'^\[P[0-3][^\]]*\]\s*','',t).strip()
mis=[]
for x in cat['findings']:
 y=rows[x['id']];link=y['link']
 if '/docs/' in link:target=link[link.find('/docs/')+1:]
 else:target=str((Path('docs/audit-2026-10-17-round58')/link))
 if x['priority']!=y['priority'] or clean(x['title'])!=y['title'] or x['canonicalFindings']!=target:mis.append({'id':x['id'],'reason':'normalized mismatch','target':target})
d['allTitlePriorityCanonicalMappingsSame']=not mis;d['mismatches']=mis;d['normalizationClarification']='Original title prefix including dated evidence qualifier removed only for display comparison; catalog raw values untouched. Relative Markdown canonical target resolved at formal58 directory.';p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
(O/'catalog-normalization.json').write_text(json.dumps({'atUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'firstCheck':'checks.first.json','firstSha256':hashlib.sha256(before).hexdigest(),'firstDifferences':json.loads(before)['mismatches'],'activeNormalizedMismatches':mis,'sourceFilesModified':False,'canonicalRawTitlesPreserved':True,'productExecution':0,'git':0},ensure_ascii=False,indent=2)+'\n')
lines=['118条正式历史记录（不是当前未修数；按原catalog顺序）','字段：ID | 级别 | 历史标题 | 来源批次 | canonical原件','']
for x in cat['findings']:lines.append(f"{x['id']} | {x['priority']} | {clean(x['title'])} | R{x['sourceRound']} | {x['canonicalFindings']}")
(O/'all118-historical-findings.txt').write_text('\n'.join(lines)+'\n');assert not mis;print('All118 normalized ID/priority/title/canonical mappings agree; originals unchanged')
