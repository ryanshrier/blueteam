// Shared publication labels. An edition date is a calendar label, not evidence
// of a midnight publication; only a timestamp with a timezone supplies a time.
export function formatBriefLabel(value) {
  const raw = typeof value === 'string' ? value : '';
  const match = raw.match(/(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?/);
  if (!match) return '';
  const [, year, month, day, sequence] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return '';
  const label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return sequence && Number(sequence) > 1 ? `${label} · brief ${Number(sequence)}` : label;
}

export function formatBriefPublishedAt(value) {
  if (typeof value !== 'string' || !/T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23' });
  return `${day}, ${time} UTC`;
}

// Archive responses also expose generatedAt with a legacy file-mtime fallback.
// A copied or edited file's modification time does not prove publication time.
export function archivePublishedAt(brief) {
  const timestamp = brief?.meta?.generated_at;
  return formatBriefPublishedAt(timestamp) ? timestamp : null;
}

export function formatBriefPublication({ generatedAt, timestamp, filename, date } = {}) {
  const published = formatBriefPublishedAt(generatedAt || timestamp);
  if (published) return `Briefing published ${published}`;
  const edition = formatBriefLabel(filename || date);
  return edition ? `Briefing · ${edition}` : 'Briefing date unavailable';
}
