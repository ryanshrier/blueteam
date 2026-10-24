import { expect, jest, test } from '@jest/globals';
import { createWebhookReviewController, safeDeliveryList } from '../public/modules/settings/webhook-deliveries.js';
const item = () => ({ id: 'a'.repeat(64), kind: 'alerts', state: 'ambiguous', attempts: 1, createdAt: '2026-10-24T00:00:00Z', canRetry: true });

test('delivery review projects only bounded, safe metadata', () => {
  expect(safeDeliveryList({ items: [{ ...item(), body: 'PRIVATE', destination: 'https://PRIVATE', errorCode: 'PRIVATE URL' }] }))
    .toEqual([{ ...item(), createdAt: '2026-10-24T00:00:00.000Z', errorCode: null }]);
  expect(() => safeDeliveryList({ items: Array.from({ length: 101 }, item) })).toThrow();
  expect(() => safeDeliveryList({ items: [{ ...item(), id: '<img>' }] })).toThrow();
});

test('retry requires explicit acknowledgement, refreshes after resolution, and reports duplicate risk', async () => {
  const load = jest.fn().mockResolvedValueOnce({ items: [item()] }).mockResolvedValueOnce({ items: [{ ...item(), state: 'pending' }] });
  const resolve = jest.fn().mockResolvedValue({ resolved: true });
  const controller = createWebhookReviewController({ load, resolve });
  await controller.refresh();
  await controller.reconcile(item().id, 'retry', false);
  expect(resolve).not.toHaveBeenCalled();
  expect(controller.getState().feedback).toMatch(/acknowledge duplicate risk/);
  await controller.reconcile(item().id, 'retry', true);
  expect(resolve).toHaveBeenCalledWith(item().id, 'retry', true);
  expect(controller.getState()).toMatchObject({ busy: false, items: [{ state: 'pending' }] });
  expect(controller.getState().feedback).toMatch(/may receive a duplicate/);
});

test.each(['delivered', 'abandon'])('operator can %s old deliveries to restore capacity', async action => {
  const load = jest.fn().mockResolvedValueOnce({ items: [item()] }).mockResolvedValueOnce({ items: [] });
  const resolve = jest.fn().mockResolvedValue({ resolved: true });
  const controller = createWebhookReviewController({ load, resolve });
  await controller.refresh(); await controller.reconcile(item().id, action);
  expect(resolve).toHaveBeenCalledWith(item().id, action, false);
  expect(controller.getState()).toMatchObject({ busy: false, items: [] });
  expect(controller.getState().feedback).toMatch(/capacity restored/);
});

test('uncertain mutation response asks for refresh rather than automatically repeating it', async () => {
  const resolve = jest.fn().mockRejectedValue(new Error('PRIVATE TRANSPORT ERROR'));
  const controller = createWebhookReviewController({ load: async () => ({ items: [item()] }), resolve });
  await controller.refresh(); await controller.reconcile(item().id, 'abandon');
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(controller.getState().feedback).toMatch(/Refresh the list/);
  expect(controller.getState().feedback).not.toContain('PRIVATE');
});

test('disposing ignores late delivery review responses', async () => {
  let finish;
  const onChange = jest.fn();
  const controller = createWebhookReviewController({ load: () => new Promise(resolve => { finish = resolve; }), onChange });
  const request = controller.refresh(); controller.dispose(); finish({ items: [item()] }); await request;
  expect(onChange).toHaveBeenCalledTimes(1);
});
