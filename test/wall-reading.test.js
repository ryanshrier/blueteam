import { describe, expect, test } from '@jest/globals';
import { readingStops } from '../public/modules/wall/wall-reading.js';

describe('Wall continuations', () => {
  test('keeps short and unmeasured content on one screen', () => {
    expect(readingStops({ clientHeight: 600, scrollHeight: 600 })).toEqual([0]);
    expect(readingStops({ clientHeight: 0, scrollHeight: 900 })).toEqual([0]);
  });
  test('covers the entire document with overlapping screens including a short final part', () => {
    const height = 430;
    const total = 2413;
    const stops = readingStops({ clientHeight: height, scrollHeight: total });
    expect(stops[0]).toBe(0);
    expect(stops.at(-1) + height).toBe(total);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]).toBeGreaterThan(stops[i - 1]);
      expect(stops[i] - stops[i - 1]).toBeLessThanOrEqual(height - 64);
    }
  });
  test('lets a large headline line crossing a screen edge read intact on the adjacent screen', () => {
    const body = { clientHeight: 500, scrollHeight: 1250,
      ownerDocument: { defaultView: { getComputedStyle: () => ({ lineHeight: '120px', fontSize: '100px' }) } },
      querySelectorAll: () => [{}] };
    const stops = readingStops(body);
    // Every possible line position fits completely within at least one screen.
    for (let top = 0; top <= 1130; top++) {
      expect(stops.some(stop => top >= stop && top + 120 <= stop + 500)).toBe(true);
    }
  });
  test('shows fitting decisions intact and preserves coverage while already scrolled', () => {
    const height = 500;
    const blocks = [{ top: 300, bottom: 750 }, { top: 760, bottom: 1160 }];
    const scrollTop = 250;
    const body = { clientHeight: height, scrollHeight: 1600, scrollTop,
      getBoundingClientRect: () => ({ top: 120 }),
      querySelectorAll: () => blocks.map(block => ({ getBoundingClientRect: () => ({
        top: block.top + 120 - scrollTop, bottom: block.bottom + 120 - scrollTop,
      }) })) };
    const stops = readingStops(body);
    for (const block of blocks) {
      expect(stops.some(stop => block.top >= stop && block.bottom <= stop + height)).toBe(true);
    }
    expect(stops.at(-1)).toBe(1100);
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]).toBeGreaterThan(stops[i - 1]);
      expect(stops[i] - stops[i - 1]).toBeLessThanOrEqual(height - 64);
    }
  });
  test('retains overlapping continuations for blocks taller than a viewport', () => {
    const body = { clientHeight: 500, scrollHeight: 1700, scrollTop: 0,
      getBoundingClientRect: () => ({ top: 0 }),
      querySelectorAll: () => [{ getBoundingClientRect: () => ({ top: 100, bottom: 1400 }) }] };
    expect(readingStops(body)).toEqual([0, 436, 872, 1200]);
  });
  test('keeps semantic continuation positions unchanged under native 4K CSS zoom', () => {
    const measured = scale => ({ clientHeight: 500, scrollHeight: 1600, scrollTop: 250,
      getBoundingClientRect: () => ({ top: 100, height: 500 * scale }),
      querySelectorAll: () => [{ getBoundingClientRect: () => ({ top: 100 + (300 - 250) * scale, bottom: 100 + (750 - 250) * scale }) }] });
    expect(readingStops(measured(2))).toEqual(readingStops(measured(1)));
  });
});
