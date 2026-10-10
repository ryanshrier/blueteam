import { parseArgs } from 'node:util';
import { resolve, relative, isAbsolute } from 'node:path';
import { writeFileSync } from 'node:fs';
import { replayBriefArchive } from '../lib/brief-replay.js';

const { values } = parseArgs({ options: { archive: { type: 'string', default: 'briefs' }, limit: { type: 'string', default: '100' }, output: { type: 'string' } } });
const archive = resolve(values.archive);
const report = replayBriefArchive(archive, { limit: Number(values.limit) });
if (values.output) {
  const output = resolve(values.output);
  const rel = relative(archive, output);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Replay output must be outside the archive');
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Report: ${output}`);
}
console.log(JSON.stringify(report.summary, null, 2));
console.log('Read-only replay completed; no provider calls. Findings are diagnostics, not edits or publication decisions.');
if (report.summary.unreplayable || report.drafts.some(draft => draft.status === 'unreplayable')) process.exitCode = 1;
