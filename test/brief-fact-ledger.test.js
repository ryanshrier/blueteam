import {describe,test,expect} from '@jest/globals';
import {buildBriefFactLedger,repairFindingContext} from '../lib/brief-fact-ledger.js';
import {wholeDocumentReliability} from '../lib/brief-reliability.js';
const cve='CVE-2026-83548', other='CVE-2026-83549';
const records=[{id:'CISA-KEV',cves:new Set([cve,other])},{id:`NVD-${other}`,cves:[other],evidenceText:`${other}: CVSS 7.8 (HIGH)`,url:'https://services.nvd.nist.gov/rest/json/cves/2.0?cveId='+other}];
const timing={[cve]:{dateAdded:'2026-09-02',dueDate:'2026-09-05'},[other]:{dateAdded:'2026-09-02',dueDate:'2026-09-16'}};
const facts=text=>JSON.parse(text.split('\n')[1]);
describe('captured fact ledger',()=>{
 test('keeps separate dates and scores attached to their exact identities',()=>{
   const rows=facts(buildBriefFactLedger({members:records},timing,true));
   expect(rows[0]).toMatchObject({cve,kev:'listed',fcebDue:'2026-09-05'});
   expect(rows[0]).not.toHaveProperty('nvdScore');
   expect(rows[1]).toMatchObject({cve:other,fcebDue:'2026-09-16',nvdScore:7.8});
 });
 test('does not manufacture catalog absence or dates when catalog is unavailable',()=>{
   const rows=facts(buildBriefFactLedger({sources:records},timing,false));
   expect(rows.every(row=>row.kev==='unknown'&&!('fcebDue'in row))).toBe(true);
 });
 test('missing captured timing stays unknown even for verified membership',()=>{
   expect(facts(buildBriefFactLedger({members:records},{},true))[0]).toMatchObject({kev:'listed',fcebDue:null});
 });
 test('repair retains the offending passage and editorial findings',()=>{
   expect(repairFindingContext([{code:'FACT_PRODUCT_COUNT_MISMATCH',severity:'review',message:'Wrong count',location:{line:12,excerpt:'Five products: A, B, C and D'}}])[0]).toMatchObject({line:12,passage:'Five products: A, B, C and D',severity:'review'});
 });
});
test('observed five-versus-four product enumeration is caught without counting parenthetical commas',()=>{
 const line='**Threat:** Five distinct products under exploitation: browser (Chrome V8), edge VPN appliance (SonicWall SMA1000), VoIP (Sangoma Switchvox), and repositories (JFrog Artifactory) — all listed this week.';
 expect(wholeDocumentReliability(line).issues.map(i=>i.code)).toContain('FACT_PRODUCT_COUNT_MISMATCH');
 expect(wholeDocumentReliability(line.replace('Five','Four')).issues.map(i=>i.code)).not.toContain('FACT_PRODUCT_COUNT_MISMATCH');
 expect(wholeDocumentReliability('Five products, including: Chrome and SonicWall').issues.map(i=>i.code)).not.toContain('FACT_PRODUCT_COUNT_MISMATCH');
});

test('token rotation dates require a lookback basis with written month dates too',()=>{
 const action='Application security — rotate all admin tokens issued since August 28, 2026.';
 expect(wholeDocumentReliability(action).issues.map(i=>i.code)).toContain('ACTION_LOOKBACK_BASIS_REQUIRED');
 expect(wholeDocumentReliability(action+' Proposed lookback basis: earliest possible exposure; verify retention.').issues.map(i=>i.code)).not.toContain('ACTION_LOOKBACK_BASIS_REQUIRED');
});
