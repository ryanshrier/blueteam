import { describe, test, expect, jest } from '@jest/globals';
import { log, sanitizeLogText, startupBanner } from '../lib/logger.js';

describe('logger environment selection', () => {
  test('honors NODE_ENV set after module evaluation', () => {
    const prior = process.env.NODE_ENV;
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.env.NODE_ENV = 'production';
      log.info('test', 'structured');
      const line = write.mock.calls.at(-1)[0];
      expect(JSON.parse(line)).toMatchObject({ level: 'info', component: 'test', msg: 'structured' });
    } finally {
      write.mockRestore();
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  test('uses the public product name in the operator-facing startup banner', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      startupBanner({ host: '127.0.0.1', port: 3000, version: '1.0.0', feedCount: 42, aiEnabled: false });
      const banner = write.mock.calls.at(-1)[0];
      expect(banner).toContain('BlueTeam.News v1.0.0');
      expect(banner).not.toContain('Watchfloor');
    } finally {
      write.mockRestore();
    }
  });

  test('neutralizes terminal controls and bidi overrides while retaining safe multiline diagnostics', () => {
    const unsafe = 'first line\r\nforged\x1b]8;;https://evil.example\x07link\x1b[31m\u202esecret\u2028separator\u2029paragraph\nthird line';
    const safe = sanitizeLogText(unsafe);
    expect(safe).toContain('first line\nforged');
    expect(safe).toContain('\\u{1B}');
    expect(safe).toContain('\\u{7}');
    expect(safe).toContain('\\u{202E}');
    expect(safe).toContain('\\u{2028}');
    expect(safe).toContain('\\u{2029}');
    expect(safe).not.toContain('\x1b');
    expect(safe).not.toContain('\u202e');
    expect(safe).not.toContain('\u2028');
    expect(safe).not.toContain('\u2029');
  });

  test('redacts URL userinfo, bearer tokens, API keys, and Anthropic keys', () => {
    const anthropicFixture = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz'].join('-');
    const safe = sanitizeLogText(
      'https://user:supersecret@example.com/x '
      + 'Bearer abc.def.ghi api_key=query-secret '
      + anthropicFixture,
    );
    expect(safe).toContain('https://[REDACTED]@example.com/x');
    expect(safe).toContain('Bearer [REDACTED]');
    expect(safe).toContain('api_key=[REDACTED]');
    expect(safe).toContain('[REDACTED_ANTHROPIC_KEY]');
    expect(safe).not.toMatch(/supersecret|abc\.def|query-secret|sk-ant-api03/i);
  });

  test('prefixes every development-mode continuation line with trusted metadata', () => {
    const prior = process.env.NODE_ENV;
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.env.NODE_ENV = 'development';
      log.info('feed\nforged', 'line one\n[00:00:00] [ADMIN] forged');
      const output = write.mock.calls.at(-1)[0];
      const lines = output.trimEnd().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/\[FEED_NFORGED\].*line one/);
      expect(lines[1]).toMatch(/\[FEED_NFORGED\].*\| \[00:00:00\] \[ADMIN\] forged/);
    } finally {
      write.mockRestore();
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  test('sanitizes structured messages and extras without allowing canonical-field overrides', () => {
    const prior = process.env.NODE_ENV;
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.env.NODE_ENV = 'production';
      log.info('test', 'safe', {
        msg: 'attacker override',
        level: 'error',
        detail: 'https://u:p@example.com/',
      });
      const entry = JSON.parse(write.mock.calls.at(-1)[0]);
      expect(entry).toMatchObject({
        level: 'info',
        component: 'test',
        msg: 'safe',
        detail: 'https://[REDACTED]@example.com/',
      });
    } finally {
      write.mockRestore();
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });
});
