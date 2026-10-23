// Permit fixture assets while rejecting real APIs and external traffic. A print
// iframe can disappear between requestPaused and continueRequest; require the
// matching Network event before treating that specific CDP error as cancellation.
export function createFixtureRequestGuard(connection, { origin, errors, cancellationTimeoutMs = 500 }) {
  const canceled = new Set();
  const cancellationWaiters = new Map();
  const pending = new Set();
  const unsubscribe = [];

  const waitForCancellation = networkId => {
    if (!networkId) return Promise.resolve(false);
    if (canceled.has(networkId)) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = confirmed => {
        clearTimeout(timer);
        const waiters = cancellationWaiters.get(networkId);
        waiters?.delete(finish);
        if (!waiters?.size) cancellationWaiters.delete(networkId);
        resolve(confirmed);
      };
      const timer = setTimeout(() => finish(false), cancellationTimeoutMs);
      const waiters = cancellationWaiters.get(networkId) ?? new Set();
      waiters.add(finish);
      cancellationWaiters.set(networkId, waiters);
    });
  };

  unsubscribe.push(connection.on('Network.loadingFailed', event => {
    if (event.canceled !== true) return;
    canceled.add(event.requestId);
    // These are short-lived synthetic pages; bound diagnostic bookkeeping too.
    if (canceled.size > 2_048) canceled.delete(canceled.values().next().value);
    for (const finish of cancellationWaiters.get(event.requestId) ?? []) finish(true);
  }));

  unsubscribe.push(connection.on('Fetch.requestPaused', event => {
    let local = false;
    try {
      const url = new URL(event.request.url);
      local = url.origin === origin && !url.username && !url.password
        && !/^\/api(?:\/|$)/.test(decodeURIComponent(url.pathname));
    } catch { /* Malformed destinations fail closed. */ }
    if (!local) errors.push(`Unexpected request: ${event.request.url}`);
    const method = local ? 'Fetch.continueRequest' : 'Fetch.failRequest';
    const request = connection.call(method, {
      requestId: event.requestId,
      ...(!local ? { errorReason: 'BlockedByClient' } : {}),
    }).catch(async error => {
      if (local && error.message === 'Fetch.continueRequest: Invalid InterceptionId.'
        && await waitForCancellation(event.networkId)) return;
      errors.push(`${error.message} [${event.request.url}; networkId=${event.networkId ?? 'none'}]`);
    });
    pending.add(request);
    void request.finally(() => pending.delete(request));
  }));

  return {
    async enable() {
      await connection.call('Network.enable');
      await connection.call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    },
    async settle() {
      while (pending.size) await Promise.all([...pending]);
    },
    dispose() {
      for (const remove of unsubscribe) remove();
      for (const waiters of cancellationWaiters.values()) {
        for (const finish of waiters) finish(false);
      }
      canceled.clear();
    },
  };
}
