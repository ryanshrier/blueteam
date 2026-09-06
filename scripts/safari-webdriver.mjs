// Minimal W3C WebDriver transport. SafariDriver owns browser interaction;
// Node's built-in fetch is the only client dependency.
export class SafariWebDriver {
  constructor(origin, request = fetch) { this.origin = origin; this.request = request; this.sessionId = null; this.events = []; }

  async command(method, path, body, timeoutMs = 30_000) {
    const event = { method, path, startedAt: new Date().toISOString(), timeoutMs };
    const started = Date.now();
    this.events.push(event);
    try {
      const response = await this.request(this.origin + path, {
        method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json();
      if (!response.ok || payload.value?.error) throw new Error(`${payload.value?.error || response.status}: ${payload.value?.message || 'WebDriver failed'}`);
      event.status = 'success';
      return payload.value;
    } catch (error) {
      event.status = 'failed'; event.error = error.message;
      throw new Error(`${method} ${path} (${timeoutMs}ms limit): ${error.message}`, { cause: error });
    } finally { event.elapsedMs = Date.now() - started; }
  }

  session(method, path, body, timeoutMs) {
    if (!this.sessionId) throw new Error('Safari session has not started');
    return this.command(method, `/session/${encodeURIComponent(this.sessionId)}${path}`, body, timeoutMs);
  }

  execute(script, args = []) { return this.session('POST', '/execute/sync', { script, args }); }

  async element(selector) {
    const result = await this.session('POST', '/element', { using: 'css selector', value: selector });
    const id = result?.['element-6066-11e4-a52e-4f735466cecf'];
    if (!id) throw new Error(`Safari returned no W3C element for ${selector}`);
    return id;
  }

  async click(selector) {
    const id = await this.element(selector);
    return this.session('POST', `/element/${encodeURIComponent(id)}/click`, {});
  }

  async key(value, shift = false) {
    const actions = [
      ...(shift ? [{ type: 'keyDown', value: '\uE008' }] : []),
      { type: 'keyDown', value }, { type: 'keyUp', value },
      ...(shift ? [{ type: 'keyUp', value: '\uE008' }] : []),
    ];
    return this.session('POST', '/actions', { actions: [{ type: 'key', id: 'keyboard', actions }] });
  }
}
