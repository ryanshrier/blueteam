// A fragment is a citation boundary only when a feed supplies distinct headings
// at different anchors in the same document. Ordinary article jumps stay aliases.
export function canonicalPublisherUrl(value, anchor = '') {
  try {
    const url = new URL(typeof value === 'string' ? value.slice(0, 4096) : '');
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    url.hash = anchor;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|dclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

export function candidateAnchor(link) {
  if (typeof link !== 'string') return '';
  const hash = link.indexOf('#');
  if (hash < 0) return '';
  if (link.length - hash > 129) return '';
  try {
    const anchor = new URL(link).hash.slice(1);
    const id = decodeURIComponent(anchor);
    if (anchor.length > 128 || !/^[\p{L}\p{M}\p{N}_.-]+$/u.test(id)) return '';
    return /^(?:top|main|content|comments?|respond|reply|disqus_thread|comment-.*)$/i.test(id) ? '' : anchor;
  } catch { return ''; }
}

export function sectionAnchor(item) {
  const anchor = candidateAnchor(item?.link || item?.url || item?.canonicalUrl);
  return anchor && anchor === item.sectionAnchor ? anchor : '';
}

export function markPublisherSections(items) {
  const documents = new Map();
  for (const item of items) {
    const anchor = candidateAnchor(item.link);
    if (!anchor || typeof item.title !== 'string' || !item.title) continue;
    const document = canonicalPublisherUrl(item.link);
    if (!document) continue;
    const key = `${item.feedUrl || item.source || ''}\u0000${document}`;
    if (!documents.has(key)) documents.set(key, []);
    documents.get(key).push({ item, anchor, title: item.title.normalize('NFKC').toLowerCase().trim() });
  }
  for (const rows of documents.values()) {
    if (rows.length < 2) continue;
    const anchorsByHeading = new Map();
    for (const { title, anchor } of rows) {
      if (!anchorsByHeading.has(title)) anchorsByHeading.set(title, new Set());
      anchorsByHeading.get(title).add(anchor);
    }
    const distinct = new Set([...anchorsByHeading.values()].filter(anchors => anchors.size === 1).map(anchors => [...anchors][0]));
    if (distinct.size < 2) continue;
    for (const row of rows) {
      if (distinct.has(row.anchor)) row.item.sectionAnchor = row.anchor;
    }
  }
  return items;
}

// Limit conflict detection to explicit assertions about the same disclosure.
// An uncertain report of possible exposure cannot establish either position.
export function exposurePositions(headline) {
  const positions = new Set();
  const text = [headline?.title, headline?.passage || headline?.description].filter(v => typeof v === 'string').map(v => v.slice(0, 8192)).join('. ').slice(0, 8192);
  if (!/\b(?:exposed|stolen|compromised|disclosed|accessed)\b/i.test(text)) return positions;
  const assertion = /\b(?:(customer|employee|payment|financial|medical|personal|user)\s+)?(records?|data|credentials?)\s+(?:were|was|are|is|have been|has been)\s+(not\s+|never\s+)?(exposed|stolen|compromised|disclosed|accessed)\b/gi;
  for (const sentence of text.split(/[.?!;\n]+/)) {
    if (/\b(?:whether|if|no evidence|no indication|denies|denied|unclear|unconfirmed)\b/i.test(sentence)) continue;
    for (const match of sentence.matchAll(assertion)) {
      positions.add(`${match[3] ? '-' : '+'}${(match[1] || '').toLowerCase()}:${match[2].toLowerCase().replace(/s$/, '')}:${match[4].toLowerCase()}`);
    }
  }
  return positions;
}

export function opposingExposure(left, right) {
  for (const position of left) {
    if (!right.has(position) && right.has((position[0] === '+' ? '-' : '+') + position.slice(1))) return true;
  }
  return false;
}

export function disputedExposure(positions) {
  return [...positions].some(position => position[0] === '+' && positions.has('-' + position.slice(1)));
}

export function incompatibleExposure(left, right, sameArticle = false) {
  if (disputedExposure(left) || disputedExposure(right)) {
    // Two identical observations of a disputed article can still be deduplicated.
    return !sameArticle || left.size !== right.size || [...left].some(position => !right.has(position));
  }
  return opposingExposure(left, right);
}
