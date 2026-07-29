export const FIXTURE_CASES = Object.freeze([
  { id: 'kev-one', label: 'KEV · one long row', surface: 'wall' },
  { id: 'kev-six', label: 'KEV · six-row density', surface: 'wall' },
  { id: 'kev-missing', label: 'KEV · missing fields', surface: 'wall' },
  { id: 'wall-loading', label: 'Wall · loading', surface: 'wall' },
  { id: 'wall-stale', label: 'Wall · stale', surface: 'wall' },
  { id: 'wall-judgment', label: 'Wall · Decision timing', surface: 'wall' },
  { id: 'wall-wire-four', label: 'Wall · four-signal Wire', surface: 'wall' },
  { id: 'wire-loading', label: 'Wire · loading', surface: 'operator' },
  { id: 'brief-edition-capture', label: 'Print Edition · clean capture', surface: 'edition' },
  { id: 'brief-showcase', label: 'Briefing · public showcase', surface: 'showcase' },
  { id: 'brief-full', label: 'Briefing · full edition', surface: 'operator' },
  { id: 'brief-error', label: 'Briefing · error', surface: 'operator' },
  { id: 'brief-empty', label: 'Briefing · empty', surface: 'operator' },
]);

function localDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysBefore(now, days) {
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return localDateOnly(date);
}

function hoursBefore(now, hours) {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

export function buildFixtureData(now = new Date()) {
  const longRecord = {
    cve: 'CVE-2026-123456',
    vendor: 'Example Industrial Controls International',
    product: 'Remote Operations Management and Supervisory Control Gateway Enterprise Edition',
    name: 'Improper neutralization of special elements used in an operating system command vulnerability',
    dateAdded: daysBefore(now, 0),
  };

  return {
    'kev-one': {
      added7d: 1,
      added24h: 1,
      recent: [longRecord],
    },
    'kev-six': {
      added7d: 6,
      added24h: 2,
      recent: Array.from({ length: 6 }, (_, index) => ({
        cve: `CVE-2026-${123456 + index}`,
        vendor: index % 2 ? 'Example Network Systems' : 'Example Industrial Controls',
        product: index % 2
          ? 'Enterprise Security Management Console'
          : 'Remote Operations Supervisory Gateway',
        name: index === 0
          ? longRecord.name
          : `Synthetic exploited vulnerability record ${index + 1}`,
        dateAdded: daysBefore(now, Math.floor(index / 2)),
      })),
    },
    'kev-missing': {
      added7d: 0,
      added24h: 0,
      recent: [{ cve: '', vendor: '', product: '', name: '', dateAdded: '' }],
    },
    'wall-stale': {
      added7d: 1,
      added24h: 0,
      recent: [{ ...longRecord, dateAdded: daysBefore(now, 2) }],
    },
    'wall-judgment': {
      horizon: 1,
      title: 'Synthetic ransomware disruption tests production-network resilience',
      line: 'A fictional manufacturing incident shows why response ownership matters more than organization size.',
      assessment: 'The demonstration scenario requires leadership to initiate an IT/OT segmentation review within one week.',
      decision: '7 days.',
      confidence: 'Likely (55-80%)',
      actionShift: {
        owner: null,
        imperative: 'Infrastructure — verify every synthetic gateway, isolate any instance that cannot be validated, and record the disposition for shift handoff — recommended target July 29, 2026.',
      },
      isKEV: true,
      kevCVE: 'CVE-2026-123456',
    },
    'wall-wire-four': {
      signals: [
        {
          horizon: 1,
          title: 'Synthetic gateway flaw enters the exploited-vulnerability catalog',
          description: 'A fictional vendor advisory demonstrates the lead Wire treatment without representing operational intelligence.',
          source: 'Example advisory',
          date: hoursBefore(now, 1),
          urgency: 'critical',
          isKEV: true,
          kevCVE: 'CVE-2026-123456',
          cveData: 'CVE-2026-123456 · CVSS 9.8 (Critical)',
          corroboration: 3,
          vendors: ['Example Industrial Controls'],
          scoreRationale: 'KEV verified · reported by 3 distinct synthetic sources · CVSS 9.8',
        },
        {
          horizon: 1,
          title: 'Identity provider patch closes a synthetic authentication bypass',
          description: 'A second fictional item tests a long supporting headline and metadata treatment.',
          source: 'Example CERT',
          date: hoursBefore(now, 3),
          urgency: 'high',
          corroboration: 2,
          vendors: ['Example Identity'],
        },
        {
          horizon: 2,
          title: 'Public reporting points to changes in credential-theft tradecraft',
          description: 'This demonstration signal exercises the operational horizon.',
          source: 'Example research',
          date: hoursBefore(now, 8),
          urgency: 'medium',
          actors: [{ name: 'Synthetic cluster', region: 'crime' }],
        },
        {
          horizon: 3,
          title: 'Policy proposal could alter long-term disclosure obligations',
          description: 'This demonstration signal exercises the strategic horizon.',
          source: 'Example bulletin',
          date: hoursBefore(now, 30),
          urgency: 'low',
          corroboration: 1,
        },
      ],
    },
  };
}
