// ── The MACRO edition's enricher list ──
//
// Macro has no KEV/CVE/MITRE — it enriches by entity tagging only (institutions,
// regions, key markets). The pipeline runs this list by stage exactly as it runs
// cyber's, demonstrating the enricher registry is edition-agnostic.

import { tagEntities } from '../../lib/enrichment.js';

export const macroEnrichers = [
  { name: 'entities', stage: 'pre', fn: tagEntities },
];
