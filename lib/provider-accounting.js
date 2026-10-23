// Bounded metadata shared by generation receipts and the durable attempt ledger.
// Never retain an entire provider profile, launch environment, or client object.
export function normalizeProviderCost(value) {
  if (!value || !Number.isFinite(value.amount) || value.amount < 0
    || typeof value.unit !== 'string' || !value.unit.trim() || value.unit.length > 32
    || /[\u0000-\u001f\u007f]|\bsk-[\w-]+/i.test(value.unit)) return null;
  return { amount: value.amount, unit: value.unit.trim() };
}

export function normalizeProfileIdentity(value) {
  if (!value || value.version !== 1 || typeof value.id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id)
    || /\bsk-[\w-]+/i.test(value.id) || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
  return { id: value.id, version: 1, sha256: value.sha256 };
}

export function normalizeProviderContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const profileIdentity = normalizeProfileIdentity(value.profileIdentity);
  return {
    version: Number.isSafeInteger(value.version) && value.version > 0 ? value.version : null,
    capabilities: Object.fromEntries(['systemPrompt', 'conversation', 'outputTokenLimit', 'reasoningEffort', 'cancellation', 'externalTools']
      .map(key => [key, typeof value.capabilities?.[key] === 'boolean' ? value.capabilities[key] : null])),
    ...(profileIdentity ? { profileIdentity } : {}),
  };
}
