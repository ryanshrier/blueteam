// Version 1 is the publication policy used by unversioned retained checks.
// A new evaluation opts into the current policy explicitly; reading a receipt
// must never silently migrate its recorded consequences to newer rules.
export const LEGACY_VALIDATION_POLICY_VERSION = 1;
export const VALIDATION_POLICY_VERSION = 4;
export const validationPolicyVersion = checks => checks?.validationPolicyVersion === undefined
  ? LEGACY_VALIDATION_POLICY_VERSION : checks.validationPolicyVersion;
export const supportedValidationPolicy = version => [1, 2, 3, 4].includes(version);
