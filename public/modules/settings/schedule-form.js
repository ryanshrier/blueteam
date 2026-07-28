// Shared state transition for the Scheduled Briefing form. Keeping this small
// and DOM-light makes the load/save race testable without a browser environment.

export function syncScheduleControlState({
  fields = [],
  saveButton = null,
  available = false,
  saving = false,
} = {}) {
  const unavailable = !available;
  for (const field of fields) {
    if (field) field.disabled = unavailable;
  }
  if (saveButton) saveButton.disabled = unavailable || Boolean(saving);
}

