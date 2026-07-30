import { readFile } from 'node:fs/promises';

async function read(relativePath) {
  return readFile(new URL(relativePath, new URL('../', import.meta.url)), 'utf8');
}

function capture(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`Could not read ${label}`);
  return match[1];
}

const [packageText, packageLockText, changelog, landingPage, sitemap] = await Promise.all([
  read('package.json'),
  read('package-lock.json'),
  read('CHANGELOG.md'),
  read('docs/index.html'),
  read('docs/sitemap.xml'),
]);

const manifest = JSON.parse(packageText);
const packageLock = JSON.parse(packageLockText);
const releaseHeading = changelog.match(/^##\s+(\d+\.\d+\.\d+)\s+[^\d\r\n]*(\d{4}-\d{2}-\d{2})\s*$/m);

if (!releaseHeading) {
  throw new Error('Could not read the latest version and date from CHANGELOG.md');
}

const [, changelogVersion, changelogDate] = releaseHeading;
const metadata = {
  'package.json version': manifest.version,
  'package-lock.json version': packageLock.version,
  'package-lock.json root version': packageLock.packages?.['']?.version,
  'CHANGELOG.md version': changelogVersion,
  'landing-page softwareVersion': capture(
    landingPage,
    /"softwareVersion"\s*:\s*"([^"]+)"/,
    'softwareVersion from docs/index.html',
  ),
  'landing-page release badge': capture(
    landingPage,
    /class="release-badge"[^>]*>\s*v([^<\s]+)\s*</,
    'release badge from docs/index.html',
  ),
};

const dates = {
  'CHANGELOG.md date': changelogDate,
  'landing-page dateModified': capture(
    landingPage,
    /"dateModified"\s*:\s*"([^"]+)"/,
    'dateModified from docs/index.html',
  ),
  'sitemap lastmod': capture(
    sitemap,
    /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/,
    'lastmod from docs/sitemap.xml',
  ),
};

const errors = [];
for (const [label, version] of Object.entries(metadata)) {
  if (version !== changelogVersion) {
    errors.push(`${label} is ${version}; expected ${changelogVersion}`);
  }
}

for (const [label, date] of Object.entries(dates)) {
  if (date !== changelogDate) {
    errors.push(`${label} is ${date}; expected ${changelogDate}`);
  }
}

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const expectedTag = `v${changelogVersion}`;
  if (process.env.GITHUB_REF_NAME !== expectedTag) {
    errors.push(`release tag is ${process.env.GITHUB_REF_NAME}; expected ${expectedTag}`);
  }
}

if (errors.length > 0) {
  throw new Error(`Release metadata is inconsistent:\n- ${errors.join('\n- ')}`);
}

console.log(`Release metadata is consistent: v${changelogVersion} (${changelogDate})`);
