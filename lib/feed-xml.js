import { Worker } from 'node:worker_threads';

export const FEED_XML_LIMITS = Object.freeze({
  maxBytes: 16_000_000,
  maxPending: 16,
  timeoutMs: 5_000,
  maxOldGenerationSizeMb: 128,
});

// One short-lived worker at a time avoids multiplying heap limits by feed
// concurrency. The bounded queue covers the eight collection workers plus
// discovery. No idle worker, application credentials, or persistent pool.
export function createFeedXmlParser({ timeoutMs = FEED_XML_LIMITS.timeoutMs, maxPending = FEED_XML_LIMITS.maxPending } = {}) {
  let tail = Promise.resolve();
  let pending = 0;
  const shutdown = new AbortController();

  function parseInWorker(xml) {
    if (shutdown.signal.aborted) throw new Error('Feed XML parser is closed');
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./feed-xml-worker.js', import.meta.url), {
        workerData: xml,
        env: {},
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: FEED_XML_LIMITS.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      let reply;
      let failure;
      const stop = message => {
        failure = new Error(message);
        void worker.terminate().catch(() => {});
      };
      const onAbort = () => stop('Feed XML parser is closed');
      shutdown.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop('Feed XML parsing timed out'), timeoutMs);
      worker.once('message', value => { reply = value; });
      worker.once('error', () => { failure ||= new Error('Feed XML parser failed'); });
      // Settle only after exit: the next queued parse must not overlap a worker
      // still terminating or serializing its result.
      worker.once('exit', code => {
        clearTimeout(timer);
        shutdown.signal.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else if (code !== 0 || reply?.ok !== true) reject(new Error('Feed XML is invalid or exceeds parser limits'));
        else resolve(reply.parsed);
      });
    });
  }

  return {
    parse(xml) {
      if (shutdown.signal.aborted) return Promise.reject(new Error('Feed XML parser is closed'));
      if (typeof xml !== 'string' || Buffer.byteLength(xml, 'utf8') > FEED_XML_LIMITS.maxBytes) {
        return Promise.reject(new Error('Feed XML exceeds its size limit'));
      }
      if (pending >= maxPending) return Promise.reject(new Error('Feed XML parser queue is full'));
      pending++;
      const result = tail.then(() => parseInWorker(xml)).finally(() => { pending--; });
      tail = result.catch(() => {});
      return result;
    },
    close() {
      shutdown.abort();
      return tail;
    },
  };
}

const parser = createFeedXmlParser();
export const parseFeedXml = xml => parser.parse(xml);
export const closeFeedXmlParser = () => parser.close();
