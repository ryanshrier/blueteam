import { afterEach, describe, expect, jest, test } from '@jest/globals';

const generateBrief = jest.fn();
jest.unstable_mockModule('../public/modules/core/api.js', () => ({ generateBrief }));
const { startGeneration } = await import('../public/modules/briefing/brief-stream.js');
const { getState, setState, on, off } = await import('../public/modules/core/store.js');

afterEach(() => setState({ isGenerating: false, currentBrief: null }));

describe('Briefing completion publication time', () => {
  test.each(['2026-07-24T16:15:00Z', null])('uses the server publication time (%s), never client receipt time', async timestamp => {
    const completion = { briefComplete: true, text: 'Synthetic sourced assessment. '.repeat(8), filename: 'brief-2026-07-24.md', timestamp };
    const reader = {
      read: jest.fn().mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(completion)}\n\n`) }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    generateBrief.mockResolvedValue({ body: { getReader: () => reader } });
    const completed = jest.fn();
    on('brief-generated', completed);
    try {
      await startGeneration();
      expect(getState().currentBrief).toMatchObject({ filename: completion.filename, timestamp, generatedAt: timestamp });
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ timestamp }));
    } finally {
      off('brief-generated', completed);
    }
  });
});
