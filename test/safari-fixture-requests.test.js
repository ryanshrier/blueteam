import { expect, test } from '@jest/globals';
import { isReadOnlySafariFixtureRequest } from '../scripts/safari-fixture-requests.mjs';

test('Safari permits the exact read-only decision lookup alongside ordinary reads', () => {
  expect(isReadOnlySafariFixtureRequest({ method: 'GET', path: '/api/brief' })).toBe(true);
  expect(isReadOnlySafariFixtureRequest({ method: 'HEAD', path: '/assets/logo.svg' })).toBe(true);
  expect(isReadOnlySafariFixtureRequest({ method: 'POST', path: '/api/decisions/lookup' })).toBe(true);
});

test.each([
  ['POST', '/api/brief'],
  ['POST', '/api/refresh'],
  ['POST', '/api/settings'],
  ['POST', '/api/settings/verify'],
  ['PUT', '/api/decisions'],
  ['POST', '/api/decisions/import'],
  ['POST', '/api/decisions'],
  ['POST', '/api/decisions/lookup/import'],
  ['POST', '/api/decisions/lookup/'],
  ['POST', '/api/decisions/Lookup'],
  ['PUT', '/api/decisions/lookup'],
  ['DELETE', '/api/decisions/lookup'],
  ['PATCH', '/api/decisions/lookup'],
])('Safari still records %s %s as a forbidden write', (method, path) => {
  expect(isReadOnlySafariFixtureRequest({ method, path })).toBe(false);
});
