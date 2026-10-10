import { expect, test } from '@jest/globals';
import { resolve } from 'node:path';
import { productionSmokeEnvironment } from '../scripts/check-production-render.mjs';

test('production browser smoke strips operator credentials, execution hooks and state overrides', () => {
  const env = productionSmokeEnvironment({ stateDir: './isolated', configPath: './isolated/config.json', port: 12345, secret: 'synthetic-secret' }, {
    PATH: 'test-path', SystemRoot: 'system-path', OPENAI_API_KEY: 'must-not-copy', ANTHROPIC_API_KEY: 'must-not-copy',
    AI_PROVIDER_MODULE: 'operator-module', NODE_OPTIONS: '--require operator-hook', HTTPS_PROXY: 'operator-proxy',
    API_SECRET: 'operator-secret', BLUETEAM_STATE_DIR: 'operator-data', BLUETEAM_CONFIG_PATH: 'operator-config', DOTENV_CONFIG_PATH: 'operator-env',
  });
  expect(env).toEqual({ PATH: 'test-path', SystemRoot: 'system-path', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '12345',
    API_SECRET: 'synthetic-secret', BLUETEAM_STATE_DIR: resolve('./isolated'), BLUETEAM_CONFIG_PATH: resolve('./isolated/config.json'), BLUETEAM_DISABLE_COLLECTION: '1' });
});
