// Test-only non-CTI profile used to prove the internal profile seam remains generic.
//
// This pack exists to prove North-star test #1: a non-cyber edition stands up by
// CONFIGURATION ALONE — its own voice, entities, lexicon, scoring, feeds, panels —
// touching zero engine code. It is a realistic-but-lean macro/geopolitical edition
// (an investment committee's daily risk note), not a shipping product. If swapping
// to it produces a coherent brief + scored surfaces with no cyber language and no
// core edits, the engine is general. See test/second-edition.test.js.

export const macroPack = {
  id: 'macro',
  label: 'Macro Risk',

  entities: {
    actors: [
      { name: 'Federal Reserve', aliases: ['the Fed', 'FOMC'], region: 'US' },
      { name: 'ECB', aliases: ['European Central Bank'], region: 'EU' },
      { name: 'PBOC', aliases: ["People's Bank of China"], region: 'CN' },
      { name: 'Bank of Japan', aliases: ['BOJ'], region: 'JP' },
      { name: 'OPEC', aliases: ['OPEC+'], region: 'GULF' },
      { name: 'IMF', aliases: ['International Monetary Fund'], region: 'GLOBAL' },
    ],
    regions: { US: 'United States', EU: 'Eurozone', CN: 'China', JP: 'Japan', GULF: 'Gulf states', GLOBAL: 'Multilateral' },
    vendors: ['Treasuries', 'Bunds', 'JGBs', 'Brent', 'WTI', 'Gold', 'S&P 500', 'DXY'],
  },

  urgencyLexicon: {
    critical: ['rate.?cut', 'emergency.?meeting', 'sovereign.?default', 'devaluation', 'circuit.?breaker', 'intervention'],
    elevated: ['inflation', 'recession', 'tariff', 'sanction', 'downgrade', 'yield.?curve', 'liquidity'],
    horizon1Promote: ['rate.?decision', '\\bcpi\\b', 'nonfarm', 'fomc', 'sovereign.?default', 'devaluation'],
  },

  brief: {
    frame: { title: 'Macro Risk', subtitle: 'Global Macro Briefing' },
    persona: {
      system: 'You are the daily macro-risk briefer for an investment committee. You produce a decision-support document modeled on the discipline of a central-bank policy note, written for allocators and risk officers.',
      voiceStandard: 'if a portfolio manager reads only the BLUF and one signal, they should still position better today than they would have without it.',
      exampleAudience: 'An investment committee: macro strategists, risk officers, and the CIO.',
      analystSpecifics: 'index levels, yields, spreads, and concrete positioning implications',
    },
    tierModelNote: 'the horizon pyramid of who acts on the signal and over what window',
    horizons: {
      1: { roles: 'traders, risk officers', signalTypes: 'rate decisions, data surprises, liquidity events, intervention.', question: 'What moves the book before the next session?' },
      2: { roles: 'strategists, allocators', signalTypes: 'policy-path shifts, regime changes, cross-asset dislocations forming over the quarter.', question: 'What changes our allocation or hedges this quarter?' },
      3: { roles: 'the CIO and board', signalTypes: 'structural regime shifts — debt sustainability, de-dollarization, demographic and energy transitions.', question: 'What structural shift defines the regime we invest in next?' },
    },
    filters: {
      hardExclude: [
        'Single-stock noise without macro read-through',
        'Pundit price targets and chart astrology',
        'Politics without a policy or market consequence',
        "Anything that wouldn't change a serious allocator's positioning",
      ],
    },
    fields: { impactLabel: 'Portfolio impact', impactInstruction: 'What this means for positioning. Name the affected asset class, factor, or hedge.' },
    exemplars: {
      bluf: 'Not "the Fed met" but "Allocators face X because the policy path shifted."',
      actNow: 'Trim duration into the auction and re-check the hedge ratio.',
      convergence: 'A widening swap basis met thinning dealer balance sheets — the live edge of a structural funding fragility that resurfaces at every quarter-end.',
      watchlist: '"CPI prints above 3.5% on Thursday" not "inflation remains a concern."',
      tierMigration: 'Flagged at Horizon 2 last week; the surprise print moves it to Horizon 1.',
      execAvoid: 'no tickers, no desk jargon',
      actionOwners: 'trader / strategist / CIO',
      actionCatalogNote: '',
      absentSpecific: '"level not yet confirmed"',
      whatHappenedSpecifics: 'levels, yields, spreads, dates, sizes',
      numberExamples: 'levels, yields, dates, and sizes',
    },
    grounding: {
      specifics: 'Every index level, yield, spread, date, and size',
      systemFactsNote: 'the computed level counts',
      verifiedCatalog: 'Official-rate decisions are verified, not inferred. When a headline is flagged as a confirmed central-bank decision, cite the exact rate and date verbatim and never substitute an unconfirmed market expectation.',
    },
    dayModes: {
      monday: "Set the week's macro calendar and the positioning into the key prints.",
      friday: "Flag weekend event risk (elections, OPEC, summits) and synthesize the week's regime read in one paragraph before the Key Judgments.",
      weekend: 'Markets closed — cover event risk and the structural reads; expand the longer-horizon analysis.',
    },
  },

  scoring: {
    exploitation: { verified: 1, critical: 0.85, elevated: 0.45 },
    severity: { dataProperty: 'riskData', pattern: 'impact\\s+([\\d.]+)', max: 5, bands: { severe: 1, high: 0.75, moderate: 0.5, low: 0.25 } },
    rationale: { verified: 'decision-confirmed', critical: 'market-moving', elevated: 'developing', severityLabel: 'impact' },
  },

  feeds: {
    sources: [
      { source: 'Fed Press', url: 'https://www.federalreserve.gov/feeds/press_all.xml', category: 'policy', horizon: 1, weight: 1.4 },
      { source: 'ECB Press', url: 'https://www.ecb.europa.eu/rss/press.html', category: 'policy', horizon: 1, weight: 1.3 },
      { source: 'IMF Blog', url: 'https://www.imf.org/en/Blogs/rss', category: 'analysis', horizon: 3, weight: 1.0 },
    ],
    searchQueries: [
      { q: 'central bank rate decision', horizon: 1 },
      { q: 'inflation CPI surprise', horizon: 1 },
      { q: 'sovereign debt sustainability', horizon: 3 },
    ],
  },

  // A macro edition surfaces institutions + regions, not the cyber KEV/MITRE/vendor panels.
  panels: ['actors', 'regions'],
};
