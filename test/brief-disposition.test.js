import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefDisposition, saveBriefDisposition } from '../lib/brief-review.js';
import { listBriefEditions } from '../lib/history.js';

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
  test('material review findings in a verified receipt are distinct from missing editorial approval',()=>{
    expect(briefDisposition(first,'first original',reviews,{valid:true,coverage:{materialReviewRequired:false}}).eligibleForLatest).toBe(true);
    expect(briefDisposition(first,'first original',reviews,{valid:false,coverage:{materialReviewRequired:true},issues:[{code:'ACTION_RECOVERY_INCOMPLETE',severity:'review',message:'Recovery branch incomplete',location:{line:53}}]})).toMatchObject({status:'review-required',eligibleForLatest:false,findings:[{line:53}]});
  });
});
