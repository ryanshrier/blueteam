// Apply before parsing/normalizing untrusted model output or operator edits.
// Byte limits alone do not bound Markdown/HTML parser work.
export const BRIEF_INPUT_LIMITS = Object.freeze({ maxBytes: 500_000, maxMarkupStarts: 8_000, maxDelimiterRun: 256 });

export function assertBriefInput(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > BRIEF_INPUT_LIMITS.maxBytes) {
    throw Object.assign(new Error('Briefing content exceeds its retention limit.'), { code: 'E_BRIEF_INPUT_LIMIT' });
  }
  let markup = 0, run = 0, previous = '';
  for (const char of value) {
    if (char === '<' || char === '[' || char === '`' || char === '*') {
      if (++markup > BRIEF_INPUT_LIMITS.maxMarkupStarts) {
        throw Object.assign(new Error('Briefing markup exceeds its complexity limit.'), { code: 'E_BRIEF_INPUT_LIMIT' });
      }
      run = char === previous ? run + 1 : 1;
      if (run > BRIEF_INPUT_LIMITS.maxDelimiterRun) {
        throw Object.assign(new Error('Briefing markup exceeds its complexity limit.'), { code: 'E_BRIEF_INPUT_LIMIT' });
      }
    } else run = 0;
    previous = char;
  }
  return value;
}

// Linear scan rather than retrying an HTML-tag regexp at every unmatched '<'.
// Preserve unterminated markup as text so malformed input cannot hide claims.
export function stripFactHtml(value) {
  const pieces = [];
  let start = 0, tag = -1, quote = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (tag < 0) {
      if (char !== '<') continue;
      if (value.startsWith('<!--', index)) {
        const end = value.indexOf('-->', index + 4);
        if (end >= 0) {
          pieces.push(value.slice(start, index));
          index = end + 2; start = index + 1;
          continue;
        }
      }
      pieces.push(value.slice(start, index)); tag = index; quote = '';
    } else if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') { tag = -1; start = index + 1; }
  }
  pieces.push(value.slice(tag >= 0 ? tag : start));
  return pieces.join('');
}
