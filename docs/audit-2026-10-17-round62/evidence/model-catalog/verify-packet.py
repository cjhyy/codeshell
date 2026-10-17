from pathlib import Path
import json,hashlib,re
out=Path('/tmp/codeshell-audit-round164-model-catalog')
def load(n):return json.loads((out/n).read_text())
m=load('source-manifest.json');c=load('classification.json');e=load('ending-checks.json')
assert c['counts']=={'formal':0,'candidate':0,'newRelated':0}
assert len(m['files'])==12
assert m['counts']['productFiles']==8 and m['counts']['testDeclarationFiles']==2
assert m['counts']['productSemanticLines']==490 and m['counts']['testDeclarationLines']==126
for row in m['files']:
 rs=row['selectedLineRanges'];assert all(1<=a<=z<=row['lines'] for a,z in rs)
 assert sum(z-a+1 for a,z in rs)==row['semanticReadLines']
 if row['coverage']=='full':assert rs==[[1,row['lines']]]
 assert row['initialPinAtUTC']
assert all(x['same'] for x in e['files']+e['metadataFiles'])
excerpts=[]
for n in ['leaf-source-excerpts.json','chain-source-excerpts.json','supplement-source-excerpts.json']:
 for r in load(n):
  b=r['text'].encode();assert len(b)==r['bytes'];assert hashlib.sha256(b).hexdigest()==r['selectedTextSha256'];excerpts.append({'file':n,'sourcePath':r['path'],'range':r.get('range',r.get('selectedLineRanges'))})
links=[]
for label,target in re.findall(r'\[([^\]]+)\]\(([^)]+)\)',(out/'report.md').read_text()):
 assert (out/target).is_file();links.append(target)
result={'classification':'0/0/0','sourceRows':12,'sourceKindCounts':m['counts'],'reportLinkCount':len(links),'allLinksExist':True,'excerptRangeObjectsChecked':len(excerpts),'excerptBytesAndHashesValid':True,'sourceEndingRowsSame':12,'selectedMetadataEndingRowsSame':7,'productExecutions':0,'gitCalls':0,'firstMetadataErrorsPreserved':['finalizer.first.outer-observed.json','finalize-packet.corrected.stderr.txt'],'captureProcessDeviation':'Initial shared schema peek has only observed tool transcript, not separate raw child streams.'}
(out/'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'verified':True,'sourceRows':12,'reportLinks':len(links),'excerptRangeObjectsChecked':len(excerpts)},ensure_ascii=False))
