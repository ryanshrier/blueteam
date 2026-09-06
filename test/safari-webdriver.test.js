import { expect, jest, test } from '@jest/globals';
import { SafariWebDriver } from '../scripts/safari-webdriver.mjs';

test('Safari transport surfaces W3C failures even with HTTP success', async () => {
  const driver = new SafariWebDriver('http://127.0.0.1:4444', async () => ({ ok: true, json: async () => ({ value: { error: 'session not created', message: 'Remote Automation disabled' } }) }));
  await expect(driver.command('POST', '/session', {})).rejects.toThrow('Remote Automation disabled');
});

test('Safari reverse Tab uses native W3C actions and releases Shift', async () => {
  const request = jest.fn(async () => ({ ok: true, json: async () => ({ value: null }) }));
  const driver = new SafariWebDriver('http://127.0.0.1:4444', request);
  driver.sessionId = 'isolated';
  await driver.key('\uE004', true);
  expect(request.mock.calls[0][0]).toBe('http://127.0.0.1:4444/session/isolated/actions');
  expect(JSON.parse(request.mock.calls[0][1].body).actions[0].actions).toEqual([
    { type: 'keyDown', value: '\uE008' }, { type: 'keyDown', value: '\uE004' },
    { type: 'keyUp', value: '\uE004' }, { type: 'keyUp', value: '\uE008' },
  ]);
});

test('Safari rejects non-W3C element responses instead of pretending to click', async () => {
  const driver = new SafariWebDriver('http://127.0.0.1:4444', async () => ({ ok: true, json: async () => ({ value: { ELEMENT: 'obsolete' } }) }));
  driver.sessionId = 'isolated';
  await expect(driver.click('#evidence')).rejects.toThrow('no W3C element');
});
