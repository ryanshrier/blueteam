// BlueTeam.News — lib/config.js hot-reload tests.
//
// A rejected reload (Zod validation failure, or unparseable JSON) must keep
// the last-known-good config rather than falling back to
// ConfigSchema.parse({}) — the all-defaults config with trustedFeeds: [].
// Before this fix, one typo in a hand-edited config.json silently replaced
// the entire feed set with zero feeds while configVersion still bumped,
// making the rejected reload look applied. See finding #10.
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initConfig, getConfig, getConfigVersion, getLastReloadError, stopConfigWatch, _resetForTests } from '../lib/config.js';

function validConfigJSON(overrides = {}) {
  return JSON.stringify({
    trustedFeeds: [{ url: 'https://example.com/feed.xml', source: 'Example', horizon: 1 }],
    ...overrides,
  });
}

describe('config — last-known-good on rejected reload', () => {
  let dir; let configPath;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-config-'));
    configPath = join(dir, 'config.json');
    _resetForTests();
  });
  afterEach(() => {
    stopConfigWatch();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a valid config loads cleanly with no reload error', () => {
    writeFileSync(configPath, validConfigJSON());
    initConfig(configPath);
    const config = getConfig();
    expect(config.trustedFeeds).toHaveLength(1);
    expect(config.analysisSettings.maxEPSSLookups).toBe(20);
    expect(config.analysisSettings.model).toBe('claude-haiku-4-5');
    expect(config.analysisSettings.horizonWeights).toEqual({ horizon1: 0.45, horizon2: 0.4, horizon3: 0.15 });
    expect(config.analysisSettings.scoring.axisWeights.exploitation).toBe(0.28);
    expect(config.analysisSettings.webhook).toEqual({ url: '', format: 'slack', events: 'alerts' });
    expect(config.organization.profile).toBe('Enterprise cyber defense team');
    expect(getLastReloadError()).toBeNull();
  });

  test('preserves a configured EPSS lookup budget instead of stripping the manifest key', () => {
    writeFileSync(configPath, validConfigJSON({ analysisSettings: { maxEPSSLookups: 7 } }));
    initConfig(configPath);
    expect(getConfig().analysisSettings.maxEPSSLookups).toBe(7);
  });

  test('first load falling to validation failure still gets usable defaults', () => {
    // horizon is required to be 1-3; 4 is out of range and the file has no
    // prior good config to fall back to (this is the very first load).
    writeFileSync(configPath, JSON.stringify({ trustedFeeds: [{ url: 'https://x.com/f.xml', source: 'X', horizon: 4 }] }));
    initConfig(configPath);
    const config = getConfig();
    expect(config.trustedFeeds).toEqual([]); // defaults — nothing good to preserve yet
    expect(getLastReloadError()).not.toBeNull();
  });

  test('a validation failure on a SUBSEQUENT load keeps the last-known-good config, not defaults', () => {
    writeFileSync(configPath, validConfigJSON());
    initConfig(configPath);
    expect(getConfig().trustedFeeds).toHaveLength(1);
    const versionAfterGoodLoad = getConfigVersion();

    // Simulate the hot-reload's loadConfig() being invoked again with a typo'd
    // config (horizon: 4 is out of the 1-3 range) — the exact class of bug
    // this finding targets: a single bad field.
    writeFileSync(configPath, JSON.stringify({ trustedFeeds: [{ url: 'https://x.com/f.xml', source: 'X', horizon: 4 }] }));
    // Directly re-trigger the loader the way the fs.watch debounce would, by
    // re-initializing against the now-broken file. initConfig re-runs
    // loadConfig() synchronously on call.
    initConfig(configPath);

    const config = getConfig();
    expect(config.trustedFeeds).toHaveLength(1); // preserved — NOT reset to []
    expect(config.trustedFeeds[0].source).toBe('Example');
    expect(getLastReloadError()).not.toBeNull();
    // configVersion must NOT bump on a rejected reload when a prior good
    // config exists — bumping it would make the UI/health report the broken
    // reload as "applied".
    expect(getConfigVersion()).toBe(versionAfterGoodLoad);
  });

  test('unparseable JSON on a subsequent load also keeps the last-known-good config', () => {
    writeFileSync(configPath, validConfigJSON());
    initConfig(configPath);
    expect(getConfig().trustedFeeds).toHaveLength(1);
    const versionAfterGoodLoad = getConfigVersion();

    writeFileSync(configPath, '{not valid json');
    initConfig(configPath);

    const config = getConfig();
    expect(config.trustedFeeds).toHaveLength(1);
    expect(getLastReloadError()).not.toBeNull();
    expect(getConfigVersion()).toBe(versionAfterGoodLoad);
  });

  test('a subsequent VALID reload clears the last reload error', () => {
    writeFileSync(configPath, validConfigJSON());
    initConfig(configPath);

    writeFileSync(configPath, '{not valid json');
    initConfig(configPath);
    expect(getLastReloadError()).not.toBeNull();

    writeFileSync(configPath, validConfigJSON({ trustedFeeds: [{ url: 'https://y.com/f.xml', source: 'Y', horizon: 2 }] }));
    initConfig(configPath);
    expect(getLastReloadError()).toBeNull();
    expect(getConfig().trustedFeeds[0].source).toBe('Y');
  });
});
