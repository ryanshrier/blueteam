import { describe, expect, test } from '@jest/globals';
import { syncScheduleControlState } from '../public/modules/settings/schedule-form.js';

function controls() {
  return {
    fields: Array.from({ length: 6 }, () => ({ disabled: false })),
    saveButton: { disabled: false },
  };
}

describe('Scheduled Briefing form availability', () => {
  test('blocks every write control until settings are available', () => {
    const form = controls();
    syncScheduleControlState({ ...form, available: false, saving: false });

    expect(form.fields.every(field => field.disabled)).toBe(true);
    expect(form.saveButton.disabled).toBe(true);
  });

  test('keeps Save disabled during a request and after availability is revoked', () => {
    const form = controls();

    syncScheduleControlState({ ...form, available: true, saving: true });
    expect(form.fields.every(field => !field.disabled)).toBe(true);
    expect(form.saveButton.disabled).toBe(true);

    syncScheduleControlState({ ...form, available: true, saving: false });
    expect(form.saveButton.disabled).toBe(false);

    syncScheduleControlState({ ...form, available: false, saving: false });
    expect(form.saveButton.disabled).toBe(true);
  });
});

