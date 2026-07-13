import { describe, test, expect } from '@jest/globals';
import {
  parseBluf, parseSignalTitles,
  parseBrief, parseJudgments, parseExecBullets, parseDeveloping, parseConvergence,
  BLUF_MAX_WORDS,
} from '../lib/brief-schema.js';

// Canonical brief: the shapes every Wall page parses. One signal carries the
// stable **Act now:** directive (a regression guard); the others exercise
// the legacy fallback and the no-action case so the parser never fabricates one.
const SAMPLE_BRIEF = `# THREAT LANDSCAPE BRIEFING
### 2026-06-12 · Friday

## BLUF

Edge device exploitation has shifted from opportunistic to systematic — three VPN vendors have actively exploited flaws in the same week.

---

## EXECUTIVE SUMMARY

- **VPN appliances under mass scanning.** Exploitation went global within 48 hours.
- A plain bullet with no bold lead-in.

## KEY JUDGMENTS

### Signal 1 — [Horizon 1] VPN appliance zero-day under mass exploitation
**Assessment:** Exploitation moved from targeted to mass scanning within 48 hours.
**Confidence:** Highly likely (80-95%) — reporting across three distinct sources
**The line:** Patch the edge or lose the edge.
**Decision window:** Next 24 hours — before weekend scanning peaks.
**Recommended actions:**
- **Act now:** Block inbound management-plane access at the firewall.
- Inventory all exposed appliances by Monday.

### Signal 2 — [Horizon 2] Insurance carriers tighten edge requirements
**Assessment:** Renewal questionnaires now ask for edge inventory.
**Confidence:** Moderate signal from two brokers.
**The line:** Underwriting is the new patch deadline.
**Decision window:** Next 30 days.
**Analyst (this shift):** Pull the current edge inventory for the renewal packet.

### Signal 3 — [Horizon 3] Quantum migration guidance lands
**Assessment:** NIST finalizes post-quantum timelines.
**Confidence:** Low — early guidance only.
**The line:** The clock starts now, the deadline is years out.
**Decision window:** Next quarter.

---

## DEVELOPING SITUATIONS

### Identity provider session token abuse
**Trajectory:** Accelerating — moving from research to crimeware.
**Watch criteria:** Escalate when a public PoC lands.

---

## CONVERGENCE

### Edge exploitation meets identity abuse
**The intersection:** Compromised VPNs are harvesting the session tokens that bypass MFA.
**The move:** Act — Rotate session-signing keys and force re-authentication.

---

## WATCHLIST — NEXT 72 HOURS

- CISA adds CVE-2026-11111 to KEV
- Vendor ships out-of-band patch
`;

describe('parseSignalTitles', () => {
  test('finds the signals with horizon + title', () => {
    const sigs = parseSignalTitles(SAMPLE_BRIEF);
    expect(sigs).toHaveLength(3);
    expect(sigs[0]).toEqual({ horizon: 1, title: 'VPN appliance zero-day under mass exploitation' });
  });
});

describe('parseBluf', () => {
  test('returns the BLUF first paragraph', () => {
    expect(parseBluf(SAMPLE_BRIEF, Infinity)).toContain('Edge device exploitation has shifted');
  });
});

