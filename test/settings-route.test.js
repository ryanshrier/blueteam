import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSettingsRouter, MAX_ANTHROPIC_KEY_BYTES } from '../routes/settings.js';
import {
  loadUserSettings, getUserSettings, saveUserSettings, getEffectiveOrganization,
  MAX_ORG_REGION_LEN,
} from '../lib/user-settings.js';

// The route surfaces alert rules + literal watch-terms + the effective
// organization profile, and accepts writes for the latter two — all behind the
// loopback/authed gate. These tests exercise the gate, the E_WATCHTERMS /
// E_ORGPROFILE validation, and (for watch-terms) the guarantee that terms are
// stored as LITERAL keywords (escaping happens later, in scoring.js).

const AI_STATUS = { enabled: false, source: null, masked: null };

// Stand up the router on an ephemeral port with a configurable trust posture, so
// we can drive it with real HTTP and assert status codes + JSON bodies.
// getOrganization mirrors server.js's real wiring (getEffectiveOrganization over
// a config.json stand-in) rather than a fake stub, so these tests exercise the
// actual merge behavior.
function makeServer({ dataDir, loopback, authed, alertRules = [], orgConfig = {}, verifyKey = null }) {
  const app = express();
  app.use(express.json());
  app.use('/api', createSettingsRouter({
    dataDir,
    getAiStatus: () => AI_STATUS,
    refreshAi: () => {},
    verifyKey,
    getAlertRules: () => alertRules,
    getOrganization: () => getEffectiveOrganization(orgConfig),
    loopback,
    authed,
  }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe('settings route — watch-terms + alert-rule surfacing', () => {
  let dir; let ctx;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-settings-'));
    loadUserSettings(dir); // fresh, empty cache per test
  });
  afterEach(async () => {
    if (ctx?.server) await new Promise(r => ctx.server.close(r));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('GET on a trusted caller surfaces alertRules (source:config) and watchTerms', async () => {
    saveUserSettings(dir, { watchTerms: ['Fortinet'] });
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false, alertRules: [{ pattern: 'zero.?day', boost: 5 }] });
    const body = await (await fetch(`${ctx.base}/api/settings`)).json();
    expect(body.alertRules).toEqual([{ pattern: 'zero.?day', boost: 5, source: 'config' }]);
    expect(body.watchTerms).toEqual(['Fortinet']);
  });

  test('GET on an untrusted caller omits alertRules, watchTerms, and organization entirely', async () => {
    saveUserSettings(dir, { watchTerms: ['Fortinet'] });
    ctx = await makeServer({ dataDir: dir, loopback: false, authed: false, alertRules: [{ pattern: 'x', boost: 1 }] });
    const body = await (await fetch(`${ctx.base}/api/settings`)).json();
    expect(body.ai).toBeDefined();
    expect('alertRules' in body).toBe(false);
    expect('watchTerms' in body).toBe(false);
    expect('organization' in body).toBe(false);
  });

  test('POST watch-terms normalizes (trim, dedupe, drop empties) and persists', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchTerms: ['  Fortinet ', 'fortinet', 'Citrix', '   '] }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.watchTerms).toEqual(['Fortinet', 'Citrix']); // deduped case-insensitively, blank dropped
    expect(getUserSettings().watchTerms).toEqual(['Fortinet', 'Citrix']);
  });

  test('POST rejects a non-array watchTerms with 400 E_WATCHTERMS', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchTerms: 'Fortinet' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_WATCHTERMS');
  });

  test('POST rejects an over-length term with 400 E_WATCHTERMS', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchTerms: ['x'.repeat(65)] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_WATCHTERMS');
  });

  test('POST rejects more than 25 terms with 400 E_WATCHTERMS', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const many = Array.from({ length: 26 }, (_, i) => `term${i}`);
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchTerms: many }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_WATCHTERMS');
  });

  test('a rejected multi-field update does not partially persist an earlier valid field', async () => {
    saveUserSettings(dir, { anthropicKey: 'sk-ant-existing-key' });
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicKey: 'sk-ant-replacement-key', watchTerms: 'not-an-array' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_WATCHTERMS');
    expect(getUserSettings().anthropicKey).toBe('sk-ant-existing-key');
  });

  test('a non-string anthropicKey is rejected instead of silently clearing the saved key', async () => {
    saveUserSettings(dir, { anthropicKey: 'sk-ant-existing-key' });
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicKey: null }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_KEYFMT');
    expect(getUserSettings().anthropicKey).toBe('sk-ant-existing-key');
  });

  test('verify rejects a non-string candidate instead of verifying the saved active key', async () => {
    const verifyKey = jest.fn().mockResolvedValue({ valid: true });
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false, verifyKey });
    const res = await fetch(`${ctx.base}/api/settings/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicKey: null }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_KEYFMT');
    expect(verifyKey).not.toHaveBeenCalled();
  });

  test('POST rejects an oversized Anthropic key without changing the saved key', async () => {
    saveUserSettings(dir, { anthropicKey: 'sk-ant-existing-key' });
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicKey: `sk-ant-${'x'.repeat(MAX_ANTHROPIC_KEY_BYTES)}` }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_KEYFMT');
    expect(getUserSettings().anthropicKey).toBe('sk-ant-existing-key');
  });

  test('verify rejects an oversized candidate before making a provider call', async () => {
    const verifyKey = jest.fn().mockResolvedValue({ valid: true });
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false, verifyKey });
    const res = await fetch(`${ctx.base}/api/settings/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicKey: `sk-ant-${'x'.repeat(MAX_ANTHROPIC_KEY_BYTES)}` }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_KEYFMT');
    expect(verifyKey).not.toHaveBeenCalled();
  });

  test('POST watch-terms over the network without trust is 403 E_EXPOSED (never persists)', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: false, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchTerms: ['Fortinet'] }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('E_EXPOSED');
    expect(getUserSettings().watchTerms).toBeUndefined();
  });

  test('GET surfaces the effective organization: config.json defaults with no override saved', async () => {
    const orgConfig = { organization: { sector: 'Default sector', profile: 'Default profile', audience: 'x', watchTopics: [], regions: ['US'] } };
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false, orgConfig });
    const body = await (await fetch(`${ctx.base}/api/settings`)).json();
    expect(body.organization).toEqual(orgConfig.organization);
  });

  test('POST organization persists an override and GET echoes it merged over config.json', async () => {
    const orgConfig = { organization: { sector: 'Default sector', profile: 'Default profile', regions: ['US'] } };
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false, orgConfig });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: { sector: 'Healthcare', profile: '  Mid-size hospital network  ', regions: ['US', 'EU'] } }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    // profile is trimmed by the persistence-layer sanitizer
    expect(body.organization).toEqual({ sector: 'Healthcare', profile: 'Mid-size hospital network', regions: ['US', 'EU'] });

    const get = await (await fetch(`${ctx.base}/api/settings`)).json();
    expect(get.organization).toEqual({ sector: 'Healthcare', profile: 'Mid-size hospital network', regions: ['US', 'EU'] });
  });

  test('a blank organization field clears that override and falls back to the config.json default', async () => {
    const orgConfig = { organization: { sector: 'Default sector', profile: 'Default profile', regions: ['US'] } };
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false, orgConfig });
    await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: { sector: 'Healthcare', profile: 'Custom profile', regions: ['US'] } }),
    });
    // Re-save with sector blanked — should fall back to the config.json default,
    // not silently keep the previous override (a stale merge would hide this).
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: { sector: '', profile: 'Custom profile', regions: ['US'] } }),
    });
    const body = await res.json();
    expect(body.organization.sector).toBe('Default sector');
    expect(body.organization.profile).toBe('Custom profile');
  });

  test('POST rejects a non-object organization with 400 E_ORGPROFILE', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: 'Healthcare' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_ORGPROFILE');
  });

  test('POST rejects a non-string-array organization.regions with 400 E_ORGPROFILE', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: { regions: [1, 2] } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_ORGPROFILE');
  });

  test('POST rejects an over-length organization region with 400 E_ORGPROFILE', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: { regions: ['x'.repeat(MAX_ORG_REGION_LEN + 1)] } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('E_ORGPROFILE');
  });

  test('POST organization regions trim and dedupe case-insensitively', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: { regions: ['  North America ', 'north america', 'EU', ''] } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).organization.regions).toEqual(['North America', 'EU']);
  });

  test('POST organization over the network without trust is 403 E_EXPOSED (never persists)', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: false, authed: false });
    const res = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization: { sector: 'Healthcare' } }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('E_EXPOSED');
    expect(getUserSettings().organization).toBeUndefined();
  });
});

