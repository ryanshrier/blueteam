import { expect, jest, test } from '@jest/globals';
import { captureWireFocus, restoreWireFocus } from '../public/modules/wire/wire-focus.js';

function row(key, selector = '[data-mark-read]') {
  const action = { dataset: {}, focus: jest.fn() };
  const item = { dataset: { key }, action, focus: jest.fn(),
    contains: element => element === action,
    querySelectorAll: query => query === selector ? [action] : [],
  };
  return item;
}
function list(rows) {
  return { querySelectorAll: () => rows, contains: element => rows.some(item => item === element || item.contains(element)) };
}

test('refresh preserves the same signal and action even when its rank changes', () => {
  const before = [row('a'), row('b')];
  const saved = captureWireFocus(list(before), before[1].action);
  const after = [row('b'), row('a')];
  restoreWireFocus(list(after), saved);
  expect(after[0].action.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(after[1].action.focus).not.toHaveBeenCalled();
});

test('hiding a focused signal continues at its successor and an empty list uses search', () => {
  const before = [row('a'), row('b'), row('c')];
  const saved = captureWireFocus(list(before), before[1].action);
  const after = [row('a'), row('c')];
  restoreWireFocus(list(after), saved);
  expect(after[1].focus).toHaveBeenCalledWith({ preventScroll: true });
  const search = { focus: jest.fn() };
  restoreWireFocus(list([]), saved, search);
  expect(search.focus).toHaveBeenCalledWith({ preventScroll: true });
});

test('a refresh does not steal focus from the evidence dialog or filters', () => {
  const rows = [row('a')];
  const saved = captureWireFocus(list(rows), { focus: jest.fn() });
  expect(saved).toBeNull();
  restoreWireFocus(list(rows), saved);
  expect(rows[0].focus).not.toHaveBeenCalled();
});

test('a removed/disabled action falls back to its still-present row', () => {
  const before = row('a');
  const saved = captureWireFocus(list([before]), before.action);
  const after = row('a');
  after.action.disabled = true;
  restoreWireFocus(list([after]), saved);
  expect(after.focus).toHaveBeenCalledWith({ preventScroll: true });
});
