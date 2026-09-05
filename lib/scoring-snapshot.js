// Allowlisted configuration receipt captured when the collection is scored.
import { getDomainPack, getScoring } from './domain.js';
import { getEffectiveAlertRules } from './scoring.js';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
const implementation = { scoring: createHash('sha256').update(readFileSync(new URL('./scoring.js', import.meta.url))).digest('hex') };
const AXES = ['recency', 'corroboration', 'exploitation', 'severity', 'relevance'];
const number = value => Number.isFinite(value) ? value : null;
const numbers = (value, keys) => Object.fromEntries(keys.map(key => [key, number(value?.[key])]));
function text(value, max = 8192) {
  if (typeof value !== 'string') return '';
  if (value.length > max) throw new Error('Scoring snapshot field exceeds its retention limit');
  return value.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]');
}
function list(value, mapper = item => text(item, 512), max = 100) {
  if (!Array.isArray(value)) return [];
  if (value.length > max) throw new Error('Scoring snapshot list exceeds its retention limit');
  return value.map(mapper);
}

/** Capture at collection time; later Settings changes must not relabel a run. */
export function snapshotScoringConfiguration(config) {
  const s = config?.analysisSettings || {};
  const scoring = getScoring();
  const domain = getDomainPack();
  return {
    schemaVersion: 1,
    implementationSha256: implementation.scoring,
    axisWeights: numbers({ recency: 0.22, corroboration: 0.18, exploitation: 0.28, severity: 0.16, relevance: 0.16, ...s.scoring?.axisWeights }, AXES),
    recencyHalfLifeHours: s.scoring?.recencyHalfLifeHours || 30,
    horizonWeights: numbers({ horizon1: 0.45, horizon2: 0.4, horizon3: 0.15, ...s.horizonWeights }, ['horizon1', 'horizon2', 'horizon3']),
    freshnessHours: number(s.freshnessHours ?? 48),
    alertRules: list(getEffectiveAlertRules(config), rule => ({ pattern: text(rule.pattern, 2048), boost: number(rule.boost) }), 250),
    domain: {
      id: text(domain?.id, 128),
      urgencyLexicon: Object.fromEntries(['critical', 'elevated', 'horizon1Promote'].map(key => [key, list(domain?.urgencyLexicon?.[key], item => text(item, 2048), 250)])),
      exploitation: numbers({ verified: 1, critical: 0.85, elevated: 0.45, epss: 0.9, ...scoring.exploitation }, ['verified', 'critical', 'elevated', 'epss']),
      severity: {
        dataProperty: text(scoring.severity?.dataProperty, 128),
        pattern: text(scoring.severity?.pattern, 2048), max: number(scoring.severity?.max),
        bands: numbers(scoring.severity?.bands, ['critical', 'high', 'medium', 'low']),
      },
    },
  };
}
