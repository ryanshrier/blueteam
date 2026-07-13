import { describe, test, expect } from '@jest/globals';
import { tagMitre } from '../lib/mitre.js';

// MITRE technique patterns matched vendor names and unanchored
// substrings, tagging routine vendor news / policy prose as observed ATT&CK
// activity on the wall's heatmap (which is presented as technique frequency,
// not news volume). These guard the negative fixtures the finding names.

describe('tagMitre — vendor-name false positives', () => {
  test('a Citrix earnings headline does not tag T1133', () => {
    const hs = [{ title: 'Citrix reports Q2 earnings', description: 'Revenue up 8% year over year.' }];
    tagMitre(hs);
    expect((hs[0].mitre || []).map(t => t.id)).not.toContain('T1133');
  });

  test('a Citrix RDP vulnerability headline still tags T1133', () => {
    const hs = [{ title: 'Citrix RDP flaw allows remote access', description: '' }];
    tagMitre(hs);
    expect((hs[0].mitre || []).map(t => t.id)).toContain('T1133');
  });

  test('a macroeconomic policy headline does not tag T1059', () => {
    const hs = [{ title: 'The macroeconomic outlook for cyber insurance markets', description: '' }];
    tagMitre(hs);
    expect((hs[0].mitre || []).map(t => t.id)).not.toContain('T1059');
  });

  test('a malicious-macro headline still tags T1059', () => {
    const hs = [{ title: 'Malicious macro in invoice document drops payload', description: '' }];
    tagMitre(hs);
    expect((hs[0].mitre || []).map(t => t.id)).toContain('T1059');
  });

  test('a generic privilege-escalation flaw does not claim T1098 Account Manipulation', () => {
    const hs = [{ title: 'Kernel flaw enables local privilege escalation', description: '' }];
    tagMitre(hs);
    expect((hs[0].mitre || []).map(t => t.id)).not.toContain('T1098');
  });

  test('explicit administrator-account creation still tags T1098', () => {
    const hs = [{ title: 'Malware creates a hidden administrator account for persistence', description: '' }];
    tagMitre(hs);
    expect((hs[0].mitre || []).map(t => t.id)).toContain('T1098');
  });
});

describe('tagMitre — extracted article context', () => {
  test('tags a technique found only in the extracted article body', () => {
    const hs = [{
      title: 'Researchers detail a newly observed intrusion',
      description: 'The report covers post-compromise activity.',
      articleBody: 'Investigators observed Mimikatz dumping credentials from LSASS.',
    }];
    tagMitre(hs);
    expect(hs[0].mitre).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'T1003', name: 'OS Credential Dumping' }),
    ]));
  });
});
