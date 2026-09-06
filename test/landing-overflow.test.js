import { describe, expect, test } from '@jest/globals';
import { visibleHorizontalBounds } from '../scripts/check-landing-render.mjs';

const element = (left, right, overflowX = 'visible', parentElement = null) => ({
  parentElement, overflowX, getBoundingClientRect: () => ({ left, right }),
});
const style = node => ({ overflowX: node.overflowX });
const overflows = bounds => Boolean(bounds && (bounds.left < -1 || bounds.right > 391));

describe('landing painted horizontal bounds', () => {
  test.each(['auto', 'scroll', 'hidden', 'clip'])('clips a long command inside an overflow-x:%s ancestor', overflowX => {
    const pre = element(16, 374, overflowX);
    const command = element(34, 528, 'visible', pre);
    expect(visibleHorizontalBounds(command, style)).toEqual({ left: 34, right: 374 });
    expect(overflows(visibleHorizontalBounds(command, style))).toBe(false);
  });

  test('still flags the same long command when its ancestor does not clip', () => {
    const command = element(34, 528, 'visible', element(16, 374));
    expect(overflows(visibleHorizontalBounds(command, style))).toBe(true);
  });

  test('still flags an overflowing scroller and content visibly extending inside it', () => {
    const pre = element(16, 500, 'auto');
    expect(overflows(visibleHorizontalBounds(pre, style))).toBe(true);
    expect(overflows(visibleHorizontalBounds(element(34, 528, 'visible', pre), style))).toBe(true);
  });

  test('intersects every clipping ancestor on both sides and excludes fully clipped descendants', () => {
    const outer = element(16, 374, 'hidden');
    const inner = element(-80, 300, 'auto', outer);
    expect(visibleHorizontalBounds(element(-100, 528, 'visible', inner), style)).toEqual({ left: 16, right: 300 });
    expect(visibleHorizontalBounds(element(534, 700, 'visible', outer), style)).toBeNull();
  });
});
