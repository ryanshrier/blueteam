// The decision lookup uses POST to send bounded signal keys, but only reads.
// Keep this exception exact: neighboring decision and provider routes mutate.
export function isReadOnlySafariFixtureRequest({ method, path }) {
  return method === 'GET' || method === 'HEAD'
    || (method === 'POST' && path === '/api/decisions/lookup');
}
