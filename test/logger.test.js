import { describe, test, expect, jest } from '@jest/globals';
import { log, startupBanner } from '../lib/logger.js';

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
});
