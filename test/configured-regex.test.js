import { afterEach, describe, expect, test } from '@jest/globals';
import { createServer } from 'node:http';
import { createConfiguredRegexWorker, CONFIGURED_REGEX_LIMITS, evaluateConfiguredRegexSync } from '../lib/configured-regex.js';
import { createRegexScoringContext, prepareHeadlineRegexes, scoreHeadline } from '../lib/scoring.js';
import { getDomainPack, setDomainPack } from '../lib/domain.js';
import { assessUrgency, editorialContext } from '../lib/intelligence-context.js';

const originalPack = getDomainPack();
afterEach(() => setDomainPack(originalPack));
const profile = { technologies: [], sectors: [], regions: [], preferredHorizons: [] };
const safePatterns = () => ({ critical: ['active exploitation'], elevated: ['patch'], promote: ['CVE-'], severity: 'CVSS ([0-9.]+)', alerts: [] });
const item = () => ({ title: 'a'.repeat(60) + 'z', description: '', severity: 'a'.repeat(60) + 'z',
  statements: [{ text: 'a'.repeat(60) + 'z', activityEligible: true }] });
const request = () => ({ operation: 'batch', patterns: safePatterns(), items: [item()] });

describe('configured regex isolation', () => {
  test.each(['critical', 'elevated', 'promote', 'severity', 'alerts'])('%s catastrophic matching times out and preserves event-loop responsiveness', async field => {
    const runtime = createConfiguredRegexWorker({ timeoutMs: 150 });
    const payload = request();
    if (field === 'severity') payload.patterns.severity = '(a+)+$';
    else if (field === 'alerts') payload.patterns.alerts = [{ pattern: '(a+)+$', boost: 5 }];
    else payload.patterns[field] = ['(a+)+$'];
    try {
      const pending = runtime.evaluate(payload);
      const outcome = pending.then(() => 'unexpected success', error => error.message);
      expect(await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve('responsive'), 0))])).toBe('responsive');
      expect(await outcome).toMatch(/timed out/);
      expect(await runtime.evaluate(request())).toHaveLength(1);
    } finally { await runtime.close(); }
  });

  test('HTTP continues responding while a hostile collection batch is running', async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end('healthy'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const runtime = createConfiguredRegexWorker({ timeoutMs: 300 });
    const payload = request(); payload.patterns.critical = ['(a+)+$'];
    try {
      const outcome = runtime.evaluate(payload).then(() => 'unexpected success', error => error.code);
      const response = await fetch(`http://127.0.0.1:${server.address().port}`);
      expect(await response.text()).toBe('healthy');
      expect(await outcome).toBe('E_CONFIGURED_REGEX_TIMEOUT');
    } finally { await runtime.close(); await new Promise(resolve => server.close(resolve)); }
  });

  test('bounds queue/input, rejects invalid compilation, and shutdown rejects pending work', async () => {
    const runtime = createConfiguredRegexWorker({ maxPending: 2 });
    try {
      const first = runtime.evaluate(request()), second = runtime.evaluate(request());
      const settled = Promise.allSettled([first, second]);
      await expect(runtime.evaluate(request())).rejects.toThrow(/queue is full/);
      await runtime.close();
      expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected']);
      await expect(runtime.evaluate(request())).rejects.toThrow(/closed/);
    } finally { await runtime.close(); }
    const fresh = createConfiguredRegexWorker();
    try {
      await expect(fresh.evaluate({ operation: 'validate', patterns: [{ source: '[', flags: 'i' }] })).rejects.toThrow(/compilation/);
      await expect(fresh.evaluate({ text: '界'.repeat(Math.floor(CONFIGURED_REGEX_LIMITS.maxBytes / 3) + 1) })).rejects.toThrow(/limit/);
    } finally { await fresh.close(); }
  });

  test('one captured version supplies urgency, horizons, severity and literal watch terms across a pack swap', async () => {
    const config = { alertRules: [{ pattern: 'Gateway', boost: 5 }] };
    const context = createRegexScoringContext(config, { ...profile, technologies: ['C++'] });
    const headline = { title: 'Gateway reports active exploitation affecting C++', description: '', horizon: 2,
      cvssSeverityText: 'CVSS 9.8 (CRITICAL)', date: '2026-10-09T12:00:00Z' };
    const pending = prepareHeadlineRegexes([headline], context);
    config.alertRules[0].pattern = '(a+)+$';
    setDomainPack({ id: 'changed', label: 'Changed', urgencyLexicon: { critical: ['different'], horizon1Promote: [] },
      scoring: { severity: { pattern: '(a+)+$' } } });
    await pending;
    expect(headline).toMatchObject({ urgency: 'critical', horizon: 1, alertMatched: true, alertBoost: 9 });
    expect(headline.regexAssessment.fingerprint).toBe(context.fingerprint);
    scoreHeadline(headline, {}, profile, context.pack, Date.parse('2026-10-09T12:00:00Z'));
    expect(headline.scoreComponents.severity).toBeCloseTo(0.98);
    const retained = JSON.parse(JSON.stringify(headline));
    expect(assessUrgency(retained, undefined, { preparedOnly: true }).level).toBe('critical');
    expect(editorialContext(retained, [], { preparedOnly: true }).urgency.level).toBe('critical');
  });

  test('failed batches apply no partial classifications and old render data never triggers configured matching', async () => {
    const context = createRegexScoringContext({}, profile);
    const headline = { title: 'An existing item', urgency: 'elevated', score: 70 };
    await expect(prepareHeadlineRegexes([headline], context, { evaluate: async () => { throw new Error('deadline'); } })).rejects.toThrow('deadline');
    expect(headline).toEqual({ title: 'An existing item', urgency: 'elevated', score: 70 });
    setDomainPack({ id: 'malicious', label: 'Malicious', urgencyLexicon: { critical: ['(a+)+$'] } });
    expect(assessUrgency({ title: 'a'.repeat(60) + '!' }, undefined, { preparedOnly: true }))
      .toMatchObject({ level: 'unknown', basis: 'unavailable' });
  });

  test('synchronous compatibility uses an isolated bounded worker and recovers after ordinary errors', () => {
    expect(evaluateConfiguredRegexSync({ operation: 'validate', patterns: [{ source: 'C\\+\\+', flags: 'i' }] })).toBe(true);
    expect(() => evaluateConfiguredRegexSync({ operation: 'validate', patterns: [{ source: '[', flags: 'i' }] })).toThrow(/compilation/);
    expect(evaluateConfiguredRegexSync({ operation: 'match', source: 'C\\+\\+', flags: 'i', text: 'C++ update' })[0]).toBe('C++');
    const request = { operation: 'match', source: '(capture)', flags: 'i', text: 'capture' };
    const changed = evaluateConfiguredRegexSync(request); changed[1] = 'mutated';
    expect(evaluateConfiguredRegexSync(request)[1]).toBe('capture');
    const large = { operation: 'match', source: '(x+)', flags: 'i', text: 'x'.repeat(CONFIGURED_REGEX_LIMITS.maxCacheEntryBytes + 1) };
    expect(evaluateConfiguredRegexSync(large)[1]).toHaveLength(CONFIGURED_REGEX_LIMITS.maxCacheEntryBytes + 1);
  });

  test('a timed-out synchronous worker retains its slot until termination finishes', async () => {
    expect(() => evaluateConfiguredRegexSync({ operation: 'match', source: '(a+)+$', flags: 'i', text: 'a'.repeat(60) + 'z' })).toThrow(/timed out/);
    expect(() => evaluateConfiguredRegexSync({ operation: 'validate', patterns: [{ source: 'unique-next-pattern', flags: 'i' }] })).toThrow(/still stopping/);
    // Give the exit event a turn before accepting another admission worker.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(evaluateConfiguredRegexSync({ operation: 'validate', patterns: [{ source: 'unique-next-pattern', flags: 'i' }] })).toBe(true);
  });
});
