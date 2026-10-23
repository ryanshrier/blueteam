// Offline normalized-event fixtures. This module never imports an operator
// adapter, starts a process, or makes a network request.
export const MAX_PROVIDER_REPLAY_BYTES = 4 * 1024 * 1024;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const events = new Set(['message_start', 'content_block_delta', 'message_delta', 'message_stop']);

export function parseProviderReplay(serialized) {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > MAX_PROVIDER_REPLAY_BYTES) throw new Error('Provider replay exceeds its size bound.');
  const replay = JSON.parse(serialized);
  if (!plain(replay) || replay.schemaVersion !== 1 || typeof replay.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(replay.model)
    || !Array.isArray(replay.cases) || !replay.cases.length || replay.cases.length > 100) throw new Error('Provider replay needs schemaVersion 1, a model, and bounded cases.');
  const ids = new Set();
  for (const item of replay.cases) {
    if (!plain(item) || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(item.id) || ids.has(item.id)
      || !Array.isArray(item.attempts) || !item.attempts.length || item.attempts.length > 2) throw new Error('Each replay case needs a unique synthetic case ID and one or two attempts.');
    ids.add(item.id);
    for (const attempt of item.attempts) {
      if (!Array.isArray(attempt) || attempt.length > 10000 || attempt.some(event => !plain(event) || !events.has(event.type)
        || (event.type === 'content_block_delta' && (typeof event.delta?.text !== 'string' || event.delta.text.length > 500000)))) {
        throw new Error('Replay attempts must contain bounded normalized provider events.');
      }
    }
  }
  return replay;
}

export async function* replayProviderEvents(replay, caseId, attemptIndex, { signal } = {}) {
  const events = replay.cases.find(item => item.id === caseId)?.attempts[attemptIndex];
  if (!events) throw Object.assign(new Error('No recorded response exists for this replay attempt.'), { reason: 'Offline replay has no next recorded attempt.' });
  for (const event of events) {
    if (signal?.aborted) throw signal.reason || new Error('Offline replay cancelled.');
    yield structuredClone(event);
  }
}
