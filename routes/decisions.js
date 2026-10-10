import { Router } from 'express';
import { listDecisions, lookupDecisions, getDecision, decisionHistory, saveDecision, importDecisions, exportDecisions } from '../lib/decisions.js';

export function createDecisionRouter() {
  const router = Router();
  router.use('/decisions', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const route = work => (req, res) => {
    try { res.json(work(req)); }
    catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Decision storage is unavailable. Your draft has not been discarded.',
      code: error.code?.startsWith('E_DECISION_') ? error.code : 'E_DECISION_STORAGE', ...(error.current ? { current: error.current } : {}) }); }
  };
  router.get('/decisions', route(req => listDecisions({ after: req.query.after || '', limit: req.query.limit === undefined ? 100 : Number(req.query.limit) })));
  router.post('/decisions/lookup', route(req => lookupDecisions(req.body?.signals)));
  router.post('/decisions/import', route(req => importDecisions(req.body?.records)));
  router.put('/decisions', route(req => saveDecision(req.body)));
  router.get('/decisions/export', async (req, res) => {
    res.type('json').attachment('wire-server-decisions.json');
    try {
      res.write('[');
      let index = 0;
      for (const record of exportDecisions()) {
        if (res.destroyed) return;
        if (!res.write(`${index++ ? ',' : ''}${JSON.stringify(record)}`)) {
          await new Promise(done => { const finish = () => { res.off('drain', finish); res.off('close', finish); done(); }; res.once('drain', finish); res.once('close', finish); });
        }
        if (index % 100 === 0) await new Promise(done => setImmediate(done));
      }
      res.end(']');
    } catch { res.destroy(); }
  });
  router.get('/decisions/:id/history', route(req => decisionHistory(req.params.id, { before: Number(req.query.before || 0), limit: req.query.limit === undefined ? 10 : Number(req.query.limit) })));
  router.get('/decisions/:id', route(req => {
    const record = getDecision(req.params.id);
    if (!record) throw Object.assign(new Error('Decision not found.'), { status: 404, code: 'E_DECISION_NOT_FOUND' });
    return record;
  }));
  return router;
}
