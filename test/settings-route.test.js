import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSettingsRouter, MAX_ANTHROPIC_KEY_BYTES } from '../routes/settings.js';
import {
  loadUserSettings, getUserSettings, saveUserSettings, getEffectiveOrganization, getEffectiveWatchProfile,
  MAX_ORG_REGION_LEN, getUserSettingsStatus,
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
function makeServer({
  dataDir,
  loopback,
  authed,
  alertRules = [],
  orgConfig = {},
  verifyKey = null,
  briefScheduleStatus = null,
  onBriefScheduleChanged = null,
  getAiStatus = () => AI_STATUS,
  refreshAi = () => {},
}) {
  const app = express();
  app.use(express.json());
  if (authed) app.use((_req, res, next) => {
    res.locals.authenticated = true;
    next();
  });
  app.use('/api', createSettingsRouter({
    dataDir,
    getAiStatus,
    refreshAi,
    verifyKey,
    getAlertRules: () => alertRules,
    getOrganization: () => getEffectiveOrganization(orgConfig),
    getWatchProfile: () => getEffectiveWatchProfile(orgConfig),
    getBriefScheduleStatus: () => briefScheduleStatus,
    onBriefScheduleChanged,
    loopback,
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
    const res = await fetch(`${ctx.base}/api/settings`);
    expect(res.headers.get('vary')).toContain('Authorization');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.alertRules).toEqual([{ pattern: 'zero.?day', boost: 5, source: 'config' }]);
    expect(body.watchTerms).toEqual(['Fortinet']);
  });

  test('a corrupted settings file preserves last-good settings and refuses an unrelated save, then recovers after restore', async () => {
    saveUserSettings(dir, { watchTerms: ['Fortinet'], briefSchedule: { enabled: true } });
    const path = join(dir, 'settings.local.json');
    const corrupt = '{"anthropicKey":"private-fragment';
    writeFileSync(path, corrupt);
    loadUserSettings(dir);
    expect(getUserSettings().watchTerms).toEqual(['Fortinet']);
    expect(getUserSettingsStatus()).toMatchObject({ status: 'error', usingLastGood: true, errorCode: 'INVALID_JSON' });
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const diagnostic = await (await fetch(`${ctx.base}/api/settings`)).json();
    expect(diagnostic.storage.status).toBe('error');
    expect(JSON.stringify(diagnostic)).not.toContain('private-fragment');
    const failed = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organization: { sector: 'Healthcare' } }),
    });
    expect(failed.status).toBe(503);
    expect((await failed.json()).code).toBe('E_SETTINGS_LOAD');
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
    writeFileSync(path, JSON.stringify({ watchTerms: ['Restored'], briefSchedule: { enabled: true } }));
    const saved = saveUserSettings(dir, { organization: { sector: 'Healthcare' } });
    expect(saved.watchTerms).toEqual(['Restored']);
    expect(saved.briefSchedule.enabled).toBe(true);
    expect(getUserSettingsStatus().status).toBe('ok');
  });

  test.each(['null', '[]', 'broken JSON'])('invalid initial settings %s are preserved and cannot be replaced by a patch', contents => {
    const path = join(dir, 'settings.local.json');
    writeFileSync(path, contents);
    expect(loadUserSettings(dir)).toEqual({});
    expect(getUserSettingsStatus()).toMatchObject({ status: 'error', usingLastGood: false });
    expect(() => saveUserSettings(dir, { watchTerms: ['new'] })).toThrow(/Restore valid/);
    expect(readFileSync(path, 'utf8')).toBe(contents);
  });

  test('GET on an untrusted caller omits alertRules, watchTerms, and organization entirely', async () => {
    saveUserSettings(dir, { watchTerms: ['Fortinet'] });
    ctx = await makeServer({ dataDir: dir, loopback: false, authed: false, alertRules: [{ pattern: 'x', boost: 1 }] });
    const res = await fetch(`${ctx.base}/api/settings`);
    expect(res.headers.get('vary')).toContain('Authorization');
    expect(res.headers.get('cache-control')).toBeNull();
    const body = await res.json();
    expect(body.ai).toBeDefined();
    expect('alertRules' in body).toBe(false);
    expect('watchTerms' in body).toBe(false);
    expect('organization' in body).toBe(false);
    expect('watchProfile' in body).toBe(false);
  });

  test('unified profile saves atomically and echoes the legacy technology view', async () => {
    saveUserSettings(dir, { watchTerms: ['Legacy'], organization: { sector: 'Healthcare' } });
    ctx = await makeServer({ dataDir: dir, loopback: true, orgConfig: { organization: { regions: ['US'] } } });
    const response = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchProfile: { technologies: [' C++ ', 'c++'], intelligenceQuestions: ['Is exposure confirmed?'], preferredHorizons: [2] } }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.watchTerms).toEqual(['C++']);
    expect(body.watchProfile).toMatchObject({ technologies: ['C++'], sectors: ['Healthcare'], regions: ['US'], preferredHorizons: [2] });
    expect(getUserSettings().watchTerms).toEqual(['Legacy']);
    expect(getUserSettings().briefSchedule).toBeUndefined();
  });

  test('invalid profile rejects the complete request without changing an existing key', async () => {
    saveUserSettings(dir, { anthropicKey: 'sk-ant-existing', watchTerms: ['Legacy'] });
    ctx = await makeServer({ dataDir: dir, loopback: true });
    const response = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicKey: 'sk-ant-replacement', watchProfile: { technologies: [42] } }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('E_WATCHPROFILE');
    expect(getUserSettings()).toEqual({ anthropicKey: 'sk-ant-existing', watchTerms: ['Legacy'] });
  });

  test.each([false, true])('watch profile network writes require request authentication (%s)', async (authed) => {
    ctx = await makeServer({ dataDir: dir, loopback: false, authed });
    const response = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchProfile: { technologies: ['Fortinet'] } }),
    });
    expect(response.status).toBe(authed ? 200 : 403);
    if (authed) expect(getUserSettings().watchProfile.technologies).toEqual(['Fortinet']);
    else expect(getUserSettings().watchProfile).toBeUndefined();
  });

  test('rejects conflicting unified and legacy representations without saving either', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: true });
    const response = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchProfile: { technologies: ['Fortinet'] }, watchTerms: ['Citrix'] }),
    });
    expect(response.status).toBe(400);
    expect(getUserSettings()).toEqual({});
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

  test('legacy settings migrate to a disabled schedule without persisting an opt-in', async () => {
    saveUserSettings(dir, { anthropicKey: 'sk-ant-existing-key' });
    ctx = await makeServer({
      dataDir: dir,
      loopback: true,
      authed: false,
      briefScheduleStatus: { outcome: 'disabled', attempts: 0 },
    });
    const body = await (await fetch(`${ctx.base}/api/settings`)).json();
    expect(body.briefSchedule).toEqual({
      enabled: false,
      time: '05:00',
      timezone: 'local',
      missedRun: 'skip',
      retryMinutes: 15,
      maxAttempts: 3,
    });
    expect(body.briefScheduleStatus).toEqual({ outcome: 'disabled', attempts: 0 });
    expect(getUserSettings().briefSchedule).toBeUndefined();
  });

  test('saving an API key does not enable or persist the daily schedule', async () => {
    const onBriefScheduleChanged = jest.fn();
    ctx = await makeServer({
      dataDir: dir,
      loopback: true,
      authed: false,
      onBriefScheduleChanged,
    });
    const response = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicKey: 'sk-ant-new-key' }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.briefSchedule.enabled).toBe(false);
    expect(getUserSettings().briefSchedule).toBeUndefined();
    // Rearming can unblock a separately opted-in schedule, but the key itself
    // did not mutate enabled.
    expect(onBriefScheduleChanged).toHaveBeenCalledTimes(1);
  });

  test('validates, persists, and rearms an explicitly enabled schedule', async () => {
    const onBriefScheduleChanged = jest.fn();
    ctx = await makeServer({
      dataDir: dir,
      loopback: true,
      authed: false,
      onBriefScheduleChanged,
    });
    const briefSchedule = {
      enabled: true,
      time: '06:30',
      timezone: 'America/Chicago',
      missedRun: 'catch-up',
      retryMinutes: 20,
      maxAttempts: 4,
    };
    const response = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ briefSchedule }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.briefSchedule).toEqual(briefSchedule);
    expect(getUserSettings().briefSchedule).toEqual(briefSchedule);
    expect(onBriefScheduleChanged).toHaveBeenCalledTimes(1);
  });

  test.each([
    [{ enabled: 'yes' }, /enabled/],
    [{ time: '25:00' }, /HH:MM/],
    [{ timezone: 'Not/A-Timezone' }, /timezone/],
    [{ missedRun: 'always' }, /missedRun/],
    [{ retryMinutes: 0 }, /retryMinutes/],
    [{ maxAttempts: 11 }, /maxAttempts/],
  ])('rejects an unsafe schedule patch %j', async (briefSchedule, message) => {
    ctx = await makeServer({ dataDir: dir, loopback: true, authed: false });
    const response = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ briefSchedule }),
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe('E_BRIEF_SCHEDULE');
    expect(body.error).toMatch(message);
    expect(getUserSettings().briefSchedule).toBeUndefined();
    await new Promise(resolve => ctx.server.close(resolve));
    ctx = null;
  });

  test('a non-loopback authenticated request can change the schedule, per request', async () => {
    ctx = await makeServer({ dataDir: dir, loopback: false, authed: true });
    const response = await fetch(`${ctx.base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ briefSchedule: { enabled: true } }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).briefSchedule.enabled).toBe(true);
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


describe('provider settings', () => {
  let dir, ctx;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wf-provider-settings-')); loadUserSettings(dir); });
  afterEach(async () => {
    if (ctx) await new Promise(resolve => ctx.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const post = body => fetch(`${ctx.base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  test('both keys persist through a reload; selection refreshes and rearms without enabling a schedule', async () => {
    const refreshAi = jest.fn(), onBriefScheduleChanged = jest.fn();
    ctx = await makeServer({ dataDir: dir, loopback: true, refreshAi, onBriefScheduleChanged });
    const response = await post({ anthropicKey: 'sk-ant-fixture', openaiKey: 'sk-proj-fixture', aiProvider: 'openai', openaiModel: 'gpt-5.3-codex' });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('sk-proj-fixture');
    loadUserSettings(dir);
    expect(getUserSettings()).toMatchObject({ anthropicKey: 'sk-ant-fixture', openaiKey: 'sk-proj-fixture', aiProvider: 'openai', openaiModel: 'gpt-5.3-codex' });
    expect(getUserSettings().briefSchedule).toBeUndefined();
    expect(refreshAi).toHaveBeenCalledTimes(1);
    expect(onBriefScheduleChanged).toHaveBeenCalledTimes(1);
    await post({ openaiKey: '' });
    expect(getUserSettings().openaiKey).toBeUndefined();
    expect(getUserSettings().anthropicKey).toBe('sk-ant-fixture');
  });

  test.each([
    { openaiKey: 'sk-ant-fixture' }, { openaiKey: 'sk-proj-bad\nheader' },
    { openaiKey: 'sk-' + 'x'.repeat(512) }, { openaiKey: null },
    { aiProvider: 'unknown' }, { openaiModel: '../model' }, { openaiModel: 1 },
  ])('invalid multi-field updates are atomic: %j', async patch => {
    const refreshAi = jest.fn();
    ctx = await makeServer({ dataDir: dir, loopback: true, refreshAi });
    const response = await post({ anthropicKey: 'sk-ant-fixture', ...patch });
    expect(response.status).toBe(400);
    expect(getUserSettings()).toEqual({});
    expect(refreshAi).not.toHaveBeenCalled();
  });

  test.each(['openaiKey', 'aiProvider', 'openaiModel'])('remote untrusted callers cannot change %s', async field => {
    ctx = await makeServer({ dataDir: dir, loopback: false, authed: false });
    expect((await post({ [field]: 'value' })).status).toBe(403);
    expect(getUserSettings()).toEqual({});
  });

  test('OpenAI verification uses candidate provider and model without saving them', async () => {
    const verifyKey = jest.fn(async () => ({ valid: true }));
    ctx = await makeServer({ dataDir: dir, loopback: true, verifyKey });
    const response = await fetch(`${ctx.base}/api/settings/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', openaiKey: 'sk-proj-fixture', openaiModel: 'gpt-5.3-codex' }) });
    expect(response.status).toBe(200);
    expect(verifyKey).toHaveBeenCalledWith('sk-proj-fixture', 'openai', 'gpt-5.3-codex');
    expect(getUserSettings()).toEqual({});
  });

  test('only trusted callers receive the other provider’s masked status', async () => {
    const getAiStatus = () => ({ enabled: true, source: 'local', masked: 'sk-…ture', provider: 'openai', model: 'gpt-5.3-codex',
      providers: { openai: { enabled: true, source: 'local', masked: 'sk-…ture', model: 'gpt-5.3-codex', key: 'never-expose' } } });
    ctx = await makeServer({ dataDir: dir, loopback: true, getAiStatus });
    const trusted = await (await fetch(`${ctx.base}/api/settings`)).json();
    expect(trusted.ai.providers.openai.keyMasked).toBe('sk-…ture');
    expect(JSON.stringify(trusted)).not.toContain('never-expose');
    await new Promise(resolve => ctx.server.close(resolve));
    ctx = await makeServer({ dataDir: dir, loopback: false, getAiStatus });
    const publicStatus = await (await fetch(`${ctx.base}/api/settings`)).json();
    expect(publicStatus.ai.providers).toBeUndefined();
  });
});
