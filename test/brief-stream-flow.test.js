import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const generateBriefMock = jest.fn();

jest.unstable_mockModule('../public/modules/core/api.js', () => ({
  generateBrief: generateBriefMock,
}));

const { getState, on, off, setState } = await import('../public/modules/core/store.js');
const { startGeneration } = await import('../public/modules/briefing/brief-stream.js');

const encode = value => new TextEncoder().encode(value);
const subscriptions = [];

function capture(event, sink) {
  const handler = payload => sink.push(payload);
  on(event, handler);
  subscriptions.push([event, handler]);
}

beforeEach(() => {
  generateBriefMock.mockReset();
  setState({ isGenerating: false, currentBrief: null });
});

afterEach(() => {
  for (const [event, handler] of subscriptions.splice(0)) off(event, handler);
});

describe('startGeneration completion boundary', () => {
  test('clean EOF without briefComplete is incomplete, never a saved briefing', async () => {
    const draft = 'Unvalidated streamed draft '.repeat(8);
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: encode(`data: ${JSON.stringify({ text: draft })}\n\n`) })
        .mockResolvedValueOnce({ done: true }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    generateBriefMock.mockResolvedValue({ body: { getReader: () => reader } });

    const errors = [];
    const generated = [];
    capture('generation-error', errors);
    capture('brief-generated', generated);

    await startGeneration();

    expect(generated).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      streamLost: true,
      accumulatedText: draft,
      message: expect.stringMatching(/before the server confirmed completion/),
    });
    expect(getState()).toMatchObject({ isGenerating: false, currentBrief: null });
  });

  test('a completed brief cannot be followed by a contradictory stream-lost error', async () => {
    const text = 'Validated completed briefing content. '.repeat(6);
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: encode(`data: ${JSON.stringify({
            briefComplete: true,
            text,
            filename: 'brief-2026-07-13-03.md',
          })}\n\ndata: [DONE]\n\n`),
        })
        .mockRejectedValueOnce(new TypeError('socket reset after completion')),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    generateBriefMock.mockResolvedValue({ body: { getReader: () => reader } });

    const errors = [];
    const generated = [];
    capture('generation-error', errors);
    capture('brief-generated', generated);

    await startGeneration();

    expect(errors).toEqual([]);
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ text, filename: 'brief-2026-07-13-03.md' });
    expect(getState()).toMatchObject({
      isGenerating: false,
      currentBrief: { content: text, filename: 'brief-2026-07-13-03.md' },
    });
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });
});
