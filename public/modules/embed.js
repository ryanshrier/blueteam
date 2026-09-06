// Keep embedded reading stable. Polling offers a new snapshot; only the reader
// applies it. No navigation, focus, or document refresh is triggered by a timer.
(() => {
  const list = document.getElementById('embedSignals');
  const snapshot = document.getElementById('embedSnapshot');
  const button = document.getElementById('embedRefresh');
  const watch = document.getElementById('embedWatch');
  const status = document.getElementById('embedStatus');
  if (!list || !snapshot || !button || !watch || !status) return;
  let pending = null;
  let loading = false;
  let disposed = false;
  async function check(apply = false) {
    if (loading || disposed) return;
    loading = true; button.disabled = true;
    try {
      if (!pending || !apply) {
        const response = await fetch(location.href, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error('unavailable');
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const incoming = doc.getElementById('embedSignals');
        const incomingSnapshot = doc.getElementById('embedSnapshot');
        if (!incoming || !incomingSnapshot) throw new Error('unavailable');
        pending = incoming.innerHTML !== list.innerHTML || incomingSnapshot.textContent !== snapshot.textContent
          ? { list: incoming, snapshot: incomingSnapshot } : null;
      }
      if (disposed) return;
      if (apply && pending) {
        const anchor = [...list.children].find(row => row.getBoundingClientRect().bottom > 0);
        const key = anchor?.dataset.signalKey;
        const top = anchor?.getBoundingClientRect().top;
        const y = window.scrollY;
        // Nodes come from this same-origin server-rendered, escaped embed route.
        list.replaceChildren(...pending.list.childNodes);
        snapshot.replaceChildren(...pending.snapshot.childNodes);
        const restored = [...list.children].find(row => row.dataset.signalKey === key);
        window.scrollTo(0, restored && Number.isFinite(top) ? y + restored.getBoundingClientRect().top - top : y);
        pending = null;
        status.textContent = 'Snapshot updated.';
      } else status.textContent = pending ? 'A new snapshot is available.' : 'No new snapshot.';
      button.textContent = pending ? 'Apply update' : 'Refresh signals';
    } catch { if (!disposed) status.textContent = 'Update unavailable. Current signals retained.'; }
    finally { loading = false; if (!disposed) button.disabled = false; }
  }
  button.addEventListener('click', () => { void check(true); });
  watch.addEventListener('change', () => { status.textContent = watch.checked ? 'Update checks resumed.' : 'Update checks paused.'; });
  const poll = () => { if (watch.checked && !document.hidden) void check(); };
  let timer = setInterval(poll, 60_000);
  window.addEventListener('pagehide', event => {
    clearInterval(timer); timer = null;
    if (!event.persisted) disposed = true;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && !disposed && timer === null) timer = setInterval(poll, 60_000);
  });
})();
