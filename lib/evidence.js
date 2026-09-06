// Local evidence retained before headline grouping. Passages are collected feed
// excerpts (normalized plain text), never inferred to be the original article.
import { createHash } from 'crypto';
import * as database from './db.js';
import { normalizeFeedTimestamp } from './intelligence-context.js';

export const EVIDENCE_RETENTION = Object.freeze({ days: 30, maxRevisionsPerSource: 8, maxSources: 5000 });
export const EVIDENCE_PASSAGE_LIMIT = 8192;
const digest = value => createHash('sha256').update(value).digest('hex');
const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const timestamp = value => {
  return normalizeFeedTimestamp(bounded(value, 256));
};

/** Conservative URL identity: remove fragments and known tracking parameters;
 * preserve protocol, path, meaningful query parameters, and trailing slashes. */
export function canonicalSourceUrl(value) {
  try {
    const url = new URL(bounded(value, 4096));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

// Configured feeds can carry scoped query credentials. Keep identity matching
// local; inspection/receipts must not publish those values to a shared display.
function inspectableUrl(value) {
  const canonical = canonicalSourceUrl(value);
  if (!canonical) return null;
  const url = new URL(canonical);
  for (const key of [...url.searchParams.keys()]) {
    if (/token|secret|password|credential|signature|api[-_]?key|authorization/i.test(key)) url.searchParams.set(key, '[REDACTED]');
  }
  return url.href;
}

export function sourceIdentity(item) {
  const canonicalUrl = canonicalSourceUrl(item.link || item.canonicalUrl);
  const feedUrl = canonicalSourceUrl(item.feedUrl);
  const identifier = bounded(item.sourceIdentifier || item.guid || item.id, 1024).trim();
  const scope = feedUrl || bounded(item.source, 128).toLowerCase();
  const aliases = [];
  if (canonicalUrl) aliases.push(`url:${canonicalUrl}`);
  if (identifier && scope) aliases.push(`identifier:${scope}\u0000${identifier}`);
  // A title-based fallback is deliberately conservative: without a URL or ID a
  // changed title cannot be asserted to represent the same publisher object.
  if (!aliases.length) {
    const title = bounded(item.title, 512).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    aliases.push(`fingerprint:${digest(`${scope}\u0000${title}`)}`);
  }
  return { sourceId: `src_${digest(aliases[0])}`, aliases: aliases.map(digest), canonicalUrl, feedUrl, identifier: identifier || null };
}

function revisionRef(source, revision) {
  const previous = revision.previous_revision_id
    ? database.getDB().prepare('SELECT title, passage, passage_kind, passage_truncated FROM evidence_revisions WHERE revision_id = ?').get(revision.previous_revision_id) : null;
  return {
    sourceId: source.source_id, revisionId: revision.revision_id,
    source: revision.source, title: revision.title, canonicalUrl: inspectableUrl(revision.canonical_url),
    passageKind: revision.passage_kind, changed: Boolean(revision.previous_revision_id),
    ...classifyEvidenceChange(previous, revision),
    publishedAt: revision.published_at, retrievedAt: revision.retrieved_at,
    firstObservedAt: source.first_observed_at, lastObservedAt: source.last_observed_at,
  };
}

/** Capture fresh or cached observations without changing retained passage text.
 * Unchanged observations extend last-observed time; only changed title/passage
 * content creates a revision. Reverting A -> B -> A creates a third revision. */
export function observeSources(items, { observedAt = new Date().toISOString(), retention = {} } = {}) {
  const db = database.getDB();
  const now = timestamp(observedAt);
  if (!now) throw new TypeError('observedAt must be a valid timestamp');
  const refs = db.transaction(() => items.map(item => {
    const identity = sourceIdentity(item);
    let source;
    for (const alias of identity.aliases) {
      source = db.prepare('SELECT s.* FROM evidence_aliases a JOIN evidence_sources s USING(source_id) WHERE alias_key = ?').get(alias);
      if (source) break;
    }
    const sourceId = source?.source_id || identity.sourceId;
    // Cached fallback carries its original retrieval time. Re-reading local
    // cache must not pretend the publisher was observed again during an outage.
    const observed = timestamp(item.retrievedAt) || now;
    const sourceLabel = bounded(item.source, 128) || 'Unknown source';
    if (!source) {
      db.prepare('INSERT INTO evidence_sources(source_id,canonical_url,source,first_observed_at,last_observed_at) VALUES (?,?,?,?,?)')
        .run(sourceId, identity.canonicalUrl, sourceLabel, observed, observed);
      source = db.prepare('SELECT * FROM evidence_sources WHERE source_id = ?').get(sourceId);
    }
    for (const alias of identity.aliases) {
      db.prepare('INSERT OR IGNORE INTO evidence_aliases(alias_key,source_id) VALUES (?,?)').run(alias, sourceId);
    }
    // Keep aliases bounded even if a feed repeatedly changes a GUID or URL.
    db.prepare('DELETE FROM evidence_aliases WHERE source_id = ? AND rowid NOT IN (SELECT rowid FROM evidence_aliases WHERE source_id = ? ORDER BY rowid DESC LIMIT 32)').run(sourceId, sourceId);
    const title = bounded(item.title, 512);
    const excerpt = typeof item.passage === 'string' ? item.passage : bounded(item.description, EVIDENCE_PASSAGE_LIMIT);
    const passage = bounded(excerpt || title, EVIDENCE_PASSAGE_LIMIT);
    const passageKind = excerpt ? 'feed-excerpt' : 'title-only';
    const truncated = Boolean(item.passageTruncated || excerpt.length > EVIDENCE_PASSAGE_LIMIT);
    const contentHash = digest(JSON.stringify([title, passage, passageKind, truncated]));
    // One article can appear in RSS and title-only discovery, or two feeds can
    // publish different excerpts. Compare like representations so they do not
    // manufacture alternating "changes" each time both feeds are collected.
    let revision = db.prepare('SELECT * FROM evidence_revisions WHERE source_id = ? AND feed_url IS ? AND passage_kind = ? ORDER BY revision_number DESC LIMIT 1')
      .get(sourceId, identity.feedUrl, passageKind);
    // An older stale feed copy must not roll a newer publisher revision back.
    if (revision && observed < revision.first_observed_at) {
      const retained = db.prepare('SELECT * FROM evidence_revisions WHERE source_id = ? AND feed_url IS ? AND content_hash = ? AND first_observed_at <= ? ORDER BY revision_number DESC LIMIT 1')
        .get(sourceId, identity.feedUrl, contentHash, observed);
      // A stale member still contains its OLD passage. Never cite the newer
      // revision for that text; if retention removed it, expose no reference.
      return retained ? revisionRef(source, retained) : null;
    }
    if (!revision || revision.content_hash !== contentHash) {
      const number = source.revision_number + 1;
      const revisionId = `rev_${digest(`${sourceId}\u0000${number}\u0000${contentHash}`)}`;
      db.prepare(`INSERT INTO evidence_revisions
        (revision_id,source_id,revision_number,content_hash,title,source,canonical_url,feed_url,source_identifier,passage,passage_kind,passage_truncated,published_at,source_updated_at,retrieved_at,first_observed_at,last_observed_at,previous_revision_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        revisionId, sourceId, number, contentHash, title, sourceLabel, identity.canonicalUrl, identity.feedUrl, identity.identifier,
        passage, passageKind, Number(truncated), timestamp(item.date), timestamp(item.sourceUpdatedAt), timestamp(item.retrievedAt), observed, observed, revision?.revision_id || null,
      );
      db.prepare('UPDATE evidence_sources SET latest_revision_id = ?, revision_number = ? WHERE source_id = ?').run(revisionId, number, sourceId);
      revision = db.prepare('SELECT * FROM evidence_revisions WHERE revision_id = ?').get(revisionId);
    } else {
      db.prepare('UPDATE evidence_revisions SET last_observed_at = MAX(last_observed_at,?) WHERE revision_id = ?').run(observed, revision.revision_id);
    }
    db.prepare('UPDATE evidence_sources SET last_observed_at = MAX(last_observed_at,?), canonical_url = COALESCE(?,canonical_url), source = ? WHERE source_id = ?')
      .run(observed, identity.canonicalUrl, sourceLabel, sourceId);
    source = db.prepare('SELECT * FROM evidence_sources WHERE source_id = ?').get(sourceId);
    return revisionRef(source, revision);
  }))();
  pruneEvidence({ ...retention, now });
  // Mutation happens only after a successful transaction, so callers never
  // advertise partially persisted evidence when storage fails mid-observation.
  items.forEach((item, i) => { item.evidence = refs[i] ? [refs[i]] : []; });
  return refs;
}

export function pruneEvidence({ now = new Date().toISOString(), days = EVIDENCE_RETENTION.days,
  maxRevisionsPerSource = EVIDENCE_RETENTION.maxRevisionsPerSource, maxSources = EVIDENCE_RETENTION.maxSources } = {}) {
  const cap = (value, maximum) => Math.max(1, Math.min(maximum, Math.floor(Number(value)) || maximum));
  const cutoff = new Date(Date.parse(now) - cap(days, EVIDENCE_RETENTION.days) * 86400_000).toISOString();
  const db = database.getDB();
  db.transaction(() => {
    db.prepare('DELETE FROM evidence_sources WHERE last_observed_at < ?').run(cutoff);
    db.prepare('DELETE FROM evidence_sources WHERE source_id NOT IN (SELECT source_id FROM evidence_sources ORDER BY last_observed_at DESC, source_id LIMIT ?)')
      .run(cap(maxSources, EVIDENCE_RETENTION.maxSources));
    db.prepare(`DELETE FROM evidence_revisions WHERE revision_id IN (
      SELECT revision_id FROM (SELECT revision_id, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY revision_number DESC) AS n FROM evidence_revisions) WHERE n > ?
    )`).run(cap(maxRevisionsPerSource, EVIDENCE_RETENTION.maxRevisionsPerSource));
  })();
}

/** A bounded, deterministic single changed span with surrounding exact text. */
export function comparePassages(previous, current) {
  if (previous === current) return null;
  let start = 0;
  while (start < previous.length && start < current.length && previous[start] === current[start]) start++;
  let end = 0;
  while (end < previous.length - start && end < current.length - start && previous[previous.length - end - 1] === current[current.length - end - 1]) end++;
  return { before: current.slice(0, start), removed: previous.slice(start, previous.length - end), added: current.slice(start, current.length - end), after: end ? current.slice(-end) : '' };
}

/** Describe the capture delta without claiming a material threat development. */
export function classifyEvidenceChange(previous, current) {
  if (!previous) return { changeKind: current.previous_revision_id ? 'previous-unavailable' : 'first-observation', materialChange: 'unassessed' };
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const before = clean(previous.passage), after = clean(current.passage);
  // Older captures used a literal ellipsis instead of passage_truncated. Ignore
  // only that marker when comparing prefixes; retained text and diffs stay exact.
  const beforePrefix = before.replace(/(?:\.{3}|…)$/, '').trimEnd();
  const afterPrefix = after.replace(/(?:\.{3}|…)$/, '').trimEnd();
  const titleChanged = clean(previous.title) !== clean(current.title);
  const changeKind = titleChanged ? 'title-changed'
    : before === after ? 'capture-metadata-changed'
      : beforePrefix.length > 0 && after.startsWith(beforePrefix) ? 'capture-expanded'
        : afterPrefix.length > 0 && before.startsWith(afterPrefix) ? 'capture-shortened' : 'source-text-changed';
  return { changeKind, materialChange: 'unassessed' };
}

export function getSourceEvidence(sourceId) {
  const db = database.getDB();
  const source = db.prepare('SELECT * FROM evidence_sources WHERE source_id = ?').get(sourceId);
  if (!source) return null;
  const rows = db.prepare('SELECT * FROM evidence_revisions WHERE source_id = ? ORDER BY revision_number DESC').all(sourceId);
  const byId = new Map(rows.map(row => [row.revision_id, row]));
  return {
    sourceId, canonicalUrl: inspectableUrl(source.canonical_url), source: source.source,
    firstObservedAt: source.first_observed_at, lastObservedAt: source.last_observed_at,
    latestRevisionId: source.latest_revision_id, retention: EVIDENCE_RETENTION,
    revisions: rows.map(row => {
      const previous = byId.get(row.previous_revision_id);
      return {
        revisionId: row.revision_id, sourceId, title: row.title, source: row.source,
        canonicalUrl: inspectableUrl(row.canonical_url), feedUrl: inspectableUrl(row.feed_url),
        sourceIdentifier: inspectableUrl(row.source_identifier) || row.source_identifier,
        passage: row.passage, passageKind: row.passage_kind, passageTruncated: Boolean(row.passage_truncated),
        publishedAt: row.published_at, sourceUpdatedAt: row.source_updated_at, retrievedAt: row.retrieved_at,
        firstObservedAt: row.first_observed_at, lastObservedAt: row.last_observed_at,
        changed: Boolean(row.previous_revision_id), previousRevisionId: row.previous_revision_id,
        ...classifyEvidenceChange(previous, row),
        previousPassage: previous?.passage ?? null,
        changes: previous ? comparePassages(previous.passage, row.passage) : null,
      };
    }),
  };
}
