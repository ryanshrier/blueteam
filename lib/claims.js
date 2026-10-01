// Conservative lexical screening, not semantic verification. Keep denials and
// questions from turning a keyword match into an affirmative threat claim.
export function affirmativeMatch(text, pattern) {
  if (!pattern) return false;
  const prose = String(text).replace(/[^.!?;\n]*\?/g, '');
  for (const clause of prose.split(/(?:[.!?;\n]|\b(?:but|however|whereas)\b)/i)) {
    const regex = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    if (!regex.test(clause)) continue;
    // A missing patch/fix is not a denial of exploitation. Restrict absence
    // qualifiers to threat activity rather than rejecting any "no known" clause.
    if (/\bno known(?:\s+(?:of|that|any|a|the|currently|ongoing|successful|active|reported))*\s+(?:exploit\w*|attack\w*|threat\s+actors?|breach\w*|ransomware|remote[ -]code[ -]execution|rce|zero[ -]day)\b/i.test(clause)) continue;
    if (/\b(?:no evidence|no indication|no signs?|not (?:yet |currently |known to be |being |actively )?(?:exploit|attack|confirm|a zero)|never exploit|without evidence|unconfirmed|unsubstantiated|den(?:y|ies|ied)|ruled out|false (?:claim|report)|whether)\b/i.test(clause)) continue;
    if (/\b(?:no|not|never|without)\b(?:\s+(?:known|reported|confirmed|current|ongoing|evidence|of|any|a|the|being|been|yet|currently|publicly|observed|successful|longer|attackers?|threat|actors?|are|is)){0,6}\s+(?:active(?:ly)?[ -]?exploit\w*|exploit(?:ed|ation)|zero[ -]?day|breach|ransomware[ -]?attack|remote[ -]?code[ -]?execution|rce)\b/i.test(clause)) continue;
    if (/\b(?:exploitation|attack|breach)\b.{0,40}\b(?:not|never)\s+(?:been\s+|yet\s+)?(?:observed|confirmed|detected|reported|established)\b/i.test(clause)) continue;
    return true;
  }
  return false;
}
