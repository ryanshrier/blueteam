// BlueTeam.News — SSE stream reader + briefing generation flow.

import { getState, setState, emit } from '../core/store.js';
import { generateBrief } from '../core/api.js';

/** Read an SSE response, dispatching text/progress/completion events. */
export async function readSSEStream(response, { onText, onProgress, onComplete }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  const HEARTBEAT_TIMEOUT = 90_000;

  try {
    while (true) {
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Stream timed out — connection may have dropped')), HEARTBEAT_TIMEOUT);
      });
      let raceResult;
      try {
        raceResult = await Promise.race([reader.read(), timeout]);
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
        if (payload === '[DONE]') continue;
        try {
          const data = JSON.parse(payload);
          if (data.error) throw new Error(data.error);
          if (data.progress && onProgress) { onProgress(data.progress, data.stage); continue; }
          if (data.briefComplete && onComplete) { onComplete(data); continue; }
          if (data.text) {
            accumulated += data.text;
            if (onText) onText(accumulated, data.text);
          }
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
    }
  } catch (err) {
    // #80 — a heartbeat timeout or dropped connection here does NOT mean generation
    // failed: the server-side run typically keeps going and archives the brief once
    // it finishes, independent of this client connection. Cancel the reader (leaving
    // response.body open otherwise holds the TCP connection/socket) and attach the
    // text accumulated so far to the error, so the caller can show it instead of
    // discarding a mostly-complete brief.
    try { await reader.cancel(); } catch { /* already closed/errored — fine */ }
    err.accumulatedText = accumulated;
    err.streamLost = true;
    throw err;
  }
  return accumulated;
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

    // Fallback if the server never sent briefComplete
    if (!completed) {
      setState({ isGenerating: false });
      if (!fullText || fullText.trim().length < 100) {
        emit('generation-error', 'Generation returned empty content — the model may be unavailable or rate-limited.');
        return;
      }
      const timestamp = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      setState({ currentBrief: { filename: null, content: fullText, timestamp } });
      emit('brief-generated', { text: fullText, filename: null, timestamp });
    }
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
      streamLost: Boolean(err.streamLost),
      accumulatedText: err.accumulatedText || '',
    });
  }
}
