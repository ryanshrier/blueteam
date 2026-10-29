import { buildGenerationManifest } from '../../lib/generation-manifest.js';
import { buildGroundingManifest } from '../../lib/grounding.js';

// Synthetic worst-density normal collection: bounded feed/article captures,
// several publishers per grouped event, and distinct retained revision IDs.
export function busyGenerationManifest({ count = 50, grouped = true } = {}) {
  const fill = (value, length) => value.repeat(Math.ceil(length / value.length)).slice(0, length);
  const headlines = Array.from({ length: count }, (_, index) => {
    const title = `Vendor ${index} advisory: CVE-2026-${10000 + index}`;
    const link = `https://vendor${index}.example/advisory?id=${index}&signature=synthetic-private-${index}`;
    const description = fill(`Affected version 13.1; fixed release 14.2. CVE-2026-${10000 + index} requires an authenticated attacker. Apply the vendor patch and review gateway logs. `, 8000);
    const sourceMembers = Array.from({ length: grouped ? 5 : 1 }, (_, member) => ({
      title: `${title} source ${member}`, source: `Publisher ${member}`,
      link: member ? `https://publisher${member}.example/advisory/${index}` : link,
      date: '2026-10-28T10:00:00Z', passage: description,
      evidence: [{ sourceId: `src_${index}_${member}`, revisionId: `rev_${index}_${member}`,
        title, source: `Publisher ${member}`, canonicalUrl: link, passageKind: 'feed-excerpt',
        publishedAt: '2026-10-28T10:00:00Z', retrievedAt: '2026-10-28T11:00:00Z' }],
    }));
    return { title, source: 'Publisher 0', link, date: '2026-10-28T10:00:00Z', description,
      articleBody: fill(`CVE-2026-${10000 + index} has active exploitation. Investigate exposed installations and apply the fixed vendor release after validating applicability. `, 4000),
      sourceMembers };
  });
  const groundingManifest = buildGroundingManifest({ headlines });
  const manifest = buildGenerationManifest({ run: { headlines }, config: {},
    editionContext: { date: '2026-10-28', timezone: 'UTC' }, groundingManifest });
  return { headlines, groundingManifest, manifest };
}
