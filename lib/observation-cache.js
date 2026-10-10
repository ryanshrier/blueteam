// Process-local observations have both an age and a memory budget. Expiry uses
// the capture clock, never the last access, so reuse cannot renew evidence.
export function createObservationCache({ ttlMs, maxEntries = 512, maxBytes = 16 * 1024 * 1024, now = Date.now }) {
  const entries = new Map();
  let bytes = 0;
  const remove = key => {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key); bytes -= entry.bytes; return true;
  };
  const expired = entry => !Number.isFinite(entry.value.cachedAt)
    || entry.value.cachedAt > now() || now() - entry.value.cachedAt >= ttlMs;
  return {
    get size() { return entries.size; },
    get byteLength() { return bytes; },
    delete: remove,
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (expired(entry)) { remove(key); return undefined; }
      entries.delete(key); entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      for (const [id, entry] of entries) if (expired(entry)) remove(id);
      remove(key);
      // Serialized UTF-16 size is a conservative data budget; the entry count
      // additionally bounds object/Map overhead and tiny scalar observations.
      const entry = { value, bytes: (String(key).length + JSON.stringify(value).length) * 2 };
      if (expired(entry) || entry.bytes > maxBytes) return;
      entries.set(key, entry); bytes += entry.bytes;
      while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
    },
  };
}
