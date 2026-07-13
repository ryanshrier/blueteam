import { describe, test, expect } from '@jest/globals';
import { matchActors, matchVendors, tagEntities, enrichIOCs } from '../lib/enrichment.js';

// Entity tagging is a heuristic inference; these guard the two ways it can lie:
// a false attribution (negation/contrast) and an overstated mention (a passing
// body reference read as the story's subject). Both now carry explicit provenance.

describe('matchActors — provenance basis', () => {
  test('an actor named in the title carries basis "title"', () => {
    const out = matchActors('Lazarus Group hits crypto exchange', '');
    expect(out).toEqual([{ name: 'Lazarus', region: 'KP', basis: 'title' }]);
  });

  test('an actor only in the body carries basis "mention"', () => {
    const out = matchActors('Crypto exchange breached', 'Researchers compared the TTPs to Lazarus operations.');
    expect(out.find(a => a.name === 'Lazarus')?.basis).toBe('mention');
  });

  test('a headline name outranks a body mention (basis stays "title")', () => {
    const out = matchActors('Lazarus blamed for heist', 'Lazarus surfaced again this week');
    expect(out.find(a => a.name === 'Lazarus')?.basis).toBe('title');
  });
});

describe('matchActors — negation guard', () => {
  test('drops an actor a report explicitly rules out', () => {
    expect(matchActors('Breach not linked to Lazarus, CISA says', '')).toEqual([]);
  });

  test('drops a contrastive "unlike" mention', () => {
    const out = matchActors('New crew, unlike APT28, uses commodity malware', '');
    expect(out.find(a => a.name === 'APT28')).toBeUndefined();
  });

  test('keeps a plain attribution', () => {
    expect(matchActors('APT28 phishing campaign expands', '').map(a => a.name)).toContain('APT28');
  });
});

describe('matchVendors — negation guard', () => {
  test('tags a plainly-named vendor', () => {
    expect(matchVendors('Cisco patches critical flaw')).toContain('Cisco');
  });

  test('drops a negated vendor mention', () => {
    expect(matchVendors('Flaw does not affect Cisco gear')).not.toContain('Cisco');
  });
});

describe('tagEntities', () => {
  test('writes provenance basis onto tagged actors', () => {
    const hs = [{ title: 'Sandworm targets the grid', description: '' }];
    tagEntities(hs);
    expect(hs[0].actors[0]).toMatchObject({ name: 'Sandworm', basis: 'title' });
  });
});

// A bare common-word vendor name ("Progress") false-positived on
// ordinary prose. Fixed by listing the unambiguous product/company name
// instead; these guard the fix stays in place and doesn't regress to the
// bare word.
describe('matchVendors — common-word vendor names', () => {
  test('does not tag Progress Software off the ordinary word "progress"', () => {
    expect(matchVendors('CISA reports progress on secure-by-design initiatives')).not.toContain('Progress Software');
  });

  test('still tags a plainly-named "Progress Software" mention', () => {
    expect(matchVendors('Progress Software patches WS_FTP flaw')).toContain('Progress Software');
  });

  test('does not tag Elastic off unrelated prose ("elastic demand", etc.)', () => {
    expect(matchVendors('Cloud providers see elastic demand during the holiday surge')).not.toContain('Elasticsearch');
  });

  test('still tags a plainly-named Elasticsearch mention', () => {
    expect(matchVendors('Elasticsearch cluster exposed without authentication')).toContain('Elasticsearch');
  });
});

// The actor map's aliases were mostly empty, so a week of
// reporting under a vendor's OWN designator (e.g. Microsoft's "Seashell
// Blizzard" for Sandworm) registered zero activity for the tracked group.
describe('matchActors — refreshed alias coverage', () => {
  test('Seashell Blizzard resolves to Sandworm', () => {
    const out = matchActors('Seashell Blizzard targets energy sector', '');
    expect(out.map(a => a.name)).toContain('Sandworm');
  });

  test('UNC3944 resolves to Scattered Spider', () => {
    const out = matchActors('UNC3944 breaches helpdesk via social engineering', '');
    expect(out.map(a => a.name)).toContain('Scattered Spider');
  });

  test('a generic Storm-#### interim designator is tagged unattributed', () => {
    const out = matchActors('Storm-1234 phishing campaign targets finance sector', '');
    expect(out.find(a => a.region === 'unattributed')).toBeDefined();
  });

  test('a generic UNC##### interim designator is tagged unattributed', () => {
    const out = matchActors('UNC5221 exploits edge device zero-day', '');
    expect(out.find(a => a.region === 'unattributed')).toBeDefined();
  });
});

// Heuristic IOC extraction from already-fetched article bodies.
// Every result is opt-in (only runs when h.articleBody exists) and tagged
// `heuristic: true` so downstream surfaces never present it as a verified feed.
describe('enrichIOCs — heuristic indicator extraction', () => {
  test('extracts defanged domains, IPs, and hashes from article text', () => {
    const hs = [{
      title: 'Phishing campaign drops malware',
      articleBody: 'The campaign uses evil-domain[.]com and connects to 203[.]0[.]113[.]45. ' +
        'The payload hash is 44d88612fea8a8f36de82e1278abb02f (MD5) and it reaches out to hxxp://bad-actor[.]net/panel.',
    }];
    enrichIOCs(hs);
    expect(hs[0].iocs).toBeDefined();
    expect(hs[0].iocs.heuristic).toBe(true);
    expect(hs[0].iocs.domains).toEqual(expect.arrayContaining(['evil-domain.com', 'bad-actor.net']));
    expect(hs[0].iocs.ips).toContain('203.0.113.45');
    expect(hs[0].iocs.hashes).toContain('44d88612fea8a8f36de82e1278abb02f');
  });

  test('does not run on headlines with no articleBody (opt-in per honesty posture)', () => {
    const hs = [{ title: 'No deep-extracted body here', description: '' }];
    enrichIOCs(hs);
    expect(hs[0].iocs).toBeUndefined();
  });

  test('yields nothing (no h.iocs) when the body carries no indicators', () => {
    const hs = [{ title: 'Policy roundup', articleBody: 'Congress debated the budget for most of the afternoon.' }];
    enrichIOCs(hs);
    expect(hs[0].iocs).toBeUndefined();
  });

  test('filters common file-extension false positives out of the domain list', () => {
    const hs = [{ title: 'Report', articleBody: 'The report is available as report.pdf and screenshot.png on the vendor site.' }];
    enrichIOCs(hs);
    expect(hs[0].iocs).toBeUndefined();
  });

  test('rejects impossible IPv4 octets while keeping valid addresses', () => {
    const hs = [{ title: 'IOC report', articleBody: 'Observed 999.300.1.2 and valid 198.51.100.42 infrastructure.' }];
    enrichIOCs(hs);
    expect(hs[0].iocs.ips).toEqual(['198.51.100.42']);
  });
});
