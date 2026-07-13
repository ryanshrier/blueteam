// blueteam.news — copy buttons + live star count. No analytics, no trackers.
// The only outbound call is to the GitHub API for the star count; on any
// failure it degrades silently to a count-less button.

// ── Copy-to-clipboard for code blocks ──
document.querySelectorAll('.code').forEach((block) => {
  const btn = block.querySelector('.copy');
  const pre = block.querySelector('pre');
  const status = block.querySelector('.copy-status');
  if (!btn || !pre) return;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.innerText.trim());
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      if (status) status.textContent = 'Install command copied to clipboard.';
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
        if (status) status.textContent = '';
      }, 1600);
    } catch {
      btn.textContent = 'Copy failed';
      if (status) status.textContent = 'Copy failed. Select and copy the command manually.';
      setTimeout(() => {
        btn.textContent = 'Copy';
        if (status) status.textContent = '';
      }, 1600);
    }
  });
});

// ── Live GitHub star count ──
const REPO = 'ryanshrier/blueteam';
(async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!r.ok) return;
    const data = await r.json();
    const n = data.stargazers_count;
    if (typeof n !== 'number') return;
    const label = n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
    document.querySelectorAll('#starCount, [data-star]').forEach((el) => {
      el.textContent = label;
      el.hidden = false;
    });
  } catch {
    /* offline, rate-limited, or repo not public yet — leave the count hidden */
  } finally {
    clearTimeout(timeout);
  }
})();
