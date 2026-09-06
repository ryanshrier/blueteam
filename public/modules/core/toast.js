// BlueTeam.News — toast notifications.

export function showToast(message, type = 'info', duration = type === 'error' ? 8000 : 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  // Errors interrupt assertively; the polite container handles the rest.
  if (type === 'error') toast.setAttribute('role', 'alert');
  const symbol = document.createElement('span');
  symbol.className = 'toast-symbol';
  symbol.setAttribute('aria-hidden', 'true');
  symbol.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="${type === 'error' ? 'M12 7v6m0 4h.01' : type === 'success' ? 'm8 12 3 3 5-6' : 'M12 11v6m0-10h.01'}"/></svg>`;
  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  toast.append(symbol, text, close);
  container.appendChild(toast);
  let timer = null;
  let remaining = duration;
  let started = 0;
  let focusOrigin = null;
  const dismiss = () => {
    clearTimeout(timer);
    const hadFocus = toast.contains(document.activeElement);
    toast.remove();
    if (hadFocus) {
      const target = focusOrigin?.isConnected ? focusOrigin : document.getElementById('main');
      target?.focus?.({ preventScroll: true });
    }
  };
  const pause = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; remaining = Math.max(0, remaining - (Date.now() - started)); }
  };
  const resume = () => {
    if (duration <= 0 || !toast.isConnected || toast.matches(':hover, :focus-within')) return;
    clearTimeout(timer);
    started = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  close.addEventListener('click', dismiss);
  toast.addEventListener('mouseenter', pause);
  toast.addEventListener('mouseleave', resume);
  toast.addEventListener('focusin', e => {
    if (e.relatedTarget && !toast.contains(e.relatedTarget)) focusOrigin = e.relatedTarget;
    pause();
  });
  toast.addEventListener('focusout', () => setTimeout(resume, 0));
  resume();
}
