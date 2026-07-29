/**
 * Deterministic GitHub Pages quality gate.
 *
 * This intentionally uses htmlparser2, which is already part of the production
 * dependency graph, instead of adding a second HTML validator or accessibility
 * test stack. It checks the errors that are most likely to make this small
 * static site unusable: broken local URLs and fragments, malformed document
 * structure, missing accessible names/landmarks, weak social metadata, and
 * release metadata drift. A separate real-browser smoke test covers parsing,
 * layout, loading, and keyboard focus at desktop and phone widths.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'htmlparser2';

const ROOT = process.cwd();
const DOCS = join(ROOT, 'docs');
const SITE_ORIGIN = 'https://blueteam.news';
const SITE_URL = `${SITE_ORIGIN}/`;
const HTML_FILES = ['index.html', '404.html'];
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const INTERACTIVE_ELEMENTS = new Set(['a', 'button', 'embed', 'iframe', 'input', 'select', 'summary', 'textarea']);
const HEADING_ELEMENTS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const VERSIONED_EXTENSIONS = new Set([
  '.css',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.png',
  '.svg',
  '.webp',
  '.woff2',
]);
const RASTER_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);
// The transfer guard deliberately counts every local @font-face asset, not just
// the two fonts preloaded by index.html. A cold browser may fetch the remaining
// faces as soon as their styles appear in the first viewport. Keep a component
// budget as well as the aggregate so a higher honest total does not hide growth.
const INITIAL_TRANSFER_BUDGET = 350 * 1024;
const INITIAL_NON_FONT_BUDGET = 190 * 1024;
const LOCAL_FONT_BUDGET = 150 * 1024;
const LOCAL_FONT_FILE_BUDGET = 70 * 1024;
const RASTER_FILE_BUDGET = 300 * 1024;

const errors = [];
const checks = [];

function fail(file, message) {
  errors.push(`${file}: ${message}`);
}

function pass(message) {
  checks.push(message);
}

function isElement(node) {
  return node?.type === 'tag' || node?.type === 'script' || node?.type === 'style';
}

function descendants(node, predicate = isElement) {
  const found = [];
  const visit = current => {
    for (const child of current?.children ?? []) {
      if (predicate(child)) found.push(child);
      visit(child);
    }
  };
  visit(node);
  return found;
}

function elementsByName(document, name) {
  return descendants(document, node => isElement(node) && node.name === name);
}

function textContent(node) {
  let text = '';
  const visit = current => {
    if (current?.type === 'text') text += current.data ?? '';
    for (const child of current?.children ?? []) visit(child);
  };
  visit(node);
  return text.replace(/\s+/g, ' ').trim();
}

function firstElement(document, name, predicate = () => true) {
  return elementsByName(document, name).find(predicate);
}

function metaContent(document, key, attribute = 'name') {
  return firstElement(
    document,
    'meta',
    node => node.attribs?.[attribute]?.toLowerCase() === key.toLowerCase(),
  )?.attribs?.content?.trim();
}

function linkHref(document, rel) {
  return firstElement(
    document,
    'link',
    node => (node.attribs?.rel ?? '').split(/\s+/).includes(rel),
  )?.attribs?.href?.trim();
}

function accessibleName(node, idMap) {
  const ariaLabel = node.attribs?.['aria-label']?.trim();
  if (ariaLabel) return ariaLabel;

  const labelledBy = node.attribs?.['aria-labelledby']?.trim();
  if (labelledBy) {
    const label = labelledBy
      .split(/\s+/)
      .map(id => textContent(idMap.get(id)))
      .filter(Boolean)
      .join(' ');
    if (label) return label;
  }

  const ownText = textContent(node);
  if (ownText) return ownText;

  return descendants(node, child => isElement(child) && child.name === 'img')
    .map(image => image.attribs?.alt?.trim())
    .filter(Boolean)
    .join(' ');
}

function hasAncestor(node, predicate) {
  let cursor = node?.parent;
  while (cursor) {
    if (predicate(cursor)) return true;
    cursor = cursor.parent;
  }
  return false;
}

function parseSrcset(value) {
  if (!value || value.trim().startsWith('data:')) return [];
  return value
    .split(',')
    .map(candidate => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function stripQueryAndHash(value) {
  const index = value.search(/[?#]/);
  return index === -1 ? value : value.slice(0, index);
}

function fragmentFromReference(value) {
  const index = value.indexOf('#');
  return index === -1 ? '' : decodeURIComponent(value.slice(index + 1));
}

function isSkippableScheme(value) {
  return /^(?:mailto|tel|data):/i.test(value);
}

function exactRelativePath(pathname) {
  return pathname
    .replace(/^\/+/, '')
    .split('/')
    .map(segment => decodeURIComponent(segment))
    .join('/');
}

async function existsWithExactCase(root, relativePath) {
  if (!relativePath || relativePath.includes('\\')) return false;
  const parts = relativePath.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) return false;

  let cursor = root;
  for (const part of parts) {
    let entries;
    try {
      entries = await readdir(cursor);
    } catch {
      return false;
    }
    if (!entries.includes(part)) return false;
    cursor = join(cursor, part);
  }
  try {
    return (await stat(cursor)).isFile();
  } catch {
    return false;
  }
}

async function resolveLocalReference(sourceFile, rawReference) {
  const raw = rawReference.trim();
  if (!raw || raw.startsWith('#') || isSkippableScheme(raw)) return null;
  if (/^javascript:/i.test(raw)) return { error: 'javascript: URLs are not permitted' };

  let pathname = stripQueryAndHash(raw);
  if (/^https?:\/\//i.test(raw) || raw.startsWith('//')) {
    let parsed;
    try {
      parsed = new URL(raw, SITE_URL);
    } catch {
      return { error: `invalid URL "${raw}"` };
    }
    if (parsed.origin !== SITE_ORIGIN) return null;
    pathname = parsed.pathname;
  }

  let relativePath;
  if (pathname.startsWith('/')) {
    relativePath = exactRelativePath(pathname);
  } else {
    const base = dirname(sourceFile).replaceAll('\\', '/');
    relativePath = normalize(join(base, decodeURIComponent(pathname))).replaceAll('\\', '/');
  }
  if (!relativePath) relativePath = 'index.html';

  const candidates = extname(relativePath)
    ? [relativePath]
    : [
        relativePath,
        `${relativePath}.html`,
        `${relativePath.replace(/\/$/, '')}/index.html`,
      ];
  for (const candidate of candidates) {
    if (await existsWithExactCase(DOCS, candidate)) return { relativePath: candidate };
  }
  return { relativePath: candidates[0], missing: true };
}

async function validateReference(sourceFile, rawReference, attribute, idMapByFile) {
  const raw = rawReference.trim();
  if (!raw) {
    fail(sourceFile, `${attribute} must not be empty`);
    return;
  }

  if (raw.startsWith('#')) {
    const fragment = fragmentFromReference(raw);
    if (!fragment || !idMapByFile.get(sourceFile)?.has(fragment)) {
      fail(sourceFile, `${attribute}="${raw}" points to a missing fragment`);
    }
    return;
  }

  const result = await resolveLocalReference(sourceFile, raw);
  if (!result) return;
  if (result.error) {
    fail(sourceFile, `${attribute}="${raw}": ${result.error}`);
    return;
  }
  if (result.missing) {
    fail(sourceFile, `${attribute}="${raw}" points to missing docs/${result.relativePath}`);
    return;
  }

  const fragment = fragmentFromReference(raw);
  if (!fragment || !result.relativePath.endsWith('.html')) return;
  if (!idMapByFile.get(result.relativePath)?.has(fragment)) {
    fail(sourceFile, `${attribute}="${raw}" points to a missing fragment in ${result.relativePath}`);
  }
}

function validateDocumentStructure(file, html, document, idMap) {
  if (!/^\s*<!doctype\s+html\s*>/i.test(html)) {
    fail(file, 'must begin with <!doctype html>');
  }

  const htmlElements = elementsByName(document, 'html');
  const heads = elementsByName(document, 'head');
  const bodies = elementsByName(document, 'body');
  const mains = elementsByName(document, 'main');
  const h1s = elementsByName(document, 'h1');

  if (htmlElements.length !== 1) fail(file, `expected one <html>; found ${htmlElements.length}`);
  if (heads.length !== 1) fail(file, `expected one <head>; found ${heads.length}`);
  if (bodies.length !== 1) fail(file, `expected one <body>; found ${bodies.length}`);
  if (mains.length !== 1) fail(file, `expected one <main>; found ${mains.length}`);
  if (h1s.length !== 1) fail(file, `expected one <h1>; found ${h1s.length}`);
  if (htmlElements[0]?.attribs?.lang !== 'en') fail(file, '<html> must declare lang="en"');

  if (file === 'index.html') {
    if (mains[0]?.attribs?.id !== 'main') fail(file, '<main> must retain id="main" for the skip link');
    if (mains[0]?.attribs?.tabindex !== '-1') {
      fail(file, '<main id="main"> must use tabindex="-1" so the skip link transfers focus');
    }
  }

  const headings = descendants(document, node => isElement(node) && HEADING_ELEMENTS.has(node.name));
  let previousLevel = 0;
  for (const heading of headings) {
    const level = Number(heading.name.slice(1));
    if (!textContent(heading)) fail(file, `<${heading.name}> must not be empty`);
    if (previousLevel > 0 && level > previousLevel + 1) {
      fail(file, `heading order skips from h${previousLevel} to h${level}`);
    }
    previousLevel = level;
  }

  for (const section of elementsByName(document, 'section')) {
    const name = accessibleName(section, idMap);
    const hasHeading = descendants(section, node => isElement(node) && HEADING_ELEMENTS.has(node.name)).length > 0;
    if (!name && !hasHeading) fail(file, '<section> needs a heading or accessible label');
  }

  for (const nav of elementsByName(document, 'nav')) {
    if (!accessibleName(nav, idMap)) fail(file, '<nav> needs an accessible name');
  }

  const interactive = descendants(document, node => {
    if (!isElement(node)) return false;
    if (INTERACTIVE_ELEMENTS.has(node.name)) return true;
    if (node.name === 'input' && node.attribs?.type !== 'hidden') return true;
    return Boolean(node.attribs?.tabindex && node.attribs.tabindex !== '-1');
  });
  for (const node of interactive) {
    if (hasAncestor(node, ancestor => isElement(ancestor) && ['a', 'button'].includes(ancestor.name))) {
      fail(file, `<${node.name}> must not be nested inside another interactive element`);
    }
  }

  for (const image of elementsByName(document, 'img')) {
    if (!Object.hasOwn(image.attribs ?? {}, 'alt')) fail(file, `<img src="${image.attribs?.src ?? ''}"> needs alt text`);
    for (const dimension of ['width', 'height']) {
      if (!/^[1-9]\d*$/.test(image.attribs?.[dimension] ?? '')) {
        fail(file, `<img src="${image.attribs?.src ?? ''}"> needs an integer ${dimension}`);
      }
    }
  }

  for (const anchor of elementsByName(document, 'a')) {
    if (!anchor.attribs?.href?.trim()) fail(file, '<a> needs a non-empty href');
    if (!accessibleName(anchor, idMap)) fail(file, `<a href="${anchor.attribs?.href ?? ''}"> needs an accessible name`);
    if (anchor.attribs?.target === '_blank') {
      const relTokens = new Set((anchor.attribs?.rel ?? '').split(/\s+/).filter(Boolean));
      if (!relTokens.has('noopener')) fail(file, `<a href="${anchor.attribs?.href ?? ''}" target="_blank"> needs rel="noopener"`);
    }
    if (textContent(anchor).includes('↗') && anchor.attribs?.target !== '_blank') {
      fail(file, `<a href="${anchor.attribs?.href ?? ''}"> uses ↗ but does not open a new tab`);
    }
  }

  for (const button of elementsByName(document, 'button')) {
    if (!button.attribs?.type) fail(file, '<button> must declare its type');
    if (!accessibleName(button, idMap)) fail(file, '<button> needs an accessible name');
  }

  for (const id of idMap.keys()) {
    if (/\s/.test(id)) fail(file, `id="${id}" must not contain whitespace`);
  }

  // htmlparser2 closes unknown/malformed non-void elements for us. Catch the
  // most common authoring mistake that its recovery would otherwise conceal.
  for (const tag of VOID_ELEMENTS) {
    if (new RegExp(`</${tag}\\s*>`, 'i').test(html)) fail(file, `void element <${tag}> must not have an end tag`);
  }
}

function validateProductTruth(file, document) {
  if (file !== 'index.html') return;
  const bodyText = textContent(firstElement(document, 'body'));
  const publicMetadata = [
    textContent(firstElement(document, 'title')),
    metaContent(document, 'description'),
    metaContent(document, 'og:title', 'property'),
    metaContent(document, 'og:description', 'property'),
    metaContent(document, 'twitter:title'),
    metaContent(document, 'twitter:description'),
    ...elementsByName(document, 'script')
      .filter(node => node.attribs?.type === 'application/ld+json')
      .map(textContent),
  ]
    .filter(Boolean)
    .join(' ');
  const requiredClaims = [
    [/Turn threat reporting into a daily defensive picture\./i, 'must lead with the operational outcome'],
    [/Wall \+ Wire\s*No API key/i, 'must scope the no-key claim to Wall + Wire'],
    [/Briefing generation\s*Anthropic API key/i, 'must disclose the Briefing key requirement in the product proof'],
    [/Add your Anthropic API key for an AI-generated Briefing/i, 'must state the Anthropic requirement in visible prose'],
    [/One Briefing\. Two formats\./i, 'must explain that the reader and Print Edition share one Briefing'],
    [/Built for the floor\. Grounded in evidence\./i, 'must retain the concise evidence-led product promise'],
    [/\bAI-generated\b/i, 'must label Briefings AI-generated'],
    [/\bPrint Edition\b/i, 'must name the Print Edition'],
    [/\bRun locally\b/i, 'must use source-run language for the primary call to action'],
  ];
  for (const [pattern, message] of requiredClaims) {
    if (!pattern.test(bodyText)) fail(file, message);
  }

  const misleadingClaims = [
    [/\bInstall locally\b/i, 'must not market the source workflow as a standalone install'],
    [/\bNo API key required\b/i, 'must not make an unscoped no-key claim'],
    [/\bBriefing is optional\b/i, 'must not minimize the key requirement for the featured workflow'],
    [/\bAI-assisted\b/i, 'must describe generated Briefings as AI-generated'],
    [/\bsmall blue teams\b/i, 'must not narrow the product to a single team size'],
    [/One assessment\. Two reading modes\./i, 'must not present a format choice as a product-view taxonomy'],
    [/\b(?:macOS|Windows|Linux),\s*(?:macOS|Windows|Linux),\s*and\s*(?:macOS|Windows|Linux)\b/i, 'must not imply an OS-specific installer or universal OS support'],
  ];
  for (const [pattern, message] of misleadingClaims) {
    if (pattern.test(bodyText)) fail(file, message);
  }
  if (/\bfor (?:small )?blue teams\b/i.test(publicMetadata)) {
    fail(file, 'public metadata must not narrow the product to a single team size');
  }
  if (!/Turn threat reporting into a daily defensive picture\./i.test(publicMetadata)) {
    fail(file, 'social metadata must carry the outcome-led product promise');
  }
  pass('key, audience, format, source-run, and platform-support claims remain explicitly scoped');
}

function requireMetadata(file, document, name, { property = false } = {}) {
  const value = metaContent(document, name, property ? 'property' : 'name');
  if (!value) fail(file, `missing ${property ? 'property' : 'name'}="${name}" metadata`);
  return value;
}

function contentSecurityPolicy(document) {
  return firstElement(
    document,
    'meta',
    node => node.attribs?.['http-equiv']?.toLowerCase() === 'content-security-policy',
  )?.attribs?.content?.trim();
}

function parseCsp(policy) {
  const directives = new Map();
  for (const rawDirective of policy.split(';')) {
    const [name, ...values] = rawDirective.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), values);
  }
  return directives;
}

function validateContentSecurityPolicy(file, html, document) {
  const policy = contentSecurityPolicy(document);
  if (!policy) {
    fail(file, 'missing meta Content-Security-Policy');
    return;
  }
  if (/(?:placeholder|replace[-_ ]?me|todo)/i.test(policy)) {
    fail(file, 'Content-Security-Policy contains a placeholder');
  }
  if (/\bunsafe-(?:inline|eval)\b/i.test(policy)) {
    fail(file, 'Content-Security-Policy must not allow unsafe-inline or unsafe-eval');
  }

  const directives = parseCsp(policy);
  const expected = new Map([
    ['default-src', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['connect-src', ["'none'"]],
    ['form-action', ["'none'"]],
    ['object-src', ["'none'"]],
  ]);
  for (const [name, requiredValues] of expected) {
    const values = directives.get(name) ?? [];
    for (const value of requiredValues) {
      if (!values.includes(value)) fail(file, `Content-Security-Policy ${name} must include ${value}`);
    }
  }
  for (const [name, values] of directives) {
    if (values.includes('*') || values.some(value => /^http:/i.test(value))) {
      fail(file, `Content-Security-Policy ${name} must not allow wildcard or insecure HTTP sources`);
    }
  }

  const inlineScripts = [
    ...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script\s*>/gi),
  ].map(match => match[1]).filter(script => script.length > 0);
  const scriptSources = directives.get('script-src') ?? [];
  for (const script of inlineScripts) {
    const digest = createHash('sha256').update(script, 'utf8').digest('base64');
    const source = `'sha256-${digest}'`;
    if (!scriptSources.includes(source)) {
      fail(file, `Content-Security-Policy script-src is missing the exact inline-script hash ${source}`);
    }
  }
  const declaredHashes = scriptSources.filter(source => /^'sha256-[A-Za-z0-9+/]+=*'$/.test(source));
  if (declaredHashes.length !== inlineScripts.length) {
    fail(
      file,
      `Content-Security-Policy declares ${declaredHashes.length} SHA-256 script hash(es) for ${inlineScripts.length} inline script(s)`,
    );
  }
}

function isVersionedLocalAsset(rawReference, version) {
  let parsed;
  try {
    parsed = new URL(rawReference, SITE_URL);
  } catch {
    return true;
  }
  if (parsed.origin !== SITE_ORIGIN || !VERSIONED_EXTENSIONS.has(extname(parsed.pathname).toLowerCase())) return true;
  return parsed.searchParams.get('v') === version;
}

function validateVersionedAsset(file, rawReference, version) {
  if (!isVersionedLocalAsset(rawReference, version)) {
    fail(file, `local asset "${rawReference}" must use ?v=${version}`);
  }
}

function validateMetadata(file, document, manifest, releaseVersion, releaseDate) {
  const title = textContent(firstElement(document, 'title'));
  if (!title) fail(file, 'missing non-empty <title>');

  const viewport = requireMetadata(file, document, 'viewport');
  if (viewport && (!viewport.includes('width=device-width') || !viewport.includes('initial-scale=1'))) {
    fail(file, 'viewport metadata must include width=device-width and initial-scale=1');
  }

  if (file === '404.html') {
    const robots = requireMetadata(file, document, 'robots');
    if (robots && !robots.toLowerCase().includes('noindex')) fail(file, '404 page must be noindex');
    return;
  }

  if (title.length < 30 || title.length > 65) fail(file, `<title> should be 30–65 characters; found ${title.length}`);
  const description = requireMetadata(file, document, 'description');
  if (description && (description.length < 70 || description.length > 180)) {
    fail(file, `description should be 70–180 characters; found ${description.length}`);
  }
  const robots = requireMetadata(file, document, 'robots');
  if (robots?.toLowerCase().includes('noindex')) fail(file, 'published landing page must remain indexable');
  requireMetadata(file, document, 'theme-color');
  requireMetadata(file, document, 'referrer');

  const canonical = linkHref(document, 'canonical');
  if (canonical !== SITE_URL) fail(file, `canonical URL must be ${SITE_URL}`);

  const socialFields = [
    ['og:type', true],
    ['og:url', true],
    ['og:title', true],
    ['og:description', true],
    ['og:image', true],
    ['og:image:alt', true],
    ['og:image:width', true],
    ['og:image:height', true],
    ['twitter:card', false],
    ['twitter:title', false],
    ['twitter:description', false],
    ['twitter:image', false],
    ['twitter:image:alt', false],
  ];
  for (const [name, property] of socialFields) requireMetadata(file, document, name, { property });
  if (metaContent(document, 'og:url', 'property') !== SITE_URL) fail(file, `og:url must be ${SITE_URL}`);

  const schemas = elementsByName(document, 'script').filter(
    script => script.attribs?.type === 'application/ld+json',
  );
  if (schemas.length === 0) fail(file, 'missing JSON-LD structured data');
  for (const schema of schemas) {
    try {
      const data = JSON.parse(textContent(schema));
      if (data['@context'] !== 'https://schema.org') fail(file, 'JSON-LD @context must be https://schema.org');
      const nodes = Array.isArray(data['@graph']) ? data['@graph'] : [data];
      const application = nodes.find(node => node?.['@type'] === 'SoftwareApplication');
      if (!application) {
        fail(file, 'JSON-LD must include a SoftwareApplication node');
        continue;
      }
      if (application.name !== 'BlueTeam.News') fail(file, 'JSON-LD application name must be BlueTeam.News');
      if (application.url !== SITE_URL) fail(file, `JSON-LD application url must be ${SITE_URL}`);
      if (application.softwareVersion !== manifest.version || application.softwareVersion !== releaseVersion) {
        fail(file, `JSON-LD softwareVersion must match package and release version ${releaseVersion}`);
      }
      if (application.dateModified !== releaseDate) fail(file, `JSON-LD dateModified must be ${releaseDate}`);
      for (const field of ['downloadUrl', 'releaseNotes', 'screenshot', 'featureList']) {
        if (!application[field] || (Array.isArray(application[field]) && application[field].length === 0)) {
          fail(file, `JSON-LD must include ${field}`);
        }
      }
      const sourceArchive = `https://github.com/ryanshrier/blueteam/archive/refs/tags/v${releaseVersion}.tar.gz`;
      if (application.downloadUrl !== sourceArchive) {
        fail(file, `JSON-LD downloadUrl must identify the tagged source archive ${sourceArchive}`);
      }
      for (const field of ['image', 'screenshot']) {
        if (application[field]) validateVersionedAsset(file, application[field], releaseVersion);
      }
    } catch (error) {
      fail(file, `invalid JSON-LD: ${error.message}`);
    }
  }
}

async function fileSizeForReference(sourceFile, rawReference) {
  const resolved = await resolveLocalReference(sourceFile, rawReference);
  if (!resolved || resolved.error || resolved.missing) return null;
  return (await stat(join(DOCS, resolved.relativePath))).size;
}

async function validatePerformanceBudget(indexDocument, indexHtml, styles, version) {
  const referencedRasters = new Map();
  const addRaster = async (sourceFile, reference) => {
    let parsed;
    try {
      parsed = new URL(reference, SITE_URL);
    } catch {
      return;
    }
    if (parsed.origin !== SITE_ORIGIN || !RASTER_EXTENSIONS.has(extname(parsed.pathname).toLowerCase())) return;
    const resolved = await resolveLocalReference(sourceFile, reference);
    if (!resolved || resolved.error || resolved.missing || referencedRasters.has(resolved.relativePath)) return;
    referencedRasters.set(resolved.relativePath, (await stat(join(DOCS, resolved.relativePath))).size);
  };

  for (const element of descendants(indexDocument)) {
    for (const attribute of ['href', 'src']) {
      const reference = element.attribs?.[attribute];
      if (reference) await addRaster('index.html', reference);
    }
    for (const reference of parseSrcset(element.attribs?.srcset)) await addRaster('index.html', reference);
  }
  for (const name of ['og:image', 'twitter:image']) {
    const attribute = name.startsWith('og:') ? 'property' : 'name';
    const reference = metaContent(indexDocument, name, attribute);
    if (reference) await addRaster('index.html', reference);
  }

  for (const [path, size] of referencedRasters) {
    if (size > RASTER_FILE_BUDGET) {
      fail(
        path,
        `referenced raster is ${Math.ceil(size / 1024)} KiB; budget is ${RASTER_FILE_BUDGET / 1024} KiB`,
      );
    }
  }

  const fontPreloads = elementsByName(indexDocument, 'link').filter(
    link =>
      (link.attribs?.rel ?? '').split(/\s+/).includes('preload') &&
      link.attribs?.as === 'font',
  );
  if (fontPreloads.length > 2) {
    fail('index.html', `preloads ${fontPreloads.length} fonts; budget allows at most 2`);
  }

  const localFonts = new Map();
  for (const face of styles.matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)) {
    for (const match of face[1].matchAll(/\burl\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
      const reference = match[2].trim();
      let parsed;
      try {
        parsed = new URL(reference, SITE_URL);
      } catch {
        continue;
      }
      if (parsed.origin !== SITE_ORIGIN) continue;

      const resolved = await resolveLocalReference('styles.css', reference);
      if (!resolved || resolved.error || resolved.missing) {
        fail('styles.css', `could not resolve local @font-face asset "${reference}" for the transfer budget`);
        continue;
      }
      if (localFonts.has(resolved.relativePath)) continue;

      const size = (await stat(join(DOCS, resolved.relativePath))).size;
      localFonts.set(resolved.relativePath, size);
      if (size > LOCAL_FONT_FILE_BUDGET) {
        fail(
          resolved.relativePath,
          `local font is ${Math.ceil(size / 1024)} KiB; per-file budget is ${LOCAL_FONT_FILE_BUDGET / 1024} KiB`,
        );
      }
    }
  }
  for (const preload of fontPreloads) {
    const reference = preload.attribs?.href?.trim();
    if (!reference) continue;
    const resolved = await resolveLocalReference('index.html', reference);
    if (!resolved || resolved.error || resolved.missing || localFonts.has(resolved.relativePath)) continue;
    const size = (await stat(join(DOCS, resolved.relativePath))).size;
    localFonts.set(resolved.relativePath, size);
    if (size > LOCAL_FONT_FILE_BUDGET) {
      fail(
        resolved.relativePath,
        `preloaded font is ${Math.ceil(size / 1024)} KiB; per-file budget is ${LOCAL_FONT_FILE_BUDGET / 1024} KiB`,
      );
    }
  }
  if (localFonts.size === 0) {
    fail('styles.css', 'expected at least one local @font-face asset for the transfer budget');
  }

  const initialReferences = new Set();
  for (const stylesheet of elementsByName(indexDocument, 'link').filter(
    link => (link.attribs?.rel ?? '').split(/\s+/).includes('stylesheet'),
  )) {
    if (stylesheet.attribs?.href) initialReferences.add(stylesheet.attribs.href);
  }
  for (const script of elementsByName(indexDocument, 'script')) {
    if (script.attribs?.src) initialReferences.add(script.attribs.src);
  }

  const heroImage = elementsByName(indexDocument, 'img').find(
    image => image.attribs?.fetchpriority === 'high',
  );
  if (!heroImage) {
    fail('index.html', 'expected one fetchpriority="high" hero image for the first viewport');
    return;
  }
  const heroCandidates = new Set([heroImage.attribs?.src].filter(Boolean));
  const picture = hasAncestor(heroImage, ancestor => isElement(ancestor) && ancestor.name === 'picture')
    ? heroImage.parent
    : null;
  if (picture?.name === 'picture') {
    for (const source of descendants(picture, node => isElement(node) && node.name === 'source')) {
      for (const reference of parseSrcset(source.attribs?.srcset)) heroCandidates.add(reference);
    }
  }

  let largestHeroBytes = 0;
  for (const reference of heroCandidates) {
    const size = await fileSizeForReference('index.html', reference);
    if (size) largestHeroBytes = Math.max(largestHeroBytes, size);
  }
  if (largestHeroBytes === 0) {
    fail('index.html', 'could not resolve any hero-image candidate for the transfer budget');
    return;
  }

  let nonFontBytes = Buffer.byteLength(indexHtml, 'utf8') + largestHeroBytes;
  for (const reference of initialReferences) {
    const size = await fileSizeForReference('index.html', reference);
    if (size) nonFontBytes += size;
  }
  const fontBytes = [...localFonts.values()].reduce((sum, size) => sum + size, 0);
  const initialBytes = nonFontBytes + fontBytes;

  if (nonFontBytes > INITIAL_NON_FONT_BUDGET) {
    fail(
      'index.html',
      `initial HTML/CSS/JS/largest-hero assets are ${Math.ceil(nonFontBytes / 1024)} KiB; component limit is ${INITIAL_NON_FONT_BUDGET / 1024} KiB`,
    );
  }
  if (fontBytes > LOCAL_FONT_BUDGET) {
    fail(
      'styles.css',
      `${localFonts.size} local @font-face assets total ${Math.ceil(fontBytes / 1024)} KiB; component limit is ${LOCAL_FONT_BUDGET / 1024} KiB`,
    );
  }
  if (initialBytes > INITIAL_TRANSFER_BUDGET) {
    fail(
      'index.html',
      `initial HTML/CSS/JS/largest-hero/all-local-font budget is ${Math.ceil(initialBytes / 1024)} KiB; limit is ${INITIAL_TRANSFER_BUDGET / 1024} KiB`,
    );
  } else {
    pass(
      `initial asset budget is ${Math.ceil(initialBytes / 1024)} KiB / ${INITIAL_TRANSFER_BUDGET / 1024} KiB (${Math.ceil(nonFontBytes / 1024)} KiB HTML/CSS/JS/hero + ${Math.ceil(fontBytes / 1024)} KiB across ${localFonts.size} local fonts); largest raster is ${Math.ceil(Math.max(...referencedRasters.values()) / 1024)} KiB`,
    );
  }

  for (const match of styles.matchAll(/\burl\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
    validateVersionedAsset('styles.css', match[2], version);
  }
}

const [manifestText, changelog, sitemap, robots, styles, ...htmlTexts] = await Promise.all([
  readFile(join(ROOT, 'package.json'), 'utf8'),
  readFile(join(ROOT, 'CHANGELOG.md'), 'utf8'),
  readFile(join(DOCS, 'sitemap.xml'), 'utf8'),
  readFile(join(DOCS, 'robots.txt'), 'utf8'),
  readFile(join(DOCS, 'styles.css'), 'utf8'),
  ...HTML_FILES.map(file => readFile(join(DOCS, file), 'utf8')),
]);
const manifest = JSON.parse(manifestText);
const releaseHeading = changelog.match(/^##\s+(\d+\.\d+\.\d+)\s+[^\d\r\n]*(\d{4}-\d{2}-\d{2})\s*$/m);
if (!releaseHeading) throw new Error('Could not read latest version/date from CHANGELOG.md');
const [, releaseVersion, releaseDate] = releaseHeading;

const documents = new Map();
const idsByFile = new Map();
for (const [index, file] of HTML_FILES.entries()) {
  const html = htmlTexts[index];
  const document = parseDocument(html, {
    decodeEntities: true,
    lowerCaseAttributeNames: true,
    lowerCaseTags: true,
    recognizeSelfClosing: true,
  });
  documents.set(file, { html, document });

  const idMap = new Map();
  for (const element of descendants(document)) {
    const id = element.attribs?.id;
    if (!id) continue;
    if (idMap.has(id)) fail(file, `duplicate id="${id}"`);
    idMap.set(id, element);
  }
  idsByFile.set(file, idMap);
}

for (const file of HTML_FILES) {
  const { html, document } = documents.get(file);
  const idMap = idsByFile.get(file);
  validateDocumentStructure(file, html, document, idMap);
  validateProductTruth(file, document);
  validateContentSecurityPolicy(file, html, document);
  validateMetadata(file, document, manifest, releaseVersion, releaseDate);

  for (const element of descendants(document)) {
    for (const attribute of ['href', 'src']) {
      const value = element.attribs?.[attribute];
      if (value !== undefined) {
        await validateReference(file, value, attribute, idsByFile);
        validateVersionedAsset(file, value, releaseVersion);
      }
    }
    for (const value of parseSrcset(element.attribs?.srcset)) {
      await validateReference(file, value, 'srcset', idsByFile);
      validateVersionedAsset(file, value, releaseVersion);
    }
  }
  for (const name of ['og:image', 'og:image:secure_url', 'twitter:image']) {
    const attribute = name.startsWith('og:') ? 'property' : 'name';
    const value = metaContent(document, name, attribute);
    if (value) {
      await validateReference(file, value, 'content', idsByFile);
      validateVersionedAsset(file, value, releaseVersion);
    }
  }
}

for (const match of styles.matchAll(/\burl\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
  await validateReference('styles.css', match[2], 'url()', idsByFile);
}
await validatePerformanceBudget(documents.get('index.html').document, documents.get('index.html').html, styles, releaseVersion);

const sitemapLocation = sitemap.match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1];
const sitemapDate = sitemap.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1];
if (sitemapLocation !== SITE_URL) fail('sitemap.xml', `<loc> must be ${SITE_URL}`);
if (sitemapDate !== releaseDate) fail('sitemap.xml', `<lastmod> must match release date ${releaseDate}`);
if (!robots.includes(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`)) {
  fail('robots.txt', `must advertise ${SITE_ORIGIN}/sitemap.xml`);
}

// Refuse an accidental filesystem escape even if a future URL parser changes.
for (const file of HTML_FILES) {
  const absolute = resolve(DOCS, file);
  if (relative(DOCS, absolute).split(sep).includes('..')) fail(file, 'resolved outside docs/');
}

if (errors.length > 0) {
  console.error(`Landing-page quality checks failed (${errors.length}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  pass(`${HTML_FILES.length} HTML documents have valid landmarks and accessible names`);
  pass('all local URLs, fragments, src/srcset assets, and social images resolve with exact case');
  pass(`CSP hashes are exact and every local asset URL is versioned v${releaseVersion}`);
  pass(`release, sitemap, social, and JSON-LD metadata agree on v${releaseVersion} (${releaseDate})`);
  console.log(`Landing-page quality checks passed:\n- ${checks.join('\n- ')}`);
}
