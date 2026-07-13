// Public product identity in one place. Outbound requests identify the app and
// version without leaking retired pre-release names.

import { APP_VERSION } from './version.js';

export const PUBLIC_APP_NAME = 'BlueTeam.News';

export function outboundUserAgent(env = process.env) {
  return env.BLUETEAM_USER_AGENT?.trim()
    || `${PUBLIC_APP_NAME}/${APP_VERSION} (+https://blueteam.news)`;
}
