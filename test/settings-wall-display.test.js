import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { DISPLAY_DEFAULTS, DISPLAY_STORAGE_KEY, loadDisplaySettings, normalizeDisplaySettings, persistDisplaySettings } from '../public/modules/wall/wall-presentation.js';
import { wallDisplaySettingsHtml, wallDisplaySettingsFromForm, syncWallDisplayControls, mountWallDisplaySettings } from '../public/modules/settings/wall-display.js';

const storage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return { getItem:key=>values.get(key) || null, setItem:(key,value)=>values.set(key,value), values };
};
const formFor = preferences => {
  const controls = Object.fromEntries(Object.entries(normalizeDisplaySettings(preferences)).map(([name,value]) => [name, typeof value === 'boolean' ? { checked:value } : { value:String(value) }]));
  const listeners = new Map();
  return { controls, listeners, elements:{ namedItem:name=>controls[name] }, addEventListener:(name,handler)=>listeners.set(name,handler), removeEventListener:(name,handler)=>{ if(listeners.get(name) === handler) listeners.delete(name); } };
};
afterEach(() => { persistDisplaySettings(DISPLAY_DEFAULTS, storage()); });

describe('Wall display preferences in Settings', () => {
  test('retains the existing browser key and explicit operator choices while enabling unattended defaults for new preferences', () => {
    const saved = storage({ [DISPLAY_STORAGE_KEY]:JSON.stringify({ size:'large', margin:'wide', awake:false, holdSeconds:120, dim:true, dimStart:23, dimEnd:5 }) });
    expect(DISPLAY_STORAGE_KEY).toBe('bt-wall-display');
    expect(loadDisplaySettings(saved)).toMatchObject({ size:'large', margin:'wide', awake:false, fullscreen:true, holdSeconds:120, dim:true, dimStart:23, dimEnd:5 });
    expect(normalizeDisplaySettings({})).toEqual(DISPLAY_DEFAULTS);
    expect(normalizeDisplaySettings({ fullscreen:false, awake:false })).toMatchObject({ fullscreen:false, awake:false });
    expect(normalizeDisplaySettings(null)).toEqual(DISPLAY_DEFAULTS);
  });

  test('the form saves only display fields and preserves the legacy hold value without offering a passive-Wall hold control', () => {
    const previous = normalizeDisplaySettings({ holdSeconds:300, fullscreen:false, awake:false });
    const form = formFor(previous);
    form.controls.size.value = 'largest';
    form.controls.feedSeconds.value = '120';
    form.controls.fullscreen.checked = true;
    form.controls.apiKey = { value:'do not persist unrelated fields' };
    const settings = wallDisplaySettingsFromForm(form, previous);
    expect(settings).toMatchObject({ size:'largest', feedSeconds:120, holdSeconds:300, fullscreen:true, awake:false });
    expect(settings).not.toHaveProperty('apiKey');
    const html = wallDisplaySettingsHtml(settings);
    expect(html).toContain('id="set-wall"');
    expect(html).toContain('href="/wall"');
    expect(html).toContain('Changes save automatically');
    expect(html).toContain('<option value="largest" selected>');
    expect(html).not.toContain('name="holdSeconds"');
    expect(html).toContain('Overnight display care');
  });

  test('overnight fields follow their enabling checkbox without discarding configured hours', () => {
    const form = formFor({ dim:false, maintenance:false, dimStart:22, maintenanceHour:3 });
    syncWallDisplayControls(form);
    expect(form.controls.dimStart.disabled).toBe(true);
    expect(form.controls.dimEnd.disabled).toBe(true);
    expect(form.controls.maintenanceHour.disabled).toBe(true);
    form.controls.dim.checked = true;
    form.controls.maintenance.checked = true;
    syncWallDisplayControls(form);
    expect(form.controls.dimStart.disabled).toBe(false);
    expect(form.controls.dimStart.value).toBe('22');
    expect(form.controls.maintenanceHour.value).toBe('3');
  });

  test('blocked storage keeps session preferences available and reports that they were not persisted', () => {
    const blocked = { getItem:()=>{ throw new Error('blocked'); }, setItem:()=>{ throw new Error('blocked'); } };
    const result = persistDisplaySettings({ size:'largest', awake:false }, blocked);
    expect(result).toMatchObject({ persisted:false, settings:{ size:'largest', awake:false } });
    expect(loadDisplaySettings(blocked).size).toBe('largest');
    result.settings.size = 'standard';
    expect(loadDisplaySettings(blocked).size).toBe('largest');
    const available = storage();
    expect(persistDisplaySettings({ size:'large' }, available).persisted).toBe(true);
    expect(loadDisplaySettings(available).size).toBe('large');
  });

  test('saving a changed preference updates the shared key, emits normalized state, and unmount removes listeners', () => {
    const oldWindow = globalThis.window;
    const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const saved = storage();
    const dispatchEvent = jest.fn();
    globalThis.window = { dispatchEvent };
    Object.defineProperty(globalThis, 'localStorage', { configurable:true, value:saved });
    const form = formFor(DISPLAY_DEFAULTS);
    const status = {};
    const section = { innerHTML:'', querySelector:selector=>selector === 'form' ? form : status };
    try {
      const stop = mountWallDisplaySettings(section);
      form.controls.size.value = 'large';
      form.controls.dim.checked = true;
      form.listeners.get('change')();
      expect(JSON.parse(saved.getItem(DISPLAY_STORAGE_KEY))).toMatchObject({ size:'large', dim:true });
      expect(status.textContent).toBe('Saved in this browser.');
      expect(dispatchEvent.mock.calls[0][0].type).toBe('wall-display-settings-changed');
      expect(dispatchEvent.mock.calls[0][0].detail).toMatchObject({ size:'large', dim:true });
      stop();
      expect(form.listeners.size).toBe(0);
    } finally {
      globalThis.window = oldWindow;
      if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else delete globalThis.localStorage;
    }
  });
});
