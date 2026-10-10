// Publication readiness is distinct from process liveness and external delivery.
// These fields describe the enabled schedule; they never send or replay a webhook.
export function scheduledBriefDelivery(schedule, { now = Date.now(), overdueGraceMs = 5 * 60_000 } = {}) {
  if (!schedule || typeof schedule.enabled !== 'boolean') return { status: 'unknown', needsAttention: false, reason: 'Scheduled briefing status is unavailable.' };
  let status = 'scheduled';
  if (!schedule.enabled) status = 'disabled';
  else if (schedule.outcome === 'awaiting-review') status = 'awaiting-review';
  else if (schedule.outcome === 'running') status = 'running';
  else if (schedule.outcome === 'success') status = 'published';
  else if (schedule.outcome === 'reconcile-pending') status = 'reconciliation-pending';
  else if (['failed', 'attempt-limit', 'ledger-error', 'waiting-for-key'].includes(schedule.outcome)) status = 'failed';
  else if (schedule.outcome === 'skipped' || (Number.isFinite(Date.parse(schedule.nextAttemptAt || ''))
      && Date.parse(schedule.nextAttemptAt) + overdueGraceMs < now)) status = 'missed';
  const reason = {
    disabled: 'Automatic briefing generation is disabled.',
    scheduled: 'The next automatic briefing attempt is scheduled.',
    running: 'The scheduled briefing is being generated.',
    published: 'The scheduled briefing was published. External notification delivery is not established by this status.',
    'awaiting-review': 'The scheduled briefing is saved as a draft and needs review before publication.',
    failed: 'The scheduled briefing has not been published after a failed or blocked attempt. Inspect generation status and the configured next attempt.',
    missed: 'The scheduled briefing was skipped or its next attempt is overdue.',
    'reconciliation-pending': 'Publication needs scheduler-state reconciliation. Inspect the saved edition before requesting another generation.',
  }[status];
  return { status, needsAttention: ['awaiting-review', 'failed', 'missed', 'reconciliation-pending'].includes(status), reason,
    editionDate: schedule.scheduleDate || null, nextAttemptAt: schedule.nextAttemptAt || null,
    lastSuccessAt: schedule.lastSuccessAt || null, lastSuccessDate: schedule.lastSuccessDate || null,
    draftAvailable: Boolean(schedule.draftId), attempts: Number.isSafeInteger(schedule.attempts) ? schedule.attempts : 0 };
}
