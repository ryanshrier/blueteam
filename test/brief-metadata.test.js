import { expect, test } from '@jest/globals';
import { extractBriefMetadata } from '../lib/brief-metadata.js';

const metadata = { schemaVersion: 1, executiveActions: [{ decision: 1, actionIds: ['S1.A1'] }], coverage: [{ priorityId: 'P1', status: 'deferred', reason: 'Evidence conflicts; verify the affected release.' }] };
const block = value => `<!-- briefing-metadata\n${JSON.stringify(value)}\n-->`;
test('separates bookkeeping from reader prose and retains only supported metadata fields', () => {
  const result = extractBriefMetadata(`# Report\n\n${block({ ...metadata, ignored: 'untrusted' })}`);
  expect(result).toEqual({ content: '# Report', metadata, issues: [] });
});
test('legacy or edited prose can reuse a captured mapping without requiring generated markup', () => {
  expect(extractBriefMetadata('# Report', metadata)).toEqual({ content: '# Report', metadata, issues: [] });
  expect(extractBriefMetadata('# Report').metadata).toBeNull();
});
test.each([
  '<!-- briefing-metadata {broken} -->',
  '<!-- briefing-metadata {"schemaVersion":1}',
  `${block(metadata)}\n${block(metadata)}`,
  block({ ...metadata, executiveActions: [{ decision: 1, actionIds: 'S1.A1' }] }),
  block({ ...metadata, coverage: [{ priorityId: 'P1', status: 'deferred', reason: 'a'.repeat(25000) }] }),
])('rejects invalid records without leaking markup into reader content', bad => {
  const result = extractBriefMetadata(`# Report\n\n${bad}`, metadata);
  expect(result.content).toBe('# Report');
  expect(result.metadata).toBeNull();
  expect(result.issues.map(issue => issue.code)).toEqual(['BRIEF_METADATA_INVALID']);
});
