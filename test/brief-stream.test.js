import { describe, test, expect, jest } from '@jest/globals';
import { readSSEStream, requireBriefComplete } from '../public/modules/briefing/brief-stream.js';

const encode = value => new TextEncoder().encode(value);

function responseWithReader(reader) {
  return { body: { getReader: () => reader } };
}

async function caught(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe('readSSEStream error classification', () => {
  test('preserves a server-sent provider error instead of calling it a lost connection', async () => {
    const reader = {
      read: jest.fn().mockResolvedValueOnce({
        done: false,
        value: encode('data: {"text":"Partial draft"}\n\ndata: {"error":"Provider overloaded (529)","code":"E_PROVIDER"}\n\n'),
      }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    const err = await caught(readSSEStream(responseWithReader(reader), {}));

    expect(err).toMatchObject({
      message: 'Provider overloaded (529)',
      code: 'E_PROVIDER',
      accumulatedText: 'Partial draft',
    });
    expect(err.streamLost).toBeUndefined();
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });

  test('marks a reader rejection as a lost stream and retains partial text', async () => {
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({ done: false, value: encode('data: {"text":"Partial draft"}\n\n') })
        .mockRejectedValueOnce(new TypeError('network connection terminated')),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    await expect(readSSEStream(responseWithReader(reader), {})).rejects.toMatchObject({
      message: 'network connection terminated',
      streamLost: true,
      accumulatedText: 'Partial draft',
    });
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });

  test('marks a heartbeat timeout as a lost stream', async () => {
    jest.useFakeTimers();
    try {
      const reader = {
        read: jest.fn(() => new Promise(() => {})),
        cancel: jest.fn().mockResolvedValue(undefined),
      };
      const result = caught(readSSEStream(responseWithReader(reader), {}));

      await jest.advanceTimersByTimeAsync(90_000);

      expect(await result).toMatchObject({
        message: expect.stringMatching(/Stream timed out/),
        streamLost: true,
      });
      expect(reader.cancel).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not misclassify a consumer callback error as a transport loss', async () => {
    const callbackError = new Error('render callback failed');
    const reader = {
      read: jest.fn().mockResolvedValueOnce({
        done: false,
        value: encode('data: {"text":"A chunk"}\n\n'),
      }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    const err = await caught(readSSEStream(responseWithReader(reader), {
      onText: () => { throw callbackError; },
    }));

    expect(err).toBe(callbackError);
    expect(err.streamLost).toBeUndefined();
    expect(err.accumulatedText).toBe('A chunk');
  });

  test('does not swallow a SyntaxError raised by a consumer callback', async () => {
    const callbackError = new SyntaxError('renderer rejected invalid markup');
    const reader = {
      read: jest.fn().mockResolvedValueOnce({
        done: false,
        value: encode('data: {"text":"A chunk"}\n\n'),
      }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    const err = await caught(readSSEStream(responseWithReader(reader), {
      onText: () => { throw callbackError; },
    }));

    expect(err).toBe(callbackError);
    expect(err.streamLost).toBeUndefined();
    expect(err.accumulatedText).toBe('A chunk');
  });

  test('stops at logical completion instead of reading into a later socket reset', async () => {
    const completed = jest.fn();
    const reader = {
      read: jest.fn()
        .mockResolvedValueOnce({
          done: false,
          value: encode('data: {"briefComplete":true,"text":"Validated brief"}\n\ndata: [DONE]\n\n'),
        })
        .mockRejectedValueOnce(new TypeError('socket reset after completion')),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    await expect(readSSEStream(responseWithReader(reader), { onComplete: completed }))
      .resolves.toBe('');
    expect(completed).toHaveBeenCalledWith({ briefComplete: true, text: 'Validated brief' });
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });

  test('still propagates a consumer error raised by the completion callback', async () => {
    const callbackError = new SyntaxError('completed render rejected invalid markup');
    const reader = {
      read: jest.fn().mockResolvedValueOnce({
        done: false,
        value: encode('data: {"briefComplete":true,"text":"Validated brief"}\n\n'),
      }),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    const err = await caught(readSSEStream(responseWithReader(reader), {
      onComplete: () => { throw callbackError; },
    }));

    expect(err).toBe(callbackError);
    expect(err.streamLost).toBeUndefined();
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('brief completion boundary', () => {
  test('does not promote a clean EOF without explicit server completion', () => {
    expect(() => requireBriefComplete(false, 'Unvalidated streamed draft')).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/before the server confirmed completion/),
        streamLost: true,
        accumulatedText: 'Unvalidated streamed draft',
      })
    );
    expect(requireBriefComplete(true, 'Validated draft')).toBeUndefined();
  });
});
