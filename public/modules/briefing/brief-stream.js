// BlueTeam.News — SSE stream reader + briefing generation flow.

import { getState, setState, emit } from '../core/store.js';
import { generateBrief } from '../core/api.js';

/** Read an SSE response, dispatching text/progress/completion events. */
export async function readSSEStream(response, { onText, onProgress, onComplete }) {
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  const HEARTBEAT_TIMEOUT = 90_000;
  let reader;
  let logicalEnd = false;

  // Acquiring or reading the response body is the transport boundary. Only
  // failures from that boundary (including the heartbeat timeout below) mean
  // the browser lost the SSE connection while generation may still be running.
  // Errors carried *inside* a valid SSE event are server/provider failures and
  // must keep their original classification so the UI can show the real cause.
  try {
    reader = response.body.getReader();
  } catch (err) {
    const failure = err instanceof Error ? err : new Error(String(err));
    failure.accumulatedText = accumulated;
    failure.streamLost = true;
    throw failure;
  }

  try {
    while (true) {
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Stream timed out — connection may have dropped')), HEARTBEAT_TIMEOUT);
      });
      let raceResult;
      try {
        raceResult = await Promise.race([reader.read(), timeout]);
      } catch (err) {
        const failure = err instanceof Error ? err : new Error(String(err));
        failure.streamLost = true;
        throw failure;
      } finally {
        clearTimeout(timeoutId);
      }
      const { done, value } = raceResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') {
          logicalEnd = true;
          break;
        }
        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          // Ignore an incomplete/malformed event without swallowing exceptions
          // raised by the consumers below (including their own SyntaxErrors).
          continue;
        }
        if (data.error) {
          const failure = new Error(data.error);
          if (data.code) failure.code = data.code;
          if (data.validation) failure.validation = data.validation;
          throw failure;
        }
        if (data.progress && onProgress) { onProgress(data.progress, data.stage); continue; }
        if (data.briefComplete) {
          if (onComplete) onComplete(data);
          logicalEnd = true;
          break;
        }
        if (data.text) {
          accumulated += data.text;
          if (onText) onText(accumulated, data.text);
        }
      }
      if (logicalEnd) break;
    }
  } catch (err) {
    // Release the reader for every failure and preserve whatever text arrived.
    // The read boundary above already tagged genuine transport/heartbeat failures
    // with streamLost; a server-sent generation error or consumer callback error
    // reaches here without that tag and retains its real classification.
    try { await reader.cancel(); } catch { /* already closed/errored — fine */ }
    const failure = err instanceof Error ? err : new Error(String(err));
    failure.accumulatedText = accumulated;
    throw failure;
  }
  // `briefComplete` / `[DONE]` is the protocol's logical end. Do not perform
  // another read after it: a proxy that resets the already-finished socket must
  // not turn a validated success into a second, contradictory stream-lost error.
  // Release the reader because the physical response may linger after the marker.
  if (logicalEnd) {
    try { await reader.cancel(); } catch { /* already closed/errored — fine */ }
  }
  return accumulated;
}

/** A draft is never successful until the server sends its validated completion. */
export function requireBriefComplete(completed, accumulatedText = '') {
  if (completed) return;
  const failure = new Error('Briefing stream ended before the server confirmed completion.');
  failure.streamLost = true;
  failure.accumulatedText = accumulatedText;
  throw failure;
}

export async function startGeneration() {
  if (getState().isGenerating) return;
  setState({ isGenerating: true });

  let completed = false;

  try {
    const res = await generateBrief();
    emit('generation-started');

    const fullText = await readSSEStream(res, {
      onText: (accumulated, chunk) => emit('brief-streaming', { accumulated, chunk }),
      onProgress: (progressMsg, stage) => emit('generation-progress', { progressMsg, stage }),
      onComplete: (data) => {
        const text = data.text || '';
        if (text.trim().length < 100) {
          completed = true;
          setState({ isGenerating: false });
          emit('generation-error', 'Generation returned empty content — the model may be unavailable or rate-limited.');
          return;
        }
        completed = true;
        const timestamp = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
        setState({
          isGenerating: false,
          currentBrief: { filename: data.filename || null, content: text, timestamp, model: data.model || null, costUsd: data.costUsd ?? null },
        });
        emit('brief-generated', { text, filename: data.filename, timestamp, partial: data.partial, validation: data.validation, model: data.model, tokens: data.tokens, costUsd: data.costUsd });
      },
    });

    // A clean EOF without briefComplete is still incomplete. It may be a proxy
    // close while the server continues, so retain the draft, poll History, and
    // never claim it was validated, saved, or ready.
    requireBriefComplete(completed, fullText);
  } catch (err) {
    setState({ isGenerating: false });
    // Carry the AI-disabled flag so the view can offer a Settings path, not Retry.
    // #80 — also carry streamLost + whatever text had accumulated when the connection
    // dropped: the server-side run typically continues and archives the brief anyway,
    // so a bare "failed" here (with the partial text thrown away) is actively
    // misleading — the view uses these to show a "connection lost, check History"
    // notice with the partial text still visible, instead of a dead end that invites
    // a Retry into a 429 while the original run is still completing server-side.
    emit('generation-error', {
      message: err.message || 'Failed to generate briefing.',
      aiDisabled: Boolean(err.aiDisabled),
      code: err.code || '',
      streamLost: Boolean(err.streamLost),
      accumulatedText: err.accumulatedText || '',
    });
  }
}
