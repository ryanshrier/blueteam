// Audit ranking and operator outcomes using a real input manifest and an
// optional Wire JSON export. Read-only; no collection or paid generation.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { headlineCves, normalizeFeedTimestamp } from '../lib/intelligence-context.js';
import { deduplicateWithCorroboration } from '../lib/feeds.js';

const args = process.argv.slice(2);
const value = key => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : null; };
const manifestPath = resolve(value('--manifest') || 'briefs/brief-2026-09-05-02.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(manifest.selectedEvidence)) throw new Error('Expected an actual Briefing input manifest with selectedEvidence.');
const member = row => ({ ...row, link: row.url, date: row.publishedAt, passage: typeof row.passage === 'string' ? row.passage : row.passage?.text || '' });
const selected = manifest.selectedEvidence.map(row => {
  const members = (row.groupMembers || []).map(member);
  return { ...member(row), ...row.enrichment, passage: members[0]?.passage || row.passage?.text || '', sourceMembers: members, evidence: row.sourceRevisions || [] };
});
const grouped = deduplicateWithCorroboration(selected, 0.5);
const knownDates = selected.map(row => normalizeFeedTimestamp(row.date));
const captured = Date.parse(manifest.capturedAt);
const report = {
  manifest: manifestPath, capturedAt: manifest.capturedAt,
  inputs: selected.length, groupedDevelopments: grouped.length,
  repeatedSlotsRecoverable: selected.length - grouped.length,
  normalizedDates: knownDates.filter(Boolean).length,
  inputsOlderThan72HoursAtCapture: knownDates.filter(date => date && captured - Date.parse(date) > 72 * 3600_000).length,
  cveReportingWithUnknownSeverity: selected.filter(row => headlineCves(row).length && !row.cveData?.length).length,
  evaluationScope: 'Retained collection replay. Counts describe coverage and duplication, not ranking accuracy or independent confirmation.',
};
if (value('--decisions')) {
  const exported = JSON.parse(readFileSync(resolve(value('--decisions')), 'utf8'));
  if (!Array.isArray(exported)) throw new Error('Expected the JSON array exported by Wire.');
  const states = ['unreviewed', 'investigate', 'affected', 'unaffected', 'mitigated'];
  const counts = Object.fromEntries(states.map(state => [state, exported.filter(row => (row.decision?.state || 'unreviewed') === state).length]));
  const outcome = row => ['affected', 'unaffected', 'mitigated'].includes(row.decision?.state);
  const ordered = [...exported].sort((a, b) => (b.score || 0) - (a.score || 0));
  report.operatorOutcomes = { totalExported: exported.length, counts,
    topTenWithRecordedOutcome: ordered.slice(0, 10).filter(outcome).length,
    topTenAffectedOrMitigated: ordered.slice(0, 10).filter(row => ['affected', 'mitigated'].includes(row.decision?.state)).length,
    outstandingInvestigationsWithoutOwner: exported.filter(row => row.decision?.state === 'investigate' && !row.decision?.owner).length,
    limitation: 'These are operator-entered assessments of the exported selection. Unreviewed rows are not negative labels. Missed events and population-level ranking accuracy require an independently reviewed comparison set.',
  };
} else report.operatorOutcomes = { available: false, nextStep: 'Record applicability and action outcomes in Wire, export JSON, then pass --decisions <file>. No decision-quality score is inferred from clicks.' };
console.log(JSON.stringify(report, null, 2));
