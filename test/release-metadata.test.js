import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseScript = join(repoRoot, 'scripts', 'check-release-metadata.mjs');
let fixtureRoot;

async function writeFixture({
  packageVersion = '1.0.3',
  lockVersion = packageVersion,
  lockRootVersion = packageVersion,
} = {}) {
  await mkdir(join(fixtureRoot, 'scripts'), { recursive: true });
  await mkdir(join(fixtureRoot, 'docs'), { recursive: true });
  await copyFile(releaseScript, join(fixtureRoot, 'scripts', 'check-release-metadata.mjs'));
  await writeFile(join(fixtureRoot, 'package.json'), JSON.stringify({
    name: 'blueteam-news',
    version: packageVersion,
  }));
  await writeFile(join(fixtureRoot, 'package-lock.json'), JSON.stringify({
    name: 'blueteam-news',
    version: lockVersion,
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'blueteam-news',
        version: lockRootVersion,
      },
    },
  }));
  await writeFile(join(fixtureRoot, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.3 — 2026-07-28\n');
  await writeFile(join(fixtureRoot, 'docs', 'index.html'), `
    <script type="application/ld+json">
      { "softwareVersion": "1.0.3", "dateModified": "2026-07-28" }
    </script>
    <span class="release-badge">v1.0.3</span>
  `);
  await writeFile(join(fixtureRoot, 'docs', 'sitemap.xml'), `
    <urlset><url><lastmod>2026-07-28</lastmod></url></urlset>
  `);
}

function runReleaseCheck() {
  return spawnSync(process.execPath, [
    join(fixtureRoot, 'scripts', 'check-release-metadata.mjs'),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REF_TYPE: '',
      GITHUB_REF_NAME: '',
    },
  });
}

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'blueteam-release-metadata-'));
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('release metadata check', () => {
  test('accepts matching manifest, lockfile, changelog, and website metadata', async () => {
    await writeFixture();
    const result = runReleaseCheck();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Release metadata is consistent: v1.0.3 (2026-07-28)');
  });

  test('rejects a stale package-lock top-level version', async () => {
    await writeFixture({ lockVersion: '1.0.2' });
    const result = runReleaseCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package-lock.json version is 1.0.2; expected 1.0.3');
  });

  test('rejects a stale package-lock root-package version', async () => {
    await writeFixture({ lockRootVersion: '1.0.2' });
    const result = runReleaseCheck();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package-lock.json root version is 1.0.2; expected 1.0.3');
  });
});
