import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Keep auxiliary output aligned with the server's relocated private state.
// fileURLToPath decodes spaces/non-ASCII paths on Windows and POSIX.
export function resolveStateDirectory(env = process.env) {
  return resolve(env.BLUETEAM_STATE_DIR || fileURLToPath(new URL('../', import.meta.url)));
}
