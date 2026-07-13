// BlueTeam.News — lightweight MITRE ATT&CK technique tagging.
// Pattern-matches headline text to common enterprise-relevant techniques.
// Not a substitute for full ATT&CK mapping — a glanceable heatmap for the wall.

/** @type {{ id: string, name: string, tactic: string, pattern: RegExp }[]} */
export const MITRE_TECHNIQUES = [
  { id: 'T1566', name: 'Phishing', tactic: 'Initial Access', pattern: /phish|spear.?phish|credential.?harvest|malicious.?email|business.?email.?compromise|\bbec\b/i },
  { id: 'T1190', name: 'Exploit Public-Facing App', tactic: 'Initial Access', pattern: /zero.?day|0.?day|actively.?exploit|remote.?code.?execution|\brce\b|public.?facing|edge.?device|vpn.?flaw|web.?server.?exploit/i },
  { id: 'T1078', name: 'Valid Accounts', tactic: 'Defense Evasion', pattern: /valid.?account|stolen.?credential|credential.?stuff|password.?spray|mfa.?bypass|session.?token|sso.?comprom/i },
  // "macro" was unanchored and matched inside "macroeconomic", tagging policy
  // and economics coverage as T1059 script execution. Anchored
  // to the whole word so "macroeconomic"/"macroeconomics" no longer match while
  // "macro", "macros", "malicious macro", "office macro" still do.
  { id: 'T1059', name: 'Command & Scripting', tactic: 'Execution', pattern: /powershell|cmd\.exe|bash.?script|\bmacros?\b|vbscript|javascript.?payload|living.?off.?the.?land|\blolbin/i },
  { id: 'T1055', name: 'Process Injection', tactic: 'Defense Evasion', pattern: /process.?inject|dll.?inject|shellcode|memory.?inject/i },
  { id: 'T1027', name: 'Obfuscated Files', tactic: 'Defense Evasion', pattern: /obfuscat|packer|encrypted.?payload|polymorphic|steganograph/i },
  { id: 'T1486', name: 'Data Encrypted for Impact', tactic: 'Impact', pattern: /ransomware|encrypt.*files|double.?extort|data.?leak.?site|\bransom\b/i },
  { id: 'T1490', name: 'Inhibit System Recovery', tactic: 'Impact', pattern: /shadow.?copies|backup.?delet|vssadmin|recovery.?inhibit|wipe.?backup/i },
  // "outage"/"downtime" alone tag benign cloud-outage stories as an attack;
  // require an adversarial co-term ("attack"/"cyber") to keep them in.
  { id: 'T1489', name: 'Service Stop', tactic: 'Impact', pattern: /denial.?of.?service|\bddos\b|service.?disrupt|(?:cyber|attack|malware|ransom)[^.]*\b(?:outage|downtime)\b|\b(?:outage|downtime)\b[^.]*(?:cyber|attack|malware|ransom)/i },
  { id: 'T1195', name: 'Supply Chain Compromise', tactic: 'Initial Access', pattern: /supply.?chain|dependency.?confusion|typosquat|malicious.?package|compromised.?update|software.?supply/i },
  // "citrix" dropped: the vendor tagger (lib/enrichment.js) already
  // covers Citrix exposure via entity tagging, and a bare vendor name here
  // false-flags routine Citrix news ("Citrix reports Q2 earnings") as T1133
  // persistence activity in the ATT&CK heatmap, which is presented as observed
  // technique frequency, not news volume.
  { id: 'T1133', name: 'External Remote Services', tactic: 'Persistence', pattern: /remote.?desktop|\brdp\b|vpn.?access|remote.?access.?trojan|\brat\b/i },
  { id: 'T1021', name: 'Remote Services', tactic: 'Lateral Movement', pattern: /lateral.?movement|smb.?exploit|winrm|psexec|rdp.?lateral/i },
  { id: 'T1003', name: 'OS Credential Dumping', tactic: 'Credential Access', pattern: /credential.?dump|lsass|mimikatz|ntds\.dit|hash.?dump|kerberoast/i },
  { id: 'T1110', name: 'Brute Force', tactic: 'Credential Access', pattern: /brute.?force|password.?guess|credential.?spray|login.?attempt/i },
  // "breach notification" alone fires on routine breach-notification-law
  // stories; dropped — the adversarial terms below carry the technique.
  { id: 'T1048', name: 'Exfiltration Over Alt Protocol', tactic: 'Exfiltration', pattern: /exfiltrat|data.?theft|stolen.?data|leaked.?data/i },
  { id: 'T1562', name: 'Impair Defenses', tactic: 'Defense Evasion', pattern: /disable.?av|edr.?bypass|defense.?evasion|security.?tool.?kill|tamper.?protection/i },
  { id: 'T1071', name: 'Application Layer Protocol', tactic: 'Command and Control', pattern: /command.?and.?control|\bc2\b|\bc&c\b|beacon|dns.?tunnel|https.?c2/i },
  // "privilege escalation" is an ATT&CK tactic, not evidence of Account
  // Manipulation. Requiring account/credential language avoids presenting a
  // generic escalation flaw as the specific T1098 technique.
  { id: 'T1098', name: 'Account Manipulation', tactic: 'Persistence', pattern: /account.?creat|admin(?:istrator)?[ -]?account|golden.?ticket|silver.?ticket/i },
  { id: 'T1219', name: 'Remote Access Software', tactic: 'Command and Control', pattern: /anydesk|teamviewer|screenconnect|remote.?monitoring.?tool|\brmm\b/i },
  { id: 'T1598', name: 'Phishing for Information', tactic: 'Reconnaissance', pattern: /reconnaissance|osint.?campaign|information.?gather|pretexting/i },
  { id: 'T1595', name: 'Active Scanning', tactic: 'Reconnaissance', pattern: /port.?scan|vulnerability.?scan|network.?scan|probing/i },
  { id: 'T1530', name: 'Data from Cloud Storage', tactic: 'Collection', pattern: /cloud.?storage.?leak|s3.?bucket|blob.?expos|misconfigur.*cloud|public.?bucket/i },
  { id: 'T1557', name: 'Adversary-in-the-Middle', tactic: 'Credential Access', pattern: /man.?in.?the.?middle|\bmitm\b|ssl.?strip|adversary.?middle/i },
  { id: 'T1204', name: 'User Execution', tactic: 'Execution', pattern: /malicious.?link|drive.?by|user.?click|social.?engineer/i },
];

/**
 * Tag headlines with MITRE ATT&CK techniques mentioned in title/description.
 * Returns technique id list on each headline; also usable for heatmap aggregation.
 */
export function tagMitre(headlines) {
  for (const h of headlines) {
    const text = `${h.title} ${h.description || ''} ${h.articleBody || ''}`;
    const techniques = [];
    for (const t of MITRE_TECHNIQUES) {
      if (t.pattern.test(text)) {
        techniques.push({ id: t.id, name: t.name, tactic: t.tactic });
      }
    }
    if (techniques.length > 0) h.mitre = techniques.slice(0, 4);
  }
}

/** Aggregate technique frequency across headlines for the wall heatmap. */
export function buildMitreHeatmap(headlines, limit = 8) {
  const counts = new Map();
  for (const h of headlines) {
    for (const t of h.mitre || []) {
      const entry = counts.get(t.id) || { id: t.id, name: t.name, tactic: t.tactic, count: 0 };
      entry.count++;
      counts.set(t.id, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
