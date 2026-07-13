// ── The CYBER Domain Pack — the first edition of the BlueTeam.News pipeline ──
//
// Everything CTI-profile-specific lives HERE, not welded into the engine: the entity
// taxonomy (threat actors / vendors / regions), the urgency lexicon that drives
// the score's exploitation axis and tier promotion, and the edition identity. A
// profile can specialize the desk for enterprise, OT/ICS, cloud and identity,
// ransomware, or a sector without touching engine code. Core modules read it via
// lib/domain.js.
//
// This is a plain data module — no logic, no deps — so it imports unchanged on
// the server and stays trivially diff-able / authorable per edition.

export const cyberPack = {
  id: 'cyber',
  label: 'BlueTeam.News',

  // Named entities the enricher tags in headlines (word-boundary, case-insensitive).
  // `actors` carry a region for attribution; `vendors` are load-bearing enterprise
  // platforms; `regions` map an actor's region code to a display label.
  entities: {
    // Aliases are filled from vendor cross-naming tables (Microsoft/CrowdStrike/
    // Mandiant/Google) so a week of reporting under one vendor's name for a group
    // still registers against the actor leaderboard and region-attribution panels
    // — a report that only ever says "Seashell Blizzard" previously
    // counted as zero Sandworm activity. `Storm-\d{4}` and `UNC\d{3,5}` are
    // Microsoft's / Mandiant's INTERIM designators for clusters not yet named to
    // a tracked group — they dominate early reporting before attribution lands,
    // so they're carried as generic pattern actors with region 'unattributed'
    // rather than omitted. CONTRIBUTING.md documents this as a maintained file.
    actors: [
      { name: 'APT28', aliases: ['Fancy Bear', 'Forest Blizzard', 'Sofacy', 'Pawn Storm', 'STRONTIUM'], region: 'RU' },
      { name: 'APT29', aliases: ['Cozy Bear', 'Midnight Blizzard', 'NOBELIUM'], region: 'RU' },
      { name: 'Sandworm', aliases: ['APT44', 'Seashell Blizzard', 'Voodoo Bear'], region: 'RU' },
      { name: 'Turla', aliases: ['Secret Blizzard', 'Snake', 'Uroburos'], region: 'RU' },
      { name: 'Star Blizzard', aliases: ['Callisto Group', 'SEABORGIUM'], region: 'RU' },
      { name: 'Lazarus', aliases: ['Lazarus Group', 'APT38', 'Hidden Cobra', 'Diamond Sleet'], region: 'KP' },
      { name: 'Kimsuky', aliases: ['Emerald Sleet', 'Velvet Chollima'], region: 'KP' },
      { name: 'Volt Typhoon', aliases: ['Vanguard Panda', 'Bronze Silhouette'], region: 'CN' },
      { name: 'Salt Typhoon', aliases: ['GhostEmperor', 'FamousSparrow'], region: 'CN' },
      { name: 'Flax Typhoon', aliases: ['Ethereal Panda'], region: 'CN' },
      { name: 'APT41', aliases: ['Winnti', 'Brass Typhoon', 'Barium', 'Double Dragon'], region: 'CN' },
      { name: 'APT31', aliases: ['Judgment Panda', 'Zirconium'], region: 'CN' },
      { name: 'APT40', aliases: ['Leviathan', 'Kryptonite Panda', 'Gingham Typhoon'], region: 'CN' },
      { name: 'Mustang Panda', aliases: ['Bronze President', 'Stately Taurus'], region: 'CN' },
      { name: 'Earth Lusca', aliases: [], region: 'CN' },
      { name: 'UNC3886', aliases: [], region: 'CN' },
      { name: 'Charming Kitten', aliases: ['APT35', 'Mint Sandstorm', 'Phosphorus'], region: 'IR' },
      { name: 'APT33', aliases: ['Peach Sandstorm', 'Elfin'], region: 'IR' },
      { name: 'APT34', aliases: ['OilRig', 'Earth Simnavaz', 'Hazel Sandstorm'], region: 'IR' },
      { name: 'MuddyWater', aliases: ['Mango Sandstorm', 'Static Kitten'], region: 'IR' },
      { name: 'LockBit', aliases: [], region: 'crime' },
      { name: 'BlackCat', aliases: ['ALPHV'], region: 'crime' },
      { name: 'Cl0p', aliases: ['Clop'], region: 'crime' },
      { name: 'BlackBasta', aliases: ['Black Basta'], region: 'crime' },
      { name: 'RansomHub', aliases: [], region: 'crime' },
      { name: 'Scattered Spider', aliases: ['UNC3944', 'Octo Tempest', 'Muddled Libra', 'Star Fraud'], region: 'crime' },
      { name: 'LAPSUS$', aliases: [], region: 'crime' },
      { name: 'FIN7', aliases: ['Sangria Tempest', 'Carbon Spider'], region: 'crime' },
      { name: 'TA505', aliases: [], region: 'crime' },
      { name: 'Akira', aliases: [], region: 'crime' },
      { name: 'Qilin', aliases: ['Agenda'], region: 'crime' },
      { name: 'Play', aliases: ['PlayCrypt'], region: 'crime' },
      { name: 'Medusa', aliases: ['MedusaLocker'], region: 'crime' },
      { name: 'INC Ransom', aliases: ['INC Ransomware'], region: 'crime' },
      { name: 'DragonForce', aliases: [], region: 'crime' },
      { name: 'Hunters International', aliases: [], region: 'crime' },
      { name: '8Base', aliases: [], region: 'crime' },
      { name: 'Rhysida', aliases: [], region: 'crime' },
      // Known caveat: matched via lib/enrichment.js's `\d`-detection convention
      // (see PATTERN_ACTOR_SHAPE), so the leaderboard label reads the literal
      // family name ("Storm-\d{4}"), not the specific cluster matched ("Storm-1234")
      // — good enough to register the family's activity; a follow-up could thread
      // the actual regex capture through to the display label.
      { name: 'Storm-\\d{4}', aliases: [], region: 'unattributed' },
      { name: 'UNC\\d{3,5}', aliases: [], region: 'unattributed' },
    ],
    regions: {
      RU: 'Russia-attributed',
      CN: 'China-attributed',
      KP: 'DPRK-attributed',
      IR: 'Iran-attributed',
      crime: 'Criminal ecosystem',
      unattributed: 'Unattributed (interim designator)',
    },
    // Vendors whose bare name is also an ordinary English word ("Progress",
    // "Elastic") are NOT listed as that bare word: compileEntityRegex
    // (lib/enrichment.js) is case-INSENSITIVE, so a bare "Progress" matches
    // routine prose like "CISA reports progress on secure-by-design" and tags
    // it as a Progress Software mention. Listed instead by their
    // unambiguous product/company name — "MOVEit" (Progress's own product) is
    // already covered separately, so "Progress Software" catches the rest.
    vendors: [
      'Microsoft', 'Google', 'Amazon', 'AWS', 'Apple', 'Cisco', 'Oracle', 'SAP', 'IBM',
      'CrowdStrike', 'Palo Alto Networks', 'Fortinet', 'Ivanti', 'Citrix', 'VMware',
      'SentinelOne', 'Okta', 'Cloudflare', 'Zscaler', 'Splunk', 'Elasticsearch', 'Elastic Security', 'Datadog',
      'GitHub', 'GitLab', 'Atlassian', 'Salesforce', 'ServiceNow', 'Snowflake',
      'OpenAI', 'Anthropic', 'Nvidia', 'Broadcom', 'Juniper', 'F5', 'SonicWall',
      'Veeam', 'Progress Software', 'MOVEit', 'WS_FTP', 'Telerik', 'Jenkins', 'Kubernetes', 'Docker',
    ],
  },

  // Scoring inputs — the two edition-coupled axes + the
  // rationale words. The five-axis weighting model lives in lib/scoring.js; this
  // declares what cyber treats as "verified" (CISA KEV) and "severe" (CVSS), and
  // the receipt vocabulary. A new edition swaps its own catalog + severity source.
  scoring: {
    exploitation: { verified: 1, critical: 0.85, elevated: 0.45 },
    severity: {
      // cvssSeverityText (lib/enrichment.js) — NOT cveData — is the severity
      // axis's parse source. cveData is a display string that can join several
      // CVEs and, historically, sat a version label between "CVSS" and the
      // score; either shape corrupts a naive re-parse. cvssSeverityText
      // carries exactly one number: the MAX CVSS score across this headline's
      // CVEs, with no version label in front of it.
      dataProperty: 'cvssSeverityText',
      pattern: 'CVSS\\s+([\\d.]+)',
      max: 10,
      bands: { critical: 1, high: 0.75, medium: 0.5, low: 0.25 },
    },
    rationale: { verified: 'KEV-verified', critical: 'active exploitation', elevated: 'elevated threat activity', severityLabel: 'CVSS' },
  },

  // The edition-specific landscape panels cyber surfaces — the
  // KEV activity board, threat-actor leaderboard, region attribution, MITRE heatmap,
  // and vendor exposure. A non-cyber edition omits these (and declares its own).
  panels: ['kev', 'actors', 'regions', 'mitre', 'vendors'],

  // The news-search sweep queries — a secondary discovery channel
  // source on top of the trusted RSS feeds. Each is one pressing cyber angle; a
  // new edition declares its OWN queries and the pipeline runs them unchanged.
  // Org watch-topics from config are still appended at runtime (see feeds.js).
  feeds: {
    searchQueries: [
      { q: 'critical vulnerability CVE exploited', horizon: 1 },
      { q: 'ransomware attack confirmed', horizon: 1 },
      { q: 'CISA emergency directive', horizon: 1 },
      { q: 'cybersecurity regulation SEC NIST CISA', horizon: 2 },
      { q: 'AI agent security vulnerability', horizon: 2 },
      { q: 'state sponsored cyber espionage campaign', horizon: 3 },
    ],
  },

  // The urgency lexicon — regex source strings (compiled once in lib/domain.js).
  // `critical` = active, weaponized, in-the-wild EVIDENCE (the top of the score's
  // exploitation axis, and the source of the "active exploitation" rationale
  // word — see scoring.rationale.critical below). Pure severity/announcement
  // language ('critical vuln', 'RCE', 'emergency patch') is NOT activity evidence
  // — a routine "critical vulnerability patched" headline has no exploitation
  // happening — so those terms live in `elevated` instead, one notch down the
  // exploitation axis, not conflated with a KEV-verified or actively-exploited hit.
  // `elevated` = developing threats / notable severity language, not yet active.
  // `horizon1Promote` = patterns that pull a headline to Tier 1 regardless of which
  // feed carried it; coupled to activity so strategic essays that merely
  // mention "ransomware" or carry a bare CVE number don't jump the SOC queue.
  urgencyLexicon: {
    critical: [
      'zero.?day', 'active.?exploit', 'actively.?exploit', 'exploited.?in.?the.?wild',
      'emergency.?directive', 'breach.?confirm',
    ],
    elevated: [
      'critical.?vuln', 'rce\\b', 'remote.?code.?exec', 'emergency.?patch',
      'proposed.?rule', 'indictment', 'ransomware',
      'malware', 'apt\\d', 'threat.?actor', 'data.?leak', 'patch.?tuesday', 'phishing.?campaign',
    ],
    horizon1Promote: [
      'CVE-\\d{4}.*(exploit|attack|in.?the.?wild)', 'zero.?day', 'active.?exploit',
      'breach.?confirm', 'ransomware.?(attack|hits|claims|deployed)', 'rce\\b',
      'emergency.?patch', 'critical.?vuln', 'data.?leak.*confirm',
    ],
  },

  // The brief's edition voice + frame. The section grammar is
  // the engine's (prompts.js); these strings are the cyber DICTIONARY — verbatim
  // what the cyber briefer has always said, now declared by the pack so a second
  // edition swaps its own voice without touching prompt code. `frame.subtitle` is
  // the dateline anchor the validator reads back, so emit and audit can't drift.
  brief: {
    frame: {
      title: 'BlueTeam.News',
      subtitle: 'Threat Landscape Briefing',
    },
    persona: {
      system: 'You are the daily threat landscape briefer for a cyber defense team. You produce a decision-support document modeled on the discipline of a national-level intelligence brief, written for working defenders.',
      voiceStandard: 'if a blue-team lead reads only the BLUF and one signal, they should still run a better shift today than they would have without it.',
      exampleAudience: 'A cyber defense team at a large enterprise: tier 1–3 analysts, threat intelligence, detection engineering, and security leadership.',
      analystSpecifics: 'CVE numbers, affected products, detection opportunities, concrete next actions',
    },
    tierModelNote: 'the CTI pyramid of who consumes the intelligence and on what horizon',
    horizons: {
      1: {
        roles: 'SOC, incident response, detection engineering',
        signalTypes: 'active exploitation, zero-days with enterprise exposure, KEV additions, confirmed breaches, emergency directives, detection gaps.',
        question: 'What demands attention before the next shift change?',
      },
      2: {
        roles: 'threat hunters, intel analysts, security engineering',
        signalTypes: 'regulatory shifts, vendor ecosystem changes (M&A, EOL, breaches at vendors), threat-actor capability shifts, insurance and disclosure dynamics — plus emerging threat and defensive capabilities: AI/agentic attack and defense, novel techniques moving from research to crimeware, cloud and identity attack-surface evolution, and tooling shifts.',
        question: 'What developing threat activity, capability, exposure, or policy change requires a defensive adjustment over the coming weeks or months?',
      },
      3: {
        roles: 'directors, CISO, board',
        signalTypes: 'geopolitical cyber dynamics, technology-policy development, structural shifts in the criminal ecosystem, and long-arc capability trends.',
        question: 'What structural change will materially alter the threat environment, defensive model, or risk posture?',
      },
    },
    filters: {
      hardExclude: [
        'Consumer tech, app launches, product reviews',
        'Vendor marketing dressed as research, thought-leadership fluff',
        'Political noise without structural regulatory or threat implication',
        'Hype (AI doom or AI magic) without a specific technical or policy consequence',
        "Anything that would not appear in a serious CISO's morning read",
      ],
    },
    fields: {
      impactLabel: 'Defender impact',
      impactInstruction: 'What this means for a working cyber defense team. Name the affected control, log source, or process.',
    },
    exemplars: {
      bluf: 'Not "CISA released guidance" but "Enterprise defenders face X because Y changed."',
      actNow: 'Pull Salesforce Connected Apps audit logs and flag OAuth grants tied to Klue.',
      convergence: 'A single stolen OAuth token cascaded from Klue into LastPass — the live edge of a structural blind spot: SaaS-to-SaaS grants are trusted once at setup and never re-verified.',
      watchlist: '"CISA adds CVE-XXXX-XXXXX to KEV" not "the situation develops."',
      tierMigration: 'Flagged at Tier 2 last week; CISA advisory moves this to Tier 1.',
      execAvoid: 'no unsupported certainty, no implementation jargon, no repeated analysis',
      execRows: 'Threat / Exposure / Required decisions',
      actionOwners: 'the accountable function, such as infrastructure / application security / messaging / detection engineering / leadership',
      actionFormat: 'Infrastructure — verify every affected appliance — recommended target {Month D, YYYY}',
      priorityLanguage: 'Act now / Prepare / Monitor',
      actionCatalogNote: 'If the relevant judgment carries a verified KEV CVE (see below), name that exact CVE in the this-shift action.',
      absentSpecific: '"no CVE assigned yet"',
      whatHappenedSpecifics: 'names, versions, CVE numbers, dates, dollar figures',
      numberExamples: 'versions, CVE IDs, dates, and counts',
    },
    grounding: {
      specifics: 'Every CVE ID, CVSS score, version number, date, count, dollar figure, and named actor',
      systemFactsNote: 'the KEV count',
      verifiedCatalog: 'KEV is verified, not inferred. When a headline is flagged "⚠ CISA KEV: CVE-XXXX-XXXXX", that CVE\'s KEV membership is confirmed against the catalog — cite that exact CVE verbatim in the relevant judgment (in "What happened" and, where it drives the action, the this-shift action). Do not paraphrase, drop, or substitute it, and never label a different CVE as KEV when the verified one was provided.',
      sourceFreshness: 'A source establishes status only on its publication or update date. Date-box patch, exploitation, victim-count, and availability claims unless a current source explicitly carries them through the briefing date.',
      certaintyLanguage: 'Words such as "confirmed," "first," "fully autonomous," and "no fix" must match the cited evidence and confidence band; a single vendor claim without independent validation must be attributed as a report or assessment.',
      deadlineScopeInstruction: 'Put external deadlines here with their authority and scope. A CISA KEV due date must read, for example, "CISA FCEB remediation due July 16, 2026"; it is not automatically this organization\'s target. Preserve the source\'s precision: a date-only deadline never gains a clock time or timezone.',
    },
    dayModes: {
      monday: 'Cover what accumulated over the weekend and set the operational posture for the week.\nEvery Horizon 1 signal should answer: "What does the day shift need to do before noon?"',
      friday: "Two purposes: (1) flag anything that needs weekend monitoring with specific watch criteria,\n(2) synthesize the week's pattern in one short WEEK IN REVIEW paragraph before the Key Judgments.\nThe team should leave Friday knowing exactly what would page them.",
      weekend: 'Reduced staffing posture. Limit Tactical coverage to active exploitation, confirmed incidents, emergency directives, and infrastructure-level events. Use remaining space for material Operational and Strategic developments, without lowering the evidence threshold.',
    },
  },
};