describe('user-settings sanitize — watch-terms persistence guard', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wf-usettings-')); loadUserSettings(dir); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  test('strips control chars, trims, dedupes, bounds length, caps count', () => {
    const saved = saveUserSettings(dir, {
      watchTerms: [
        `Fort\0inet`,          // embedded NUL stripped
        '  Fortinet  ',            // dupe after trim (case-insensitive)
        '   ',                     // whitespace-only dropped
        'x'.repeat(80),            // clipped to 64
        ...Array.from({ length: 40 }, (_, i) => `t${i}`), // overflow → capped at 25 total
      ],
    });
    expect(saved.watchTerms.length).toBeLessThanOrEqual(25);
    expect(saved.watchTerms).toContain('Fortinet');
    expect(saved.watchTerms.filter(t => t.toLowerCase() === 'fortinet')).toHaveLength(1);
    expect(saved.watchTerms.every(t => t.length <= 64)).toBe(true);
    expect(saved.watchTerms.some(t => t.includes('\0'))).toBe(false);
  });

  test('a non-array watchTerms sanitizes to an empty list, never throws', () => {
    expect(saveUserSettings(dir, { watchTerms: 'nope' }).watchTerms).toEqual([]);
  });
});

describe('user-settings — organization profile sanitize + effective merge', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wf-usettings-org-')); loadUserSettings(dir); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  test('trims strings, drops empty fields, bounds regions, never persists audience/watchTopics', () => {
    const saved = saveUserSettings(dir, {
      organization: { sector: '  Healthcare  ', profile: '', regions: ['US', '', '  EU  ', 1, 'APAC'], audience: 'sneaking in', watchTopics: ['x'] },
    });
    expect(saved.organization).toEqual({ sector: 'Healthcare', regions: ['US', 'EU', 'APAC'] });
  });

  test('clips and deduplicates hand-edited organization regions at the persistence boundary', () => {
    const long = 'North America'.padEnd(MAX_ORG_REGION_LEN + 20, 'x');
    const clipped = long.slice(0, MAX_ORG_REGION_LEN);
    const saved = saveUserSettings(dir, {
      organization: { regions: [long, clipped.toLowerCase(), ' EU ', 'eu'] },
    });
    expect(saved.organization.regions).toEqual([clipped, 'EU']);
    expect(saved.organization.regions.every(r => r.length <= MAX_ORG_REGION_LEN)).toBe(true);
  });

  test('an all-blank organization patch clears any previous override entirely', () => {
    saveUserSettings(dir, { organization: { sector: 'Healthcare' } });
    const saved = saveUserSettings(dir, { organization: { sector: '', profile: '', regions: [] } });
    expect(saved.organization).toBeUndefined();
  });

  test('getEffectiveOrganization falls back field-by-field to config.json, overriding only what the operator set', () => {
    const config = { organization: { sector: 'Default sector', profile: 'Default profile', audience: 'Default audience', watchTopics: ['ransomware'], regions: ['US'] } };
    saveUserSettings(dir, { organization: { sector: 'Healthcare' } }); // profile/regions left unset
    const effective = getEffectiveOrganization(config);
    expect(effective.sector).toBe('Healthcare');       // overridden
    expect(effective.profile).toBe('Default profile'); // falls back
    expect(effective.regions).toEqual(['US']);          // falls back
    expect(effective.audience).toBe('Default audience'); // never operator-editable
    expect(effective.watchTopics).toEqual(['ransomware']); // never operator-editable
  });

  test('getEffectiveOrganization is just config.json when no override was ever saved', () => {
    const config = { organization: { sector: 'Default sector', profile: 'Default profile', regions: [] } };
    expect(getEffectiveOrganization(config)).toEqual(config.organization);
  });
});
