import { describe, expect, test } from '@jest/globals';
import { groupEvidenceEvents, diversifyEvidenceRequests, budgetEvidenceRequests } from '../lib/evidence-events.js';

const report = (number, overrides = {}) => ({ title: `Acme CVE-2026-${number} requires remediation`,
  description: 'The vendor released an update.', date: '2026-10-09T10:00:00Z', link: `https://example.test/${number}`, ...overrides });

describe('distinct evidence event capacity', () => {
  test('spends first requests on distinct developments before publisher copies', () => {
    const first = report(1234), duplicate = report(1234, { link: 'https://second.test/report' }), second = report(5678);
    expect(diversifyEvidenceRequests([first, duplicate, second])).toEqual([first, second, duplicate]);
    expect(groupEvidenceEvents([first, duplicate, second]).map(group => group.members.length)).toEqual([2, 1]);
  });

  test('groups a sparse unpatched exploitation report using product and development identity', () => {
    const inputs = [report(1234, { title: 'Unpatched AhsayCBS flaws exploited to deploy webshells', description: 'Threat actors are exploiting the backup platform.' }),
      report(5678, { title: 'Unpatched AhsayCBS Vulnerabilities Exploited in the Wild', description: 'CVE-2026-105133 and CVE-2026-105134 allow code execution.' })];
    expect(groupEvidenceEvents(inputs)[0].bases).toContain('same-product-unpatched-exploitation');
    expect(groupEvidenceEvents(inputs)).toHaveLength(1);
    inputs.push(report(9999, { title: 'Threat actors exploit AhsayCBS flaws to drop webshells', description: 'CVE-2026-105133 and CVE-2026-105134 are used by the attackers.' }));
    expect(groupEvidenceEvents(inputs)).toHaveLength(1);
    expect(groupEvidenceEvents([...inputs, { ...inputs[2], link: 'https://new.test/campaign', title: 'New campaign exploits AhsayCBS flaws to drop webshells' }])).toHaveLength(2);
  });

  test('never collapses a bypass, new campaign, separate CVE, or undated report', () => {
    for (const extra of [{ title: 'Acme patch bypass for CVE-2026-1234' }, { title: 'Acme new campaign exploiting CVE-2026-1234' },
      { title: 'Acme CVE-2026-9999' }, { date: '' }, { date: '2026-09-01T10:00:00Z' }]) {
      expect(groupEvidenceEvents([report(1234), report(1234, { link: 'https://second.test/report', ...extra })])).toHaveLength(2);
    }
  });

  test('keeps overlapping multi-CVE developments separate and does not bridge groups', () => {
    const inputs = [report(1234), report(5678), report(9012, { title: 'CVE-2026-1234 and CVE-2026-5678' })];
    expect(groupEvidenceEvents(inputs)).toHaveLength(3);
  });

  test('exploration reservation cannot consume capacity with a duplicate event', () => {
    const ordinary = Array.from({ length: 6 }, (_, index) => report(1234 + index));
    const duplicate = { ...ordinary[0], link: 'https://copy.test/report', selectionInvestigation: true };
    const investigation = report(9999, { selectionInvestigation: true });
    const selected = budgetEvidenceRequests([...ordinary, duplicate, investigation], 5);
    expect(selected).toHaveLength(5);
    expect(selected).toContain(investigation);
    expect(selected).not.toContain(duplicate);
    expect(groupEvidenceEvents(selected)).toHaveLength(5);
  });
});
