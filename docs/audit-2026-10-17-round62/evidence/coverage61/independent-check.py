"""Second implementation checks metadata using integer sets, not adapter imports."""
from pathlib import Path
from collections import Counter,defaultdict
import hashlib,json,io,contextlib,traceback

P=Path('/tmp/codeshell-audit-round163-coverage61')
R=Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
def load(name): return json.loads((P/name).read_text())
def digest(b): return hashlib.sha256(b).hexdigest()
def save(name,j): (P/name).write_text(json.dumps(j,ensure_ascii=False,indent=2)+'\n')
def lines(ranges,eof):
    assert isinstance(ranges,list)
    out=set()
    for pair in ranges:
        assert isinstance(pair,list) and len(pair)==2
        lo,hi=pair
        assert type(lo) is int and type(hi) is int and 1<=lo<=hi<=eof
        span=set(range(lo,hi+1))
        assert not (out&span)
        out|=span
    return out
def main():
    pins=load('initial-metadata-pins.json')['files']
    docs={}
    for pin in pins:
        b=(R/pin['path']).read_bytes()
        assert len(b)==pin['bytes'] and digest(b)==pin['sha256']
        if pin['path'].endswith('.json'): docs[pin['path']]=json.loads(b)
    base_path=[p for p in docs if p.endswith('unified-current-index.json')][0]
    base=docs[base_path]['files']
    inventory={r['path']:r for r in load('current-source-inventory.json')['files']}
    accepted=[];rejects=[];nonsemantic=[]
    for doc_path,doc in docs.items():
        if doc_path==base_path: continue
        for i,row in enumerate(doc['files']):
            key=(doc_path,'/files/'+str(i))
            if row.get('coverage') not in ('full','selected'):
                nonsemantic.append(key);continue
            try:
                current=inventory[row['path']]
                assert row['sha256']==current['sha256'] and row['bytes']==current['bytes']
                eof=current['lines']
                for name in ('lineCount','lines'):
                    if name in row: assert row[name]==eof
                semantic=lines(row['selectedLineRanges'],eof)
                assert semantic
                values=[row[n] for n in ('semanticLines','semanticLineCount') if n in row]
                assert values and all(n==len(semantic) for n in values)
                body=lines(row['bodyDisplayedLineRanges'],eof)
                nav=lines(row.get('additionalNavigationSnippetLineRanges',[]),eof)
                values=[row[n] for n in ('bodyDisplayedLines','bodyDisplayedLineCount') if n in row]
                assert values and all(n==len(body) for n in values)
                displayed=body|nav
                if 'displayedLineRanges' in row:
                    assert lines(row['displayedLineRanges'],eof)==displayed
                    assert row['displayedLineCount']==len(displayed)
                assert semantic<=displayed
                if row['coverage']=='full':
                    assert semantic==set(range(1,eof+1))
                    assert row.get('semanticFull') is not False
                    assert not row.get('fullBodyDisplayedButNotFullSemanticClaim',False)
                else: assert row.get('semanticFull') is not True
                accepted.append((key,row))
            except (AssertionError,KeyError,TypeError,ValueError): rejects.append(key)
    claims=load('semantic-claims.json')['files']
    actual={(c['locator']['metadataPath'],c['locator']['jsonPointer']):c for c in claims}
    expected=dict(accepted)
    assert set(actual)==set(expected)
    for key,row in accepted:
        claim=actual[key]
        assert claim['originalObject']==row
        assert claim['purpose']==row.get('scope',row.get('scopeBoundary'))
        assert claim['coverage']==row['coverage']
        assert claim['semanticLineRanges']==row['selectedLineRanges']
        assert claim['testDeclarationOnly']==(row.get('category')=='test-declaration')
    assert set(rejects)=={(r['locator']['metadataPath'],r['locator']['jsonPointer']) for r in load('deferred-rows.json')['rows']}
    assert set(nonsemantic)=={(r['locator']['metadataPath'],r['locator']['jsonPointer']) for r in load('excluded-rows.json')['rows']}
    explicit=defaultdict(set)
    for key,row in accepted: explicit[row['path']].add(row['coverage'])
    desired={}
    changed=set()
    for row in base:
        old=row['publishableCurrentCoverage']
        states=explicit.get(row['path'],set())|{old}
        new='full' if 'full' in states else 'selected' if 'selected' in states else 'unknown'
        desired[row['path']]=new
        if new!=old: changed.add(row['path'])
    final=load('unified-current-index.json')['files']
    assert len(final)==len(desired)==4643
    assert {r['path']:r['publishableCurrentCoverage'] for r in final}==desired
    assert {r['path'] for r in load('transitions.json')['files']}==changed
    counts=dict(Counter(desired.values()))
    assert counts==load('summary.json')['counts']
    full=[]
    for key,row in accepted:
        if row['coverage']=='full':
            old=next(r['publishableCurrentCoverage'] for r in base if r['path']==row['path'])
            full.append({'path':row['path'],'locator':{'metadataPath':key[0],'jsonPointer':key[1]},'before':old,'after':'full','purpose':row.get('scope',row.get('scopeBoundary')),'explicitEOFWholeRecord':True,'newUniqueRead':False})
    check={'role':'Independent second implementation of metadata rules, not peer or source review','passed':True,'metadataPinCount':len(pins),'basePathCount':len(base),'acceptedRows':len(accepted),'excludedRows':len(nonsemantic),'deferredRows':len(rejects),'uniqueSemanticPaths':len(explicit),'transitionCount':len(changed),'counts':counts,'notFull':4643-counts['full'],'newFullPurposeChecks':full,'checks.files':[],'productSourceSemantics':0,'productExecution':0,'Git':0,'didNotImportOrExecuteAdapter':True}
    save('independent-checks.json',check)
    print(json.dumps(check,ensure_ascii=False,indent=2))

stdout,stderr=io.StringIO(),io.StringIO();code=0
try:
    with contextlib.redirect_stdout(stdout),contextlib.redirect_stderr(stderr):main()
except BaseException:
    code=1;traceback.print_exc(file=stderr)
(P/'independent-first.stdout').write_text(stdout.getvalue())
(P/'independent-first.stderr').write_text(stderr.getvalue())
save('independent-first.exit.json',{'exitCode':code,'method':'independent-check.py','methodSHA256':digest(Path(__file__).read_bytes()),'kind':'metadata checker only; never product or adapter execution'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(stdout.getvalue().encode()),'stderrBytes':len(stderr.getvalue().encode())}))
