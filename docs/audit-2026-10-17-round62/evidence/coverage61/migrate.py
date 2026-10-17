"""Independent standard-library metadata adapter; never imports product modules."""
from pathlib import Path
from collections import Counter, defaultdict
import copy, datetime, hashlib, io, contextlib, json, re, traceback

ROOT = Path('/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell')
OUT = Path('/tmp/codeshell-audit-round163-coverage61')
BASE = 'docs/audit-2026-10-17-round61/evidence/coverage-migration/unified-current-index.json'
SNAPSHOT = OUT / 'manifest-schema-snapshot.json'
LEVEL = {'unknown':0, 'selected':1, 'full':2}

def sha(data): return hashlib.sha256(data).hexdigest()
def save(name,value): (OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def stamp(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def merge(ranges):
    result=[]
    for lo,hi in sorted(ranges):
        if result and lo<=result[-1][1]+1: result[-1][1]=max(result[-1][1],hi)
        else: result.append([lo,hi])
    return result
def count(ranges): return sum(hi-lo+1 for lo,hi in merge(ranges))
def parse_ranges(value,eof,label,issues):
    if not isinstance(value,list): issues.append(label+': expected explicit list'); return []
    okay=[]
    for pair in value:
        if not isinstance(pair,list) or len(pair)!=2 or any(type(n) is not int for n in pair):
            issues.append(label+': malformed integer range'); continue
        lo,hi=pair
        if not (1<=lo<=hi<=eof): issues.append(label+': outside EOF '+str(pair)); continue
        okay.append(pair)
    if okay!=merge(okay): issues.append(label+': overlapping, adjacent or unordered canonical ranges')
    return merge(okay)
def main():
    base_bytes=(ROOT/BASE).read_bytes()
    pins=json.loads((OUT/'initial-metadata-pins.json').read_text())['files']
    expected={r['path']:r for r in pins}
    if sha(base_bytes)!=expected[BASE]['sha256']: raise ValueError('base metadata drift before adapter')
    base=json.loads(base_bytes)
    files=base['files']
    by_path={r['path']:r for r in files}
    assert len(files)==len(by_path)==4643
    before=Counter(r['publishableCurrentCoverage'] for r in files)
    assert dict(before)=={'unknown':3934,'selected':354,'full':355}
    inventory=[]
    for rel,old in sorted(by_path.items()):
        data=(ROOT/rel).read_bytes()
        line_count=data.count(b'\n')+int(bool(data) and not data.endswith(b'\n'))
        row={'path':rel,'bytes':len(data),'sha256':sha(data),'lines':line_count,'matchesBaseSHA':sha(data)==old['sha256'],'matchesBaseBytes':len(data)==old['bytes']}
        inventory.append(row)
    save('current-source-inventory.json',{'atUTC':stamp(),'role':'raw bytes/hash/EOF only, no source semantic body read','denominator':4643,'files':inventory})
    current={r['path']:r for r in inventory}
    drift=[r for r in inventory if not r['matchesBaseSHA'] or not r['matchesBaseBytes']]
    if drift: raise ValueError('base source byte drift '+str([r['path'] for r in drift]))
    documents=json.loads(SNAPSHOT.read_text())['documents']
    accepted=[]; excluded=[]; deferred=[]; all_rows=[]
    per_document=[]
    for doc in documents:
        rel=doc['path']
        original=(ROOT/rel).read_bytes()
        if sha(original)!=expected[rel]['sha256']: raise ValueError('manifest drift '+rel)
        original_json=json.loads(original)
        assert doc['files']==original_json['files']
        states=Counter()
        for index,row in enumerate(doc['files']):
            locator={'metadataPath':rel,'metadataSHA256':sha(original),'jsonPointer':'/files/'+str(index)}
            record={'locator':locator,'originalObject':row,'path':row.get('path'),'declaredCoverage':row.get('coverage')}
            all_rows.append(record)
            coverage=row.get('coverage')
            if coverage not in ('full','selected'):
                record['reason']='explicit '+str(coverage)+' is not semantic full/selected; no display, hash, navigation or instruction promotion'
                excluded.append(record); states['excluded']+=1; continue
            path=row.get('path'); issues=[]
            if path not in current: issues.append('outside original4643 universe')
            if path not in current:
                record['issues']=issues; deferred.append(record); states['deferred']+=1; continue
            now=current[path]
            if not isinstance(row.get('sha256'),str) or not re.fullmatch('[0-9a-f]{64}',row['sha256']): issues.append('not direct valid sha256 field')
            if row.get('sha256')!=now['sha256']: issues.append('source SHA is not current exact SHA')
            if row.get('bytes')!=now['bytes']: issues.append('source bytes mismatch')
            line_aliases=[row[k] for k in ('lines','lineCount') if k in row]
            if not line_aliases or any(n!=now['lines'] for n in line_aliases): issues.append('declared line count mismatch or absent')
            for key in ('endingSha256',):
                if key in row and row[key]!=row.get('sha256'): issues.append(key+' differs from read SHA')
            ranges=parse_ranges(row.get('selectedLineRanges'),now['lines'],'selectedLineRanges',issues)
            if not ranges: issues.append('semantic ranges empty')
            n=count(ranges)
            semantic_counts=[row[k] for k in ('semanticLineCount','semanticLines') if k in row]
            if not semantic_counts or any(x!=n for x in semantic_counts): issues.append('semantic count mismatch or absent')
            if coverage=='full' and (ranges!=[[1,now['lines']]] or row.get('semanticFull') is False or row.get('fullBodyDisplayedButNotFullSemanticClaim') is True): issues.append('explicit full conflicts with EOF or semantic limitation')
            if coverage=='selected' and row.get('semanticFull') is True: issues.append('selected conflicts with semanticFull true')
            body=parse_ranges(row.get('bodyDisplayedLineRanges'),now['lines'],'bodyDisplayedLineRanges',issues)
            body_counts=[row[k] for k in ('bodyDisplayedLineCount','bodyDisplayedLines') if k in row]
            if not body_counts or any(x!=count(body) for x in body_counts): issues.append('body display count mismatch or absent')
            navigation=parse_ranges(row.get('additionalNavigationSnippetLineRanges',[]),now['lines'],'additionalNavigationSnippetLineRanges',issues)
            displayed=merge(body+navigation)
            if 'displayedLineRanges' in row:
                displayed=parse_ranges(row['displayedLineRanges'],now['lines'],'displayedLineRanges',issues)
                if displayed!=merge(body+navigation): issues.append('display body/navigation union mismatch')
                if row.get('displayedLineCount')!=count(displayed): issues.append('total display count mismatch')
            if count(merge(displayed+ranges))!=count(displayed): issues.append('semantic ranges not contained in actual body/navigation display union')
            if issues:
                record['issues']=issues
                record['validSemanticRangesRetainedForDiagnosisOnly']=ranges
                record['policy']='Conservatively defer this entire metadata row; other valid canonical rows may support the same path.'
                deferred.append(record); states['deferred']+=1; continue
            claim={'id':'61-'+str(len(accepted)+1).zfill(3),'path':path,'sha256':now['sha256'],'bytes':now['bytes'],'lines':now['lines'],'coverage':coverage,'semanticLineRanges':ranges,'semanticLineCount':n,'purpose':row.get('scope',row.get('scopeBoundary')),'testDeclarationOnly':row.get('category')=='test-declaration','newUniqueSourceReadClaim':False,'locator':locator,'originalObject':row,'preserveSourceLimitationsVerbatim':True,'explicitSemanticRangeOutsideBodyButWithinNavigationDisplay':count(merge(body+ranges))!=count(body),'noNavigationOnlyRangePromoted':True}
            accepted.append(claim); states['accepted']+=1
        per_document.append({'path':rel,'filesCount':len(doc['files']),'rowStates':dict(states)})
    grouped=defaultdict(list)
    for claim in accepted: grouped[claim['path']].append(claim)
    updated=copy.deepcopy(base)
    updated.update({'atUTC':stamp(),'status':'conservative canonical formal61 metadata migration; no new source reading','rootReportedByteBaselineOnly':'d195788bc2c18cd85c81aea4a431ab29074df5cf','gitCertified':False,'productSemanticReads':0,'baseIndex':{'path':BASE,'bytes':len(base_bytes),'sha256':sha(base_bytes)},'noSelectedUnionPromotionToFull':True})
    transitions=[]; retained=[]
    for row in updated['files']:
        claims=grouped.get(row['path'],[])
        old=row['publishableCurrentCoverage']
        strongest=max([old]+[c['coverage'] for c in claims],key=LEVEL.__getitem__)
        row['baseFormal61PublishableCoverage']=old
        row['formal61SemanticClaimIds']=[c['id'] for c in claims]
        row['formal61SelectedRangeUnion']=merge([r for c in claims for r in c['semanticLineRanges']])
        row['formal61RangeUnionDoesNotAutoPromoteFull']=True
        row['publishableCurrentCoverage']=strongest
        if claims:
            detail={'path':row['path'],'sha256':row['sha256'],'before':old,'after':strongest,'claimIds':[c['id'] for c in claims],'canonicalLocators':[c['locator'] for c in claims],'originalPurposeAndLimitsInClaims':True,'notFirstSourceReadClaim':True}
            (transitions if strongest!=old else retained).append(detail)
    after=Counter(r['publishableCurrentCoverage'] for r in updated['files'])
    save('canonical-row-review.json',{'documents':per_document,'rowCount':len(all_rows),'rows':all_rows})
    save('semantic-claims.json',{'role':'Canonical metadata extraction; not new source semantic evidence','files':accepted})
    save('excluded-rows.json',{'count':len(excluded),'rows':excluded})
    save('deferred-rows.json',{'count':len(deferred),'rows':deferred})
    save('transitions.json',{'count':len(transitions),'files':transitions})
    save('retained-status-provenance.json',{'count':len(retained),'files':retained})
    save('unified-current-index.json',updated)
    full=[c for c in accepted if c['coverage']=='full']
    save('new-full-purpose-review.json',{'meaning':'Full-text metadata coverage within each original purpose; no full-behavior or runtime certification','count':len(full),'files':full})
    summary={'atUTC':stamp(),'baseCounts':dict(before),'counts':dict(after),'denominator':len(files),'notFull':len(files)-after['full'],'rowCount':len(all_rows),'acceptedRows':len(accepted),'uniqueAcceptedPaths':len(grouped),'excludedRows':len(excluded),'deferredRows':len(deferred),'transitionCount':len(transitions),'retainedStatusPaths':len(retained),'fullEvidenceRows':len(full),'testDeclarationRows':sum(c['testDeclarationOnly'] for c in accepted),'sourceByteDrift':len(drift),'documents':per_document,'productSemanticReadCount':0,'productExecutionCount':0,'GitOperations':0,'independentPeerReviewDelivered':False}
    save('summary.json',summary)
    print(json.dumps(summary,ensure_ascii=False,indent=2))

out,err=io.StringIO(),io.StringIO(); code=0
try:
    with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err): main()
except BaseException:
    code=1; traceback.print_exc(file=err)
(OUT/'migration-second.stdout').write_text(out.getvalue())
(OUT/'migration-second.stderr').write_text(err.getvalue())
save('migration-second.exit.json',{'exitCode':code,'method':'migrate.py','methodSHA256':sha(Path(__file__).read_bytes()),'kind':'Independent standard-library metadata adapter; no product execution; preserve migration-first outputs'})
print(json.dumps({'exitCode':code,'stdoutBytes':len(out.getvalue().encode()),'stderrBytes':len(err.getvalue().encode())}))