describe('parseJudgments', () => {
  const stories = parseJudgments(SAMPLE_BRIEF);

  test('extracts title, horizon, line, confidence, and decision window', () => {
    const s = stories[0];
    expect(s.horizon).toBe(1);
    expect(s.title).toBe('VPN appliance zero-day under mass exploitation');
    expect(s.line).toBe('Patch the edge or lose the edge.');
    expect(s.confidence).toBe('Highly likely (80-95%)');
    expect(s).not.toHaveProperty('revisesIf');
    expect(s.decision).toBe('Next 24 hours');
  });

  test('still parses the legacy "Revises if" field in an archived brief', () => {
    const archived = SAMPLE_BRIEF.replace(
      '**The line:** Patch the edge or lose the edge.',
      '**Revises if:** a vendor issues first-party confirmation.\n**The line:** Patch the edge or lose the edge.'
    );
    const parsed = parseJudgments(archived)[0];
    expect(parsed.title).toBe('VPN appliance zero-day under mass exploitation');
    expect(parsed.confidence).toBe('Highly likely (80-95%)');
    expect(parsed.decision).toBe('Next 24 hours');
    expect(parsed).not.toHaveProperty('revisesIf');
  });

  // Regression guard: the **Act now:** directive MUST be parsed into the
  // judgment's this-shift action, with no owner.
  test('parses the **Act now:** directive into actionShift', () => {
    const s = stories[0];
    expect(s.actionShift).not.toBeNull();
    expect(s.actionShift.owner).toBeNull();
    expect(s.actionShift.imperative).toBe('Block inbound management-plane access at the firewall.');
  });

  test('falls back to the legacy "(this shift)" form when no Act now line', () => {
    const s = stories[1];
    expect(s.actionShift).not.toBeNull();
    expect(s.actionShift.owner).toBe('Analyst');
    expect(s.actionShift.imperative).toBe('Pull the current edge inventory for the renewal packet.');
  });

  test('yields actionShift null when neither form is present (never fabricated)', () => {
    expect(stories[2].actionShift).toBeNull();
  });

  test('does not shift later titles when an earlier signal heading is malformed', () => {
    const malformed = SAMPLE_BRIEF.replace(
      '### Signal 1 — [Horizon 1] VPN appliance zero-day under mass exploitation',
      '### Signal 1 — VPN appliance zero-day under mass exploitation'
    );
    const parsed = parseJudgments(malformed);
    expect(parsed[0]).toMatchObject({
      horizon: 2,
      title: 'VPN appliance zero-day under mass exploitation',
    });
    expect(parsed[1]).toMatchObject({
      horizon: 2,
      title: 'Insurance carriers tighten edge requirements',
    });
    expect(parsed[2]).toMatchObject({
      horizon: 3,
      title: 'Quantum migration guidance lands',
    });
  });

  test.each([
    'CVE-2026-11111 is not yet in CISA KEV.',
    'KEV status is unresolved for CVE-2026-11111.',
    'If added to KEV, CVE-2026-11111 will require escalation.',
  ])('does not badge a non-affirmative KEV mention: %s', assessment => {
    const md = SAMPLE_BRIEF.replace(
      '**Assessment:** Exploitation moved from targeted to mass scanning within 48 hours.',
      `**Assessment:** ${assessment}`
    );
    expect(parseJudgments(md)[0]).toMatchObject({ isKEV: false, kevCVE: '' });
  });

  test('badges an affirmative KEV CVE on the same line', () => {
    const md = SAMPLE_BRIEF.replace(
      '**Assessment:** Exploitation moved from targeted to mass scanning within 48 hours.',
      '**Assessment:** CISA KEV lists CVE-2026-11111 after confirmed exploitation.'
    );
    expect(parseJudgments(md)[0]).toMatchObject({
      isKEV: true,
      kevCVE: 'CVE-2026-11111',
    });
  });
});

describe('parseExecBullets', () => {
  test('splits the bold lead from the muted tail', () => {
    const rows = parseExecBullets(`- **VPN appliances under mass scanning.** Exploitation went global within 48 hours.
- A plain bullet with no bold lead-in.`);
    expect(rows[0]).toEqual({
      lead: 'VPN appliances under mass scanning.',
      tail: 'Exploitation went global within 48 hours.',
    });
    expect(rows[1]).toEqual({ lead: 'A plain bullet with no bold lead-in.', tail: '' });
  });
});

describe('parseConvergence', () => {
  test('gets the intersection and the move (taxonomy verb stripped)', () => {
    const conv = parseConvergence(SAMPLE_BRIEF);
    expect(conv).toHaveLength(1);
    expect(conv[0].intersection).toContain('Compromised VPNs are harvesting');
    expect(conv[0].move).toBe('Rotate session-signing keys and force re-authentication.');
  });

  test('recovers an unlabeled opening intersection from an archived brief', () => {
    const md = `## CONVERGENCE\n\n### Identity meets destructive access\nThe identity bypass supplies the access used by the destructive payload.\n**The cascade:** Access compounds impact.\n**The move:** Act — close the enrollment gap.`;
    expect(parseConvergence(md)[0]).toMatchObject({
      intersection: 'The identity bypass supplies the access used by the destructive payload.',
      move: 'close the enrollment gap.',
    });
  });
});

describe('parseDeveloping', () => {
  test('gets the trajectory verb and the watch criteria', () => {
    const dev = parseDeveloping(SAMPLE_BRIEF);
    expect(dev).toHaveLength(1);
    expect(dev[0].name).toBe('Identity provider session token abuse');
    expect(dev[0].trajectory).toBe('Accelerating');
    expect(dev[0].watch).toBe('Escalate when a public PoC lands.');
  });
});

describe('parseBrief', () => {
  test('assembles every page section from the brief', () => {
    const doc = parseBrief(SAMPLE_BRIEF);
    expect(doc.bluf).toContain('Edge device exploitation');
    expect(doc.execSummary).toHaveLength(2);
    expect(doc.stories).toHaveLength(3);
    expect(doc.developing).toHaveLength(1);
    expect(doc.convergence).toHaveLength(1);
    expect(doc.watchlist).toContain('CISA adds CVE-2026-11111 to KEV');
  });
});

// The BLUF word budget is one shared constant so the emit side
// (prompts.js, which states the target) and the audit side (validation.js,
// which warns past it) can never disagree.
describe('BLUF_MAX_WORDS', () => {
  test('is a small positive number suitable for a one-sentence BLUF', () => {
    expect(typeof BLUF_MAX_WORDS).toBe('number');
    expect(BLUF_MAX_WORDS).toBeGreaterThan(10);
    expect(BLUF_MAX_WORDS).toBeLessThan(60);
  });
});
