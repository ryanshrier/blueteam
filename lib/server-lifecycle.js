// Drain accepted application work before destroying its network/storage resources.
// A deadline forces process termination; it never makes a still-running task safe
// to resume against a closed database in the same process.
export function createShutdownCoordinator({
  stopWork = [],
  requestDrains = [],
  backgroundDrains = [],
  closeOutbound,
  closeStorage,
  onError = () => {},
  onTimeout,
}) {
  let completion = null;

  return function drainAndClose(guardMs) {
    if (completion) return completion;
    let expired = false;
    let guard;
    const deadline = new Promise(resolve => {
      guard = setTimeout(() => {
        expired = true;
        resolve({ forced: true });
        onTimeout(guardMs);
      }, guardMs);
      guard.unref?.();
    });
    const settleAll = async tasks => {
      // One rejected task must not short-circuit another task's DB writes.
      const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
      for (const result of results) if (result.status === 'rejected') onError(result.reason);
    };
    const cleanup = async () => {
      for (const stop of stopWork) stop();
      await settleAll(requestDrains);
      if (expired) return { forced: true };
      // An already accepted request can start a refresh while HTTP is draining.
      // Inspect background work only after those requests have finished.
      await settleAll(backgroundDrains);
      if (expired) return { forced: true };
      await settleAll([closeOutbound]);
      if (expired) return { forced: true };
      closeStorage();
      return { forced: false };
    };
    completion = Promise.race([cleanup(), deadline]).finally(() => clearTimeout(guard));
    return completion;
  };
}
