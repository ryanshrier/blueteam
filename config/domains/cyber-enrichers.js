// ── The CYBER edition's enricher registry ──
//
// The intelligence pipeline no longer calls KEV / CVE / MITRE / entity tagging by
// name; it iterates the ACTIVE pack's enricher list, by stage. This module is the
// cyber pack's list: an ordered set of {name, stage, fn, ...} descriptors wiring
// the (still-in-lib) enricher implementations. A new edition ships its OWN list
// (its own catalogs/taxonomies) and the pipeline runs it unchanged.
//
// Why a separate module from cyber.js: cyber.js is pure, serializable DATA (it
// imports nothing and is Zod-validated); these descriptors carry FUNCTION
// references and Node-only deps, so they live here and are attached to the pack
// as a runtime (non-validated) field — see lib/domain.js.
//
// Contract — each enricher MUTATES the headline objects in place and never throws
// fatally (a failure is caught + logged; `failureKey` records it so the brief can
// hedge). The enricher → scorer interface is the headline properties they set:
//   kev      → h.isKEV, h.kevCVE                    (pre-score: shapes the exploitation axis)
//   entities → h.actors, h.vendors                  (pre-score: relevance + landscape panels)
//   mitre    → h.mitre                               (post-score, after article extraction)
//   cve      → h.cveData, h.cveDetails, h.cvssScore,
//              h.cvssSeverityText                    (post-score: severity axis, re-scored)
//   epss     → h.epss, h.epssCVE                     (post-score: supplementary exploitation-likelihood signal)
//   article  → h.articleBody                         (post-score: brief context + IOC extraction input)
//   iocs     → h.iocs (heuristic, unverified)         (post-score: Wire/CSV indicator export)
//
// `stage`: 'pre' runs on the full deduped set BEFORE scoring (so KEV/entities
// shape selection); 'post' runs on the diversified survivors AFTER the first
// score (including article-aware MITRE tagging), followed by a re-score.
// `limitKey`/`limitDefault` resolve a per-enricher budget from analysisSettings.

import { enrichKEV, tagEntities, enrichCVEs, enrichEPSS, enrichArticleBodies, enrichIOCs } from '../../lib/enrichment.js';
import { tagMitre } from '../../lib/mitre.js';

export const cyberEnrichers = [
  { name: 'kev', stage: 'pre', fn: enrichKEV, failureKey: 'KEV' },
  { name: 'entities', stage: 'pre', fn: tagEntities },
  { name: 'cve', stage: 'post', fn: enrichCVEs, failureKey: 'CVE', limitKey: 'maxCVEEnrichments', limitDefault: 8 },
  // Runs after 'cve' (reuses the CVE ids it already extracted — see enrichEPSS
  // in lib/enrichment.js) and before 'article', which is unrelated. No
  // failureKey: EPSS is a supplementary refinement of the exploitation axis,
  // not a primary input (KEV + urgency lexicon still carry it on their own),
  // so a failed EPSS fetch degrades silently rather than flagging the brief.
  { name: 'epss', stage: 'post', fn: enrichEPSS, limitKey: 'maxEPSSLookups', limitDefault: 20 },
  { name: 'article', stage: 'post', fn: enrichArticleBodies, failureKey: 'article', limitKey: 'maxArticleExtractions', limitDefault: 10 },
  // Article bodies carry technique detail that is often absent from headlines.
  // Run the pure MITRE matcher after extraction, before the IOC consumer.
  { name: 'mitre', stage: 'post', fn: tagMitre },
  // Runs LAST — reads h.articleBody, which only exists after 'article' has run.
  // No failureKey: enrichIOCs never performs I/O (pure regex over already-
  // fetched text) and never throws; a heuristic-extraction miss is not a
  // pipeline failure worth flagging to the brief.
  { name: 'iocs', stage: 'post', fn: enrichIOCs },
];
