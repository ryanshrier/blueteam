// BlueTeam.News — toast notifications.

export function showToast(message, type = 'info', duration = 3200) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  // Errors interrupt assertively; the polite container handles the rest.
  if (type === 'error') toast.setAttribute('role', 'alert');
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 320);
  }, duration);
}
