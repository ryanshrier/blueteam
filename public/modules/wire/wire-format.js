// BlueTeam.News — Wire view: pure data/format helpers, extracted from wire-view.js so
// they carry NO DOM dependency and can be unit-tested directly (test/wire-format.test.js).
// The view layer imports these and wraps their output in markup; nothing here touches
// the document, window, or `location`.

// ── The deep-link contract: which filter/sort values are valid in the hash. ──
export const VALID_HORIZONS = new Set(['all', '1', '2', '3']);
export const VALID_SORTS = new Set(['relevance', 'newest']);

// ── Time: parse a date string to epoch ms, 0 when absent/unparseable. ──
export function dateMs(dateStr) {
  const t = dateStr ? Date.parse(dateStr) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// A stable identity for a signal across loads: the link, or the title as
// fallback. Exported so the view's read/dismiss persistence (keyed by this same
// identity) and filterSignals' unread/dismissed filtering agree on one definition.
export function sigKey(h) { return (h && (h.link || h.title)) || ''; }

// ── The freeform `cveData` string → structured fields. The pipeline emits one human
// string ("CVE-2026-1234 · CVSS 9.8 (Critical) · exploit references exist · Affects: …");
// the row renders the parts. Type-guarded so a non-string field can never throw on
// .match() and blank the row. ──
export function parseCveData(cveData) {
  const data = typeof cveData === 'string' ? cveData : '';
  const cve = (data.match(/CVE-\d{4}-\d{4,7}/i) || [])[0] || '';
  const cvss = (data.match(/CVSS\s+([\d.]+)/i) || [])[1] || '';
  const sev = (data.match(/\(([A-Za-z]+)\)/i) || [])[1] || '';
  const exploit = /exploit references exist/i.test(data);
  let affects = ((data.match(/Affects:\s*([^—]+?)(?:\s+—|$)/i) || [])[1] || '')
    .replace(/\s*·?\s*CVE-\d{4}-\d{4,7}:.*$/i, '')   // strip a secondary "· CVE-…: CVSS …" that bleeds in
    .trim();
  return { raw: data, cve, cvss, sev, exploit, affects };
}

// ── Filtering / sorting — pure over (headlines, filters, sortMode). ──
// dismissedKeys (a Set of sigKey() identities) is ALWAYS applied, independent
// of the "Unread" toggle: a dismissed signal is hidden from every view until the undo
// chip restores it. filters.unread additionally hides anything in readKeys (a Set of
// sigKey() identities the analyst has already seen/opened). Both sets default to
// empty so a caller that doesn't pass them gets the same behavior unchanged.
export function filterSignals(headlines, filters = {}, sortMode = 'relevance') {
  let items = (Array.isArray(headlines) ? headlines : []).slice();
  if (filters.horizon && filters.horizon !== 'all') items = items.filter(h => String(h.horizon) === String(filters.horizon));
  if (filters.critical) items = items.filter(h => h.urgency === 'critical');
  if (filters.kev) items = items.filter(h => h.isKEV);
  const dismissedKeys = filters.dismissedKeys instanceof Set ? filters.dismissedKeys : null;
  if (dismissedKeys && dismissedKeys.size) items = items.filter(h => !dismissedKeys.has(sigKey(h)));
  if (filters.unread) {
    const readKeys = filters.readKeys instanceof Set ? filters.readKeys : null;
    if (readKeys) items = items.filter(h => !readKeys.has(sigKey(h)));
  }
  // Free-text `q`: case-insensitive substring over the title, description, and the
  // freeform cveData (so a bare "CVE-2026-1234" or a vendor keyword deep-links). Each
  // field is guarded to a string so a structured/absent field can't throw on .includes().
  const q = typeof filters.q === 'string' ? filters.q.trim().toLowerCase() : '';
  if (q) {
    items = items.filter(h => {
      const hay = [h && h.title, h && h.description, h && h.cveData]
        .filter(v => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }
  if (sortMode === 'newest') items.sort((a, b) => dateMs(b.date) - dateMs(a.date));
  return items;
}

// ── Deep-link query ⇄ state. Parse is defensive: any unknown or malformed param
// falls back to its default rather than throwing. ──
export function parseWireQuery(search) {
  const out = { horizon: 'all', critical: false, kev: false, unread: false, sort: 'relevance', q: '' };
  const s = typeof search === 'string' ? search : '';
  const query = s.startsWith('?') ? s.slice(1) : s;
  if (!query) return out;
  let params;
  try { params = new URLSearchParams(query); } catch { return out; }
  const h = params.get('h');
  if (h != null && VALID_HORIZONS.has(h)) out.horizon = h;
  out.critical = params.get('critical') === '1';
  out.kev = params.get('kev') === '1';
  out.unread = params.get('unread') === '1';   // deep-linkable like critical/kev
  const sort = params.get('sort');
  if (sort != null && VALID_SORTS.has(sort)) out.sort = sort;
  // Free-text query, trimmed and capped at 100 chars (a deep-link, not a payload).
  const q = params.get('q');
  if (q != null) out.q = String(q).trim().slice(0, 100);
  return out;
}

export function serializeWireUrl(filters = {}, sortMode = 'relevance') {
  const params = new URLSearchParams();
  if (filters.horizon && filters.horizon !== 'all') params.set('h', filters.horizon);
  if (filters.critical) params.set('critical', '1');
  if (filters.kev) params.set('kev', '1');
  if (filters.unread) params.set('unread', '1');
  if (sortMode && sortMode !== 'relevance') params.set('sort', sortMode);
  const q = typeof filters.q === 'string' ? filters.q.trim() : '';
  if (q) params.set('q', q);   // write the free-text filter so a searched view deep-links
  const qs = params.toString();
  return qs ? `/wire?${qs}` : '/wire';
}

// ── CSV export — RFC-4180 quoting + spreadsheet-formula-injection defense. ──
// cveData/kevDueDate/kevOverdue/vendors/actors/description are the fields an
// analyst actually needs for the paste-into-ticket workflow (CVSS, remediation due
// date, affected vendor) — omitting them forced a re-lookup of work the pipeline
// already did.
export const CSV_COLUMNS = [
  'score', 'horizon', 'urgency', 'isKEV', 'kevCVE', 'corroboration', 'title', 'description',
  'source', 'sources', 'link', 'date', 'cveData', 'kevDueDate', 'kevOverdue', 'vendors', 'actors',
];

export function csvCell(value) {
  if (value == null) return '';
  // An object cell (a future structured column) serializes as JSON, never "[object Object]".
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Defuse formula injection: spreadsheet engines can treat =/+/-/@ and leading
  // tab/newline controls as formulas or commands. Prefix the complete cell with a
  // quote before RFC-4180 escaping so exported feed text always opens as data.
  if (/^[=+\-@\t\r\n]/.test(s)) s = `'${s}`;
  // RFC-4180: wrap in quotes when the cell holds a comma, quote, or newline; double embedded quotes.
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// vendors/actors are arrays of {name, ...} objects (see vendorChips/the actor
// hedge text in wire-view.js), not plain strings like `sources`. A bare .join('; ')
// would stringify each element via its object .toString() and emit "[object Object]"
// per entry, so pull .name (or .label as an escape hatch) before joining; anything
// without a usable name falls back to a JSON blob rather than silently dropping it.
function joinArrayCell(arr) {
  return arr.map(v => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.name || v.label || JSON.stringify(v);
    return String(v);
  }).join('; ');
}

export function toCsv(items, columns = CSV_COLUMNS) {
  const lines = [columns.join(',')];
  for (const h of (Array.isArray(items) ? items : [])) {
    lines.push(columns.map(col => csvCell(Array.isArray(h[col]) ? joinArrayCell(h[col]) : h[col])).join(','));
  }
  return lines.join('\r\n');
}
