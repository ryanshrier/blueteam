// Single source of truth for the three CTI tier labels (the Tactical /
// Operational / Strategic pyramid). The data model and CSS stay NUMERIC —
// horizon 1-3 in the wire format, .h1/.h2/.h3 classes — so a relabel touches
// only this file and can never desync the Wall, the Wire, and the filters again.
export const TIER_NAMES = { 1: 'TACTICAL', 2: 'OPERATIONAL', 3: 'STRATEGIC' };

// Tier ids in display order — drives the Wire filter buttons and any per-tier loop.
export const TIERS = [1, 2, 3];
