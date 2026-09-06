import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { showToast } from '../public/modules/core/toast.js';

class Node {
  constructor() { this.children = []; this.events = {}; this.attrs = {}; this.isConnected = true; this.engaged = false; }
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); }
  addEventListener(k, v) { this.events[k] = v; }
  matches() { return this.engaged; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  remove() { this.isConnected = false; }
}
const previousDocument = globalThis.document;
let container;
beforeEach(() => {
  jest.useFakeTimers();
  container = new Node();
  globalThis.document = { getElementById: () => container, createElement: () => new Node() };
});
afterEach(() => { jest.useRealTimers(); globalThis.document = previousDocument; });

test('errors remain readable longer and can be dismissed immediately', () => {
  showToast('Request failed', 'error');
  const toast = container.children[0];
  expect(toast.attrs.role).toBe('alert');
  jest.advanceTimersByTime(4000);
  expect(toast.isConnected).toBe(true);
  toast.children[2].events.click();
  expect(toast.isConnected).toBe(false);
});

test('reading pauses expiry and resumes only the remaining display time', () => {
  showToast('Copied');
  const toast = container.children[0];
  jest.advanceTimersByTime(1000);
  toast.engaged = true;
  toast.events.mouseenter();
  jest.advanceTimersByTime(10000);
  expect(toast.isConnected).toBe(true);
  toast.engaged = false;
  toast.events.mouseleave();
  jest.advanceTimersByTime(2999);
  expect(toast.isConnected).toBe(true);
  jest.advanceTimersByTime(1);
  expect(toast.isConnected).toBe(false);
});

test('notification text is assigned as text and persistent notices need dismissal', () => {
  showToast('<img src=x onerror=alert(1)>', 'info', 0);
  const toast = container.children[0];
  expect(toast.children[1].textContent).toBe('<img src=x onerror=alert(1)>');
  expect(toast.children[1].innerHTML).toBeUndefined();
  jest.advanceTimersByTime(60000);
  expect(toast.isConnected).toBe(true);
});

test('explicit keyboard dismissal returns focus to the prior control', () => {
  const origin = new Node();
  origin.focus = jest.fn();
  showToast('Request failed', 'error');
  const toast = container.children[0];
  document.activeElement = toast.children[2];
  toast.engaged = true;
  toast.events.focusin({ relatedTarget: origin });
  toast.children[2].events.click();
  expect(origin.focus).toHaveBeenCalledWith({ preventScroll: true });
});
