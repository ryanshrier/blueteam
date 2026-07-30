/**
 * Real-browser smoke test for the GitHub Pages landing page.
 *
 * No browser automation package is added to the dependency graph. GitHub's
 * Ubuntu runner already includes Chrome; locally this also discovers Chrome or
 * Edge. The script speaks the Chrome DevTools Protocol over Node's built-in
 * WebSocket implementation (available in every supported Node release).
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const DOCS = join(ROOT, 'docs');
const TIMEOUT_MS = 15_000;
const errors = [];

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function fail(viewport, message) {
  errors.push(`${viewport}: ${message}`);
}

function findOnPath(command) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(finder, [command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean) ?? null;
}

function findBrowser() {
  const configured = process.env.CHROME_PATH ?? process.env.BROWSER_PATH;
  if (configured) {
    if (!existsSync(configured)) throw new Error(`Configured browser does not exist: ${configured}`);
    return configured;
  }

  const commands =
    process.platform === 'win32'
      ? ['chrome.exe', 'msedge.exe']
      : process.platform === 'darwin'
        ? ['google-chrome', 'chromium', 'microsoft-edge']
        : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const command of commands) {
    const candidate = findOnPath(command);
    if (candidate) return candidate;
  }

  const fixedCandidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [];
  return fixedCandidates.find(existsSync) ?? null;
}

function contentType(pathname) {
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.woff2': 'font/woff2',
      '.xml': 'application/xml; charset=utf-8',
    }[extname(pathname).toLowerCase()] ?? 'application/octet-stream'
  );
}

function safeDocsPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const pathname = decoded === '/' ? '/index.html' : decoded;
  const absolute = resolve(DOCS, `.${normalize(pathname)}`);
  const relativePath = relative(DOCS, absolute);
  if (!relativePath || relativePath.split(sep).includes('..')) return null;
  return absolute;
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const requested = safeDocsPath(url.pathname);
    try {
      if (!requested || !(await stat(requested)).isFile()) throw new Error('not found');
      const body = await readFile(requested);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
        'Content-Type': contentType(requested),
      });
      if (request.method === 'HEAD') response.end();
      else response.end(body);
    } catch {
      const fallback = join(DOCS, '404.html');
      const body = existsSync(fallback) ? await readFile(fallback) : Buffer.from('Not found');
      response.writeHead(404, {
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
        'Content-Type': 'text/html; charset=utf-8',
      });
      if (request.method === 'HEAD') response.end();
      else response.end(body);
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => server.close(error => (error ? rejectClose(error) : resolveClose()))),
  };
}

class CdpConnection {
  constructor(webSocketUrl) {
    this.sequence = 0;
    this.pending = new Map();
    this.eventListeners = new Map();
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('Timed out connecting to browser')), TIMEOUT_MS);
      this.socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolveReady();
        },
        { once: true },
      );
      this.socket.addEventListener(
        'error',
        event => {
          clearTimeout(timer);
          rejectReady(new Error(`Browser WebSocket failed: ${event.message ?? 'unknown error'}`));
        },
        { once: true },
      );
    });
    this.socket.addEventListener('message', event => this.#handleMessage(event.data));
    this.socket.addEventListener('close', event => {
      const closeDetail =
        process.env.LANDING_RENDER_DEBUG === '1'
          ? ` (code ${event.code}, reason "${event.reason || 'none'}")`
          : '';
      for (const { method, reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${method}: browser connection closed${closeDetail}`));
      }
      this.pending.clear();
    });
  }

  #handleMessage(data) {
    const message = JSON.parse(data);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }

    if (message.method) {
      for (const listener of this.eventListeners.get(message.method) ?? []) {
        listener(message.params ?? {}, message.sessionId);
      }
    }
  }

  async call(method, params = {}, sessionId, timeoutMs = TIMEOUT_MS) {
    await this.ready;
    const id = ++this.sequence;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    const result = new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { method, reject: rejectCall, resolve: resolveCall, timer });
    });
    this.socket.send(JSON.stringify(message));
    return result;
  }

  on(method, listener) {
    const listeners = this.eventListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  waitFor(method, sessionId, predicate = () => true) {
    return new Promise((resolveEvent, rejectEvent) => {
      const timer = setTimeout(() => {
        unsubscribe();
        rejectEvent(new Error(`${method} timed out`));
      }, TIMEOUT_MS);
      const unsubscribe = this.on(method, (params, eventSessionId) => {
        if (eventSessionId !== sessionId || !predicate(params)) return;
        clearTimeout(timer);
        unsubscribe();
        resolveEvent(params);
      });
    });
  }

  close() {
    this.socket.close();
  }
}

async function launchBrowser(browserPath) {
  const profile = await mkdtemp(join(tmpdir(), 'blueteam-landing-browser-'));
  const args = [
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-features=OptimizationHints,Translate',
    '--disable-gpu',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  const child = spawn(browserPath, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });
  if (process.env.LANDING_RENDER_DEBUG === '1') {
    child.on('exit', (code, signal) => {
      console.error(`Browser process exited: code=${code} signal=${signal}\n${stderr}`);
    });
  }

  const activePortFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + TIMEOUT_MS;
  let activePort;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Browser exited during startup (${child.exitCode}):\n${stderr}`);
    try {
      activePort = await readFile(activePortFile, 'utf8');
      if (activePort.trim()) break;
    } catch {
      // Chrome creates this file after its DevTools listener is ready.
    }
    await delay(50);
  }
  if (!activePort) {
    child.kill();
    throw new Error(`Browser did not expose DevTools in time:\n${stderr}`);
  }

  const [port] = activePort.trim().split(/\r?\n/);
  return {
    child,
    debugOrigin: `http://127.0.0.1:${port}`,
    profile,
    async close() {
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([
          new Promise(resolveExit => child.once('exit', resolveExit)),
          delay(3_000).then(() => child.kill()),
        ]);
      }
      await rm(profile, { force: true, recursive: true });
    },
  };
}

function remoteValue(result) {
  if (result.exceptionDetails) {
    const description =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      'unknown browser evaluation error';
    throw new Error(description);
  }
  return result.result?.value;
}

function pngDimensions(base64) {
  const bytes = Buffer.from(base64, 'base64');
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) throw new Error('browser screenshot is not a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const METRICS_EXPRESSION = String.raw`
(() => {
  const visible = element => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const label = element =>
    element.getAttribute('aria-label') ||
    element.textContent.replace(/\s+/g, ' ').trim() ||
    element.querySelector('img')?.alt ||
    '';
  const overflow = [...document.body.querySelectorAll('*')]
    .filter(element => {
      const rect = element.getBoundingClientRect();
      return visible(element) && (rect.left < -1 || rect.right > innerWidth + 1);
    })
    .slice(0, 8)
    .map(element => ({
      element: element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') +
        ([...element.classList].length ? '.' + [...element.classList].join('.') : ''),
      left: Math.round(element.getBoundingClientRect().left),
      right: Math.round(element.getBoundingClientRect().right),
    }));
  const productProof =
    [...document.images].find(image => /briefing|print edition/i.test(image.alt)) ||
    document.querySelector('[data-product-proof], .surface-featured img, .product-proof img');
  const headerControls = [...document.querySelectorAll('header a, header button')]
    .filter(visible)
    .map(label)
    .filter(Boolean);
  const main = document.querySelector('main');
  const skip = document.querySelector('a[href="#main"]');
  if (skip) {
    skip.focus();
    skip.click();
  }
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({
    readyState: document.readyState,
    title: document.title,
    innerWidth,
    innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    bodyHeight: Math.round(document.body.getBoundingClientRect().height),
    h1Visible: visible(document.querySelector('h1')),
    mainVisible: visible(main),
    skipTargetFocused: Boolean(main && document.activeElement === main),
    brokenImages: [...document.images]
      .filter(image => image.complete && image.naturalWidth === 0)
      .map(image => image.currentSrc || image.src),
    overflow,
    mobileBackgroundAttachment: getComputedStyle(document.body).backgroundAttachment,
    headerControls,
    productProofTop: productProof ? Math.round(productProof.getBoundingClientRect().top) : null,
    productProofVisible: visible(productProof),
  }))));
})()
`;

async function renderViewport(debugOrigin, origin, viewport) {
  const label = viewport.name;
  const targetResponse = await fetch(`${debugOrigin}/json/new?about%3Ablank`, { method: 'PUT' });
  if (!targetResponse.ok) throw new Error(`Could not create browser target: HTTP ${targetResponse.status}`);
  const target = await targetResponse.json();
  if (process.env.LANDING_RENDER_DEBUG === '1') console.log('Browser target:', target);
  const connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.ready;
  const sessionId = undefined;
  const consoleErrors = [];
  const failedRequests = [];
  const externalRequests = [];

  const unsubscribers = [
    connection.on('Runtime.exceptionThrown', (params, eventSessionId) => {
      if (eventSessionId === sessionId) {
        consoleErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'uncaught exception');
      }
    }),
    connection.on('Log.entryAdded', (params, eventSessionId) => {
      if (eventSessionId === sessionId && params.entry?.level === 'error') consoleErrors.push(params.entry.text);
    }),
    connection.on('Network.loadingFailed', (params, eventSessionId) => {
      if (eventSessionId === sessionId && !params.canceled) failedRequests.push(params.errorText);
    }),
    connection.on('Network.requestWillBeSent', (params, eventSessionId) => {
      if (eventSessionId !== sessionId) return;
      const url = params.request?.url;
      if (!url || url.startsWith(origin) || /^(?:about|data|blob):/.test(url)) return;
      externalRequests.push(url);
    }),
    connection.on('Network.responseReceived', (params, eventSessionId) => {
      if (
        eventSessionId === sessionId &&
        params.response?.url?.startsWith(origin) &&
        params.response.status >= 400
      ) {
        failedRequests.push(`${params.response.status} ${params.response.url}`);
      }
    }),
  ];

  try {
    await Promise.all([
      connection.call('Page.enable', {}, sessionId),
      connection.call('Runtime.enable', {}, sessionId),
      connection.call('Log.enable', {}, sessionId),
      connection.call('Network.enable', {}, sessionId),
      connection.call('Accessibility.enable', {}, sessionId),
    ]);
    await connection.call(
      'Emulation.setDeviceMetricsOverride',
      {
        deviceScaleFactor: 1,
        height: viewport.height,
        mobile: viewport.mobile,
        screenHeight: viewport.height,
        screenWidth: viewport.width,
        width: viewport.width,
      },
      sessionId,
    );
    await connection.call(
      'Emulation.setTouchEmulationEnabled',
      { configuration: viewport.mobile ? 'mobile' : 'desktop', enabled: viewport.mobile },
      sessionId,
    );

    const navigation = await connection.call('Page.navigate', { url: `${origin}/` }, sessionId);
    if (navigation.errorText) fail(label, `navigation failed: ${navigation.errorText}`);

    const loadDeadline = Date.now() + TIMEOUT_MS;
    let documentState;
    while (Date.now() < loadDeadline) {
      const stateResult = await connection.call(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        sessionId,
      );
      documentState = remoteValue(stateResult);
      if (documentState === 'complete') break;
      await delay(50);
    }
    if (documentState !== 'complete') throw new Error('document did not finish loading');

    const readiness = await connection.call(
      'Runtime.evaluate',
      {
        awaitPromise: true,
        expression: String.raw`(async () => {
          await document.fonts.ready;
          await Promise.all(
            [...document.images]
              .filter(image => image.loading !== 'lazy')
              .map(image => {
                if (image.complete) return undefined;
                return new Promise(resolve => {
                  image.addEventListener('load', resolve, { once: true });
                  image.addEventListener('error', resolve, { once: true });
                });
              }),
          );
          return document.readyState;
        })()`,
        returnByValue: true,
      },
      sessionId,
    );
    if (remoteValue(readiness) !== 'complete') fail(label, 'document did not reach readyState=complete');

    const evaluated = await connection.call(
      'Runtime.evaluate',
      { awaitPromise: true, expression: METRICS_EXPRESSION, returnByValue: true },
      sessionId,
    );
    const metrics = remoteValue(evaluated);
    if (!metrics?.h1Visible) fail(label, 'primary heading is not visible');
    if (!metrics?.mainVisible) fail(label, 'main landmark is not visible');
    if (!metrics?.skipTargetFocused) fail(label, 'skip link did not transfer focus to main');
    if (metrics?.innerWidth !== viewport.width || metrics?.innerHeight !== viewport.height) {
      fail(label, `viewport is ${metrics?.innerWidth}×${metrics?.innerHeight}; expected ${viewport.width}×${viewport.height}`);
    }
    if ((metrics?.scrollWidth ?? Infinity) > viewport.width + 1) {
      fail(label, `page horizontally overflows (${metrics.scrollWidth}px for ${viewport.width}px viewport)`);
    }
    if (metrics?.overflow?.length) {
      fail(
        label,
        `visible elements cross the viewport: ${metrics.overflow.map(item => `${item.element} (${item.left}..${item.right})`).join(', ')}`,
      );
    }
    if (metrics?.brokenImages?.length) fail(label, `broken images: ${metrics.brokenImages.join(', ')}`);
    if ((metrics?.headerControls?.length ?? 0) < 2) {
      fail(label, `header exposes fewer than two visible controls (${metrics?.headerControls?.join(', ') || 'none'})`);
    }
    if (!viewport.mobile && (!metrics?.productProofVisible || metrics.productProofTop > viewport.height)) {
      fail(label, 'Briefing/Print Edition product proof is not visible in the first desktop viewport');
    }
    if (viewport.mobile && metrics?.mobileBackgroundAttachment === 'fixed') {
      fail(label, 'body background-attachment remains fixed at phone width');
    }

    const accessibility = await connection.call('Accessibility.getFullAXTree', {}, sessionId);
    const meaningfulNodes = (accessibility.nodes ?? []).filter(node => !node.ignored);
    const roles = meaningfulNodes.map(node => node.role?.value);
    for (const requiredRole of ['RootWebArea', 'main', 'heading', 'navigation']) {
      if (!roles.includes(requiredRole)) fail(label, `accessibility tree is missing ${requiredRole} role`);
    }
    const unnamedControls = meaningfulNodes.filter(
      node => ['button', 'link'].includes(node.role?.value) && !node.name?.value?.trim(),
    );
    if (unnamedControls.length) fail(label, `${unnamedControls.length} rendered link/button control(s) have no accessible name`);

    const screenshot = await connection.call(
      'Page.captureScreenshot',
      { captureBeyondViewport: false, format: 'png', fromSurface: true },
      sessionId,
    );
    const dimensions = pngDimensions(screenshot.data);
    if (dimensions.width !== viewport.width || dimensions.height !== viewport.height) {
      fail(label, `screenshot is ${dimensions.width}×${dimensions.height}; expected ${viewport.width}×${viewport.height}`);
    }

    if (consoleErrors.length) fail(label, `browser errors: ${[...new Set(consoleErrors)].join(' | ')}`);
    if (failedRequests.length) fail(label, `failed requests: ${[...new Set(failedRequests)].join(' | ')}`);
    if (externalRequests.length) {
      fail(label, `unexpected third-party requests: ${[...new Set(externalRequests)].join(', ')}`);
    }

    console.log(
      `✓ ${label}: ${viewport.width}×${viewport.height}, ${Math.round(metrics.bodyHeight)}px page, ` +
        `${metrics.headerControls.length} visible header controls`,
    );
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
    try {
      await connection.call('Page.close', {}, undefined, 2_000);
    } catch {
      // Closing a page can close its DevTools socket before it acknowledges.
    }
    connection.close();
  }
}

let staticServer;
let browser;
let infrastructureSkip;
try {
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error(
      'Chrome/Chromium/Edge was not found. Set CHROME_PATH to run the landing-page render smoke test.',
    );
  }
  staticServer = await startStaticServer();
  browser = await launchBrowser(browserPath);
  console.log(`Landing render smoke using ${browserPath}`);
  for (const viewport of [
    { height: 1_080, mobile: false, name: 'wide', width: 1_920 },
    { height: 1_000, mobile: false, name: 'desktop', width: 1_440 },
    { height: 768, mobile: false, name: 'small-laptop', width: 1_024 },
    { height: 1_180, mobile: true, name: 'tablet', width: 820 },
    { height: 844, mobile: true, name: 'phone', width: 390 },
    { height: 700, mobile: true, name: 'narrow-phone', width: 320 },
  ]) {
    await renderViewport(browser.debugOrigin, staticServer.origin, viewport);
  }
} catch (error) {
  const infrastructureFailure =
    /(?:browser connection closed|browser did not expose devtools|browser exited during startup|chrome\/chromium\/edge was not found|could not create browser target|browser websocket failed)/i.test(
      error.message,
    );
  if (process.platform === 'win32' && infrastructureFailure && errors.length === 0) {
    infrastructureSkip = error.message;
  } else {
    throw error;
  }
} finally {
  if (browser) await browser.close();
  if (staticServer) await staticServer.close();
}

if (infrastructureSkip) {
  console.warn(
    `SKIP (Windows browser infrastructure): ${infrastructureSkip}\n` +
      'Static landing checks remain required. The rendered gate remains fatal on Linux CI.',
  );
} else if (errors.length > 0) {
  console.error(`Landing render smoke failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('Landing render smoke passed at wide, desktop, laptop, tablet, and phone widths.');
}
