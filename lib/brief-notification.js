import { parseJudgments } from './brief-schema.js';

// Share the current copy's publication consequences with both generation and
// saved-draft delivery. Editorial notes stay in the linked edition record.
export function briefNotificationFields(content, config = {}, presentation = {}) {
  return {
    judgments: parseJudgments(content).map(story => ({ title: story.title,
      tier: [1, 2, 3].includes(story.horizon)
        ? config.horizons?.[String(story.horizon)]?.name || `Tier ${story.horizon}` : null,
      confidence: story.confidence || null })),
    warnings: [...new Set((presentation.currentChecks?.issues || [])
      .filter(issue => ['block', 'review'].includes(issue.consequence))
      .map(issue => `${issue.acknowledged ? 'Reviewed exception: ' : ''}${issue.message}`))],
  };
}
