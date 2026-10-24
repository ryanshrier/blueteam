import { Worker } from 'node:worker_threads';

export const ARTICLE_EXTRACTION_LIMITS = Object.freeze({ maxBytes: 2_000_000, maxPending: 16,
  timeoutMs: 2_000, maxOldGenerationSizeMb: 96, maxOutputCharacters: 4_000 });
const failure = message => Object.assign(new Error(message), { code: 'E_ARTICLE_EXTRACTION' });

// A single active worker bounds aggregate heap use. Admission deadlines cover
// queueing and execution, and the caller's fetch deadline can cancel either.
export function createArticleExtractor({ timeoutMs = ARTICLE_EXTRACTION_LIMITS.timeoutMs,
  maxPending = ARTICLE_EXTRACTION_LIMITS.maxPending } = {}) {
  const queue = [], idleWaiters = new Set();
  let active = null, closed = false;
  const idle = () => {
    if (active || queue.length) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  function finish(job, error, body) {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);
    error ? job.reject(error) : job.resolve(body);
  }
  function cancel(job, message) {
    if (job.finished) return;
    if (active === job) {
      job.error ||= failure(message);
      void job.worker.terminate().catch(() => {});
    } else {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      finish(job, failure(message));
      idle();
    }
  }
  function pump() {
    if (active || closed || !queue.length) { idle(); return; }
    const job = queue.shift();
    active = job;
    try {
      job.worker = new Worker(new URL('./article-extraction-worker.js', import.meta.url), {
        workerData: { html: job.html, context: job.context }, env: {}, execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: ARTICLE_EXTRACTION_LIMITS.maxOldGenerationSizeMb,
          maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      job.worker.once('message', reply => { job.reply = reply; });
      job.worker.once('error', () => { job.error ||= failure('Article extraction worker failed'); });
      job.worker.once('exit', code => {
        const reply = job.reply;
        const error = job.error || (code !== 0 || reply?.ok !== true || typeof reply.body !== 'string'
          || reply.body.length > ARTICLE_EXTRACTION_LIMITS.maxOutputCharacters
          ? failure('Article HTML is invalid or exceeds extraction limits') : null);
        // Wait for exit before starting another worker, including termination.
        active = null;
        finish(job, error, reply?.body);
        pump();
      });
    } catch {
      active = null;
      finish(job, failure('Article extraction worker could not start'));
      pump();
    }
  }
  return {
    extract(html, context = {}, { signal } = {}) {
      if (closed) return Promise.reject(failure('Article extractor is closed'));
      if (signal?.aborted) return Promise.reject(failure('Article extraction was aborted'));
      if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > ARTICLE_EXTRACTION_LIMITS.maxBytes) {
        return Promise.reject(failure('Article HTML exceeds its size limit'));
      }
      if (queue.length + Number(Boolean(active)) >= maxPending) return Promise.reject(failure('Article extraction queue is full'));
      return new Promise((resolve, reject) => {
        const job = { html, context: { title: String(context.title || '').slice(0, 4096),
          url: String(context.url || '').slice(0, 4096) }, signal, resolve, reject };
        job.onAbort = () => cancel(job, 'Article extraction was aborted');
        signal?.addEventListener('abort', job.onAbort, { once: true });
        job.timer = setTimeout(() => cancel(job, 'Article extraction timed out'), timeoutMs);
        queue.push(job);
        pump();
      });
    },
    close() {
      closed = true;
      for (const job of [...queue]) cancel(job, 'Article extractor is closed');
      if (active) cancel(active, 'Article extractor is closed');
      if (!active && !queue.length) return Promise.resolve();
      return new Promise(resolve => idleWaiters.add(resolve));
    },
  };
}

const extractor = createArticleExtractor();
export const extractArticleInWorker = (html, context, options) => extractor.extract(html, context, options);
export const closeArticleExtractor = () => extractor.close();
