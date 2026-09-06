import { describe, test, expect, jest } from '@jest/globals';
const requestWallFullscreen = jest.fn();
jest.unstable_mockModule('../public/modules/wall/wall-browser.js', () => ({ requestWallFullscreen }));
const { resolveLocation, followInternalLink, handleRouteLink, setPageTitle, setEditionTitle, initRouter, navigate, currentViewUrl, getWallReturnUrl, getViewScroll, rememberCurrentView } = await import('../public/modules/core/router.js');

describe('client route resolution', () => {
  test('/wall is the canonical passive Wall route', () => {
    expect(resolveLocation('/wall')).toEqual({
      data: { mode: 'wall', action: null },
    });
  });

  test('analyst surfaces resolve from clean paths', () => {
    expect(resolveLocation('/wire').data.mode).toBe('wire');
    expect(resolveLocation('/briefing/new').data).toEqual({ mode: 'briefing', action: 'generate' });
    expect(resolveLocation('/settings').data.mode).toBe('settings');
  });

  test('briefing filenames are decoded and unknown paths normalize to /wire', () => {
    expect(resolveLocation('/briefing/brief%202026.md').data.filename).toBe('brief 2026.md');
    expect(resolveLocation('/').canonicalPath).toBe('/wire');
  });
});

describe('ordinary link navigation and view titles', () => {
  test('view memory returns to the exact investigation and leaves scroll restoration to the rendered view', () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const location = { pathname: '/wire', search: '?watch=1&q=Chrome', hash: '#signal' };
    const update = (_state, _unused, path) => {
      const url = new URL(path, 'https://desk.example');
      Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
    };
    globalThis.window = { location, scrollY: 480, addEventListener: jest.fn(), history: { pushState: update, replaceState: update, scrollRestoration: 'auto' } };
    globalThis.document = { addEventListener: jest.fn() };
    try {
      initRouter();
      expect(window.history.scrollRestoration).toBe('manual');
      rememberCurrentView();
      navigate('/wall');
      expect(currentViewUrl('wire')).toBe('/wire?watch=1&q=Chrome#signal');
      expect(getWallReturnUrl()).toBe('/wire?watch=1&q=Chrome#signal');
      expect(getViewScroll('wire')).toBe(480);
      expect(currentViewUrl('wall')).toBe('/wall');
      navigate(getWallReturnUrl());
      expect(location).toEqual({ pathname: '/wire', search: '?watch=1&q=Chrome', hash: '#signal' });
      navigate('/briefing/new');
      rememberCurrentView();
      expect(getWallReturnUrl()).toBe('/wire?watch=1&q=Chrome#signal');
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  });

  test('leaves modified clicks and external browsing to the browser', () => {
    requestWallFullscreen.mockClear();
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const preventDefault = jest.fn();
      followInternalLink({ button: 0, currentTarget: { getAttribute: () => '/wall' }, preventDefault, ...modifier });
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(requestWallFullscreen).not.toHaveBeenCalled();
  });

  test('only direct Wall link activation requests fullscreen; ordinary route changes stay nonblocking', () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const pushState = jest.fn();
    globalThis.window = { location: { pathname: '/wire', search: '' }, history: { pushState } };
    globalThis.document = {};
    requestWallFullscreen.mockClear();
    // An unresolved browser request must never delay route navigation.
    requestWallFullscreen.mockReturnValue(new Promise(() => {}));
    try {
      navigate('/wall');
      expect(requestWallFullscreen).not.toHaveBeenCalled();
      followInternalLink({ button: 0, currentTarget: { getAttribute: () => '/wall' }, preventDefault: jest.fn() });
      expect(requestWallFullscreen).toHaveBeenCalledTimes(1);
      expect(pushState).toHaveBeenLastCalledWith(null, '', '/wall');
      expect(requestWallFullscreen.mock.invocationCallOrder[0]).toBeLessThan(pushState.mock.invocationCallOrder.at(-1));
      followInternalLink({ button: 0, currentTarget: { getAttribute: () => '/wall?read=1' }, preventDefault: jest.fn() });
      expect(requestWallFullscreen).toHaveBeenCalledTimes(1);
      for (const attributes of [{ target: '_blank' }, { hasAttribute: () => true }]) {
        followInternalLink({ button: 0, currentTarget: { getAttribute: () => '/wall', ...attributes }, preventDefault: jest.fn() });
      }
      expect(requestWallFullscreen).toHaveBeenCalledTimes(1);
    } finally {
      requestWallFullscreen.mockReset();
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  });

  test('plain internal links update history and keep the native destination available', () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const pushState = jest.fn();
    globalThis.window = { location: { pathname: '/wire', search: '' }, history: { pushState } };
    globalThis.document = {};
    try {
      const preventDefault = jest.fn();
      followInternalLink({ button: 0, currentTarget: { getAttribute: () => '/settings' }, preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(pushState).toHaveBeenCalledWith(null, '', '/settings');
      const internal = { getAttribute: () => '/settings#systemHealth' };
      handleRouteLink({ button: 0, target: { closest: () => internal }, preventDefault });
      expect(pushState).toHaveBeenLastCalledWith(null, '', '/settings#systemHealth');
      const calls = pushState.mock.calls.length;
      for (const href of ['/api/brief/edition.md/manifest', '/embed', '//external.example/wire']) {
        handleRouteLink({ button: 0, target: { closest: () => ({ getAttribute: () => href }) }, preventDefault });
      }
      expect(pushState).toHaveBeenCalledTimes(calls);
      setPageTitle('Briefing · Sep 5, 2026 · Edition 2');
      setEditionTitle('BlueTeam.News');
      expect(document.title).toBe('Briefing · Sep 5, 2026 · Edition 2 · BlueTeam.News');
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    }
  });
});
