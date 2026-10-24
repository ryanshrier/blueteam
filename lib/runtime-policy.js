export const SUPPORTED_NODE_FLOORS = Object.freeze({ 22: [23, 4], 24: [22, 1], 26: [12, 1] });

export function supportedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  const floor = SUPPORTED_NODE_FLOORS[major];
  return Boolean(floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1])));
}

export function assertSupportedNode(version = process.versions.node) {
  if (!supportedNode(version)) throw new Error(`Unsupported Node ${version}. Use Node 22.23.4+,24.22.1+,or26.12.1+ within those majors. On Windows run scripts/setup-lts.ps1, then npm start.`);
}
