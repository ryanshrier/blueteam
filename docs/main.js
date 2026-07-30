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
