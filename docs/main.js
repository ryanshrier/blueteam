// blueteam.news — progressive enhancement for copy buttons.
// The public landing page makes no third-party requests.

document.documentElement.classList.add('js');

const mobileNavigation = document.querySelector('.mobile-nav');
if (mobileNavigation) {
  mobileNavigation.addEventListener('click', (event) => {
    if (event.target.closest('a')) mobileNavigation.removeAttribute('open');
  });
  mobileNavigation.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    mobileNavigation.removeAttribute('open');
    mobileNavigation.querySelector('summary')?.focus();
  });
}

document.querySelectorAll('.code').forEach((block) => {
  const button = block.querySelector('.copy');
  const code = block.querySelector('pre');
  const status = block.querySelector('.copy-status');
  if (!button || !code) return;

  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.innerText.trim());
      button.textContent = 'Copied';
      button.classList.add('copied');
      if (status) status.textContent = 'Quick-start commands copied to clipboard.';
    } catch {
      button.textContent = 'Copy failed';
      if (status) status.textContent = 'Copy failed. Select and copy the command manually.';
    }

    window.setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('copied');
      if (status) status.textContent = '';
    }, 1600);
  });
});

// Native dialogs keep the product tour, Escape and focus return in one place.
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="assets/screenshot-"]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const dialog = document.createElement('dialog');
  if (typeof dialog.showModal !== 'function') return;
  event.preventDefault();
  const caption = (link.querySelector('img') || link.closest('figure')?.querySelector('img'))?.alt || 'BlueTeam.News product preview';
  const title = link.dataset.viewerTitle || link.closest('figure')?.querySelector('figcaption strong, figcaption h3, figcaption h4')?.textContent || 'Product preview';
  dialog.className = 'product-viewer';
  dialog.setAttribute('aria-labelledby', 'productViewerTitle');
  dialog.innerHTML = `<header class="product-viewer-toolbar"><h2 id="productViewerTitle"></h2><button type="button" class="viewer-zoom" aria-pressed="false">Zoom in</button><button type="button" class="viewer-close" autofocus>Close</button></header><div class="product-viewer-viewport" tabindex="0" aria-label="Product screenshot, fitted to window"><img></div><p class="product-viewer-hint" role="status">Fit to window · Zoom in to inspect details.</p>`;
  const picture = dialog.querySelector('img');
  picture.addEventListener('load', () => dialog.style.setProperty('--viewer-image-width', `${picture.naturalWidth}px`));
  picture.src = innerWidth <= 600 && link.dataset.mobileSrc ? new URL(link.dataset.mobileSrc, location.href).href : link.href;
  picture.alt = caption;
  dialog.querySelector('h2').textContent = title;
  const zoom = dialog.querySelector('.viewer-zoom');
  const viewport = dialog.querySelector('.product-viewer-viewport');
  const hint = dialog.querySelector('.product-viewer-hint');
  picture.addEventListener('error', () => { hint.textContent = 'This image could not load. Close this view and retry.'; zoom.disabled = true; });
  zoom.addEventListener('click', () => {
    const enlarged = dialog.classList.toggle('is-zoomed');
    zoom.setAttribute('aria-pressed', String(enlarged));
    zoom.textContent = enlarged ? 'Fit image' : 'Zoom in';
    viewport.scrollTop = viewport.scrollLeft = 0;
    viewport.setAttribute('aria-label', enlarged ? 'Zoomed product screenshot. Scroll or use arrow keys to pan.' : 'Product screenshot, fitted to window');
    hint.textContent = enlarged ? 'Zoomed · Scroll to pan. Focus the image area to use arrow keys.' : 'Fit to window · Zoom in to inspect details.';
  });
  dialog.querySelector('.viewer-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (click) => { if (click.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { dialog.remove(); link.focus({ preventScroll: true }); }, { once: true });
  document.body.appendChild(dialog);
  dialog.showModal();
});
