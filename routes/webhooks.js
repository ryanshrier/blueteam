import { Router } from 'express';
import { reviewWebhookDeliveries, reconcileWebhookDelivery } from '../lib/alerts.js';

export function createWebhookRouter({ getConfig, loopback = false }) {
  const router = Router();
  router.use('/webhook-deliveries', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!loopback && res.locals.authenticated !== true) return res.status(403).json({ code: 'E_EXPOSED', error: 'Delivery review requires a local or authenticated connection.' });
    next();
  });
  const failure = (res, error) => res.status(error.status || 503).json({
    code: error.status ? error.code : 'E_OUTBOX_STORAGE',
    error: error.status ? error.message : 'Delivery storage is unavailable. Queued work has been preserved.',
  });
  router.get('/webhook-deliveries', async (_req, res) => {
    try { res.json({ items: await reviewWebhookDeliveries(getConfig()) }); }
    catch (error) { failure(res, error); }
  });
  router.post('/webhook-deliveries/:id/resolve', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['action', 'acknowledgeDuplicateRisk'].includes(key))) {
      return res.status(400).json({ code: 'E_OUTBOX_REQUEST', error: 'Choose a delivery resolution.' });
    }
    try { res.json(await reconcileWebhookDelivery(req.params.id, body, getConfig())); }
    catch (error) { failure(res, error); }
  });
  return router;
}
