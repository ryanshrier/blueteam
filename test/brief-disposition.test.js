import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefDisposition, saveBriefDisposition } from '../lib/brief-review.js';
import { listBriefEditions } from '../lib/history.js';
import { briefReadingState } from '../lib/brief-reading-checks.js';
import { sha256 } from '../lib/generation-manifest.js';

let dir; let reviews;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'brief-disposition-'));reviews=join(dir,'reviews');mkdirSync(reviews);});
afterEach(()=>{rmSync(dir,{recursive:true,force:true});});
const first='brief-2026-09-04-01.md';const second='brief-2026-09-05-01.md';

describe('immutable publication disposition and default selection',()=>{
  test('unchecked legacy editions remain eligible while known material errors are excluded only from defaults',()=>{
    writeFileSync(join(dir,first),'first original');writeFileSync(join(dir,second),'second original');
    expect(briefDisposition(first,'first original',reviews)).toMatchObject({status:'eligible',editorialReviewStatus:'not-reviewed'});
    saveBriefDisposition(second,'second original',{status:'review-required',reason:'Verified count contradiction',reviewer:'Auditor'},reviews);
    expect(listBriefEditions(dir,{reviewDirectory:reviews})).toHaveLength(2);
    expect(listBriefEditions(dir,{reviewDirectory:reviews,eligibleOnly:true}).map(item=>item.filename)).toEqual([first]);
    expect(readFileSync(join(dir,second),'utf8')).toBe('second original');
  });
  test('a superseded original links to its replacement and a mismatched hash cannot silently restore eligibility',()=>{
    saveBriefDisposition(first,'first original',{status:'superseded',reason:'Corrected revision available',reviewer:'Auditor',replacementFilename:second},reviews);
    expect(briefDisposition(first,'first original',reviews)).toMatchObject({status:'superseded',replacementFilename:second,eligibleForLatest:false});
    expect(briefDisposition(first,'changed original',reviews)).toMatchObject({status:'review-required',eligibleForLatest:false});
    expect(()=>saveBriefDisposition(first,'first original',{status:'superseded',reason:'Bad target',reviewer:'Auditor',replacementFilename:'../outside'},reviews)).toThrow();
  });
  test('security exceptions require review while old broad editorial flags do not',()=>{
    expect(briefDisposition(first,'first original',reviews,{valid:true,coverage:{materialReviewRequired:false}}).eligibleForLatest).toBe(true);
    expect(briefDisposition(first,'first original',reviews,{valid:false,coverage:{materialReviewRequired:true},issues:[{code:'ACTION_RECOVERY_INCOMPLETE',severity:'review',message:'Recovery branch incomplete',location:{line:53}}]})).toMatchObject({status:'eligible',eligibleForLatest:true});
    expect(briefDisposition(first,'first original',reviews,{issues:[{code:'SECURITY_CONTROL_CHANGE',severity:'review',message:'Control exception',location:{line:53}}]})).toMatchObject({status:'review-required',eligibleForLatest:false,findings:[{line:53}]});
  });
  test('new exact-copy approvals also require the matching verified captured inputs',()=>{
    const original='first original';
    const inputSha256=sha256('captured evidence');
    const checks={issues:[{code:'SECURITY_CONTROL_CHANGE',severity:'review',message:'Control exception'}]};
    const manifest={outputSha256:sha256(original),publicationValidation:checks,
      repairedDraft:{contentSha256:sha256(original),inputSha256}};
    saveBriefDisposition(first,original,{status:'eligible',reason:'Reviewed scope and rollback',reviewer:'Operator',inputSha256},reviews);
    expect(briefDisposition(first,original,reviews).inputSha256).toBe(inputSha256);
    const read=receipt=>briefReadingState(first,original,receipt,{reviewDirectory:reviews});
    expect(read(manifest).disposition).toMatchObject({eligibleForLatest:true,editorialReviewStatus:'reviewed'});
    for(const receipt of [
      {...manifest,repairedDraft:{...manifest.repairedDraft,inputSha256:sha256('different evidence')}},
      {...manifest,repairedDraft:{...manifest.repairedDraft,contentSha256:sha256('different copy')}},
      {...manifest,repairedDraft:undefined},
      {...manifest,outputSha256:sha256('different original')},
      null,
    ]) expect(read(receipt).disposition.eligibleForLatest).toBe(false);
    expect(read(manifest).receipt.validation.issues).toEqual(checks.issues);
  });
  test('legacy approvals stay compatible and malformed new input digests are rejected',()=>{
    const original='first original';
    const manifest={outputSha256:sha256(original),publicationValidation:{issues:[{code:'SECURITY_CONTROL_CHANGE',severity:'review'}]}};
    const approval={status:'eligible',reason:'Reviewed legacy edition',reviewer:'Operator'};
    saveBriefDisposition(first,original,approval,reviews);
    expect(briefReadingState(first,original,manifest,{reviewDirectory:reviews}).disposition.eligibleForLatest).toBe(true);
    for(const inputSha256 of ['', 'not-a-digest', [sha256('evidence')], null]) {
      expect(()=>saveBriefDisposition(first,original,{...approval,inputSha256},reviews)).toThrow('Invalid publication disposition');
    }
  });
});
