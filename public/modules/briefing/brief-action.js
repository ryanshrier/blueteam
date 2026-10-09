// Presentation of explicit action fields only. The authored text and its links
// remain intact for copying and print; this helper does not infer an owner.
const CONTEXT_LABEL = 'Condition|Dependencies|Initiation|Evidence\\s*\\/\\s*artifact|Completion criterion|Recovery|Checkpoint';
const COMPLETE_LABEL = new RegExp(`^\\s*(?:${CONTEXT_LABEL})\\s*:\\s*$`, 'i');
const PLAIN_LABEL = new RegExp(`(^\\s*|[.;!?]\\s+)((?:${CONTEXT_LABEL})\\s*:)(?=\\s|$)`, 'gi');
const DEADLINE = /\b(?:\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d|today|tomorrow|tonight|(?:this|next)\s+shift|within\s+\d+\s+(?:hours?|days?)|close of business)\b/i;

function withClass(tag, name) {
  if (/\bclass\s*=\s*(["'])(.*?)\1/i.test(tag)) {
    return tag.replace(/\bclass\s*=\s*(["'])(.*?)\1/i, (attribute, quote, value) =>
      value.split(/\s+/).includes(name) ? attribute : `class=${quote}${value} ${name}${quote}`);
  }
  return tag.replace(/>$/, ` class="${name}">`);
}

function labelContexts(html) {
  // Respect quoted attribute values and existing inline links/emphasis. Plain
  // field labels are styled only at a paragraph or sentence boundary.
  const tokens = html.split(/(<(?:[^>"']|"[^"]*"|'[^']*')*>)/g);
  const protectedTags = new Set(['a', 'strong', 'code', 'pre', 'script', 'style']);
  const active = [];
  return tokens.map((token, index) => {
    const tag = token.match(/^<\s*(\/?)\s*([\w-]+)\b/i);
    if (tag) {
      const name = tag[2].toLowerCase();
      if (!tag[1] && name === 'strong' && !active.length && COMPLETE_LABEL.test(tokens[index + 1] || '')
        && /^<\/strong\s*>$/i.test(tokens[index + 2] || '')) {
        token = withClass(token, 'brief-action-context-label');
      }
      if (protectedTags.has(name)) {
        if (tag[1]) {
          const last = active.lastIndexOf(name);
          if (last >= 0) active.splice(last, 1);
        } else if (!/\/\s*>$/.test(token)) active.push(name);
      }
      return token;
    }
    if (active.length || token.startsWith('<')) return token;
    return token.replace(PLAIN_LABEL, '$1<strong class="brief-action-context-label">$2</strong>');
  }).join('');
}

/** Wrap only explicit, spaced owner/action/target syntax, including a Markdown
 * list item's paragraph wrapper. Never remove or reorder authored content. */
export function actionRoleHtml(html) {
  let source = String(html || '');
  if (!/brief-action-owner|brief-action-target/.test(source)) {
    const match = source.match(/^(\s*(?:<p\b[^>]*>\s*)?)(<strong\b[^>]*>)?([^<>]{1,80}?)(<\/strong>)?(\s+[—–]\s+)([\s\S]+)$/i);
    if (match) {
      let body = match[6];
      const tail = body.match(/(\s+[—–]\s+)([^<>]+)((?:<\/p>\s*)?)$/i);
      if (tail && DEADLINE.test(tail[2])) {
        body = body.slice(0, tail.index) + `<span class="brief-action-target">${tail[1]}${tail[2]}</span>${tail[3]}`;
      }
      const owner = match[2]
        ? `${withClass(match[2], 'brief-action-owner')}${match[3]}${match[4] || ''}`
        : `<strong class="brief-action-owner">${match[3]}</strong>`;
      source = `${match[1]}${owner}${match[5]}${body}`;
    }
  }
  return labelContexts(source);
}
