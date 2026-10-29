// Shared by configuration and request orchestration. The deadline covers all
// provider attempts for one generation, including its single corrective retry.
export const DEFAULT_GENERATION_TIMEOUT_SEC = 300;
export const MIN_GENERATION_TIMEOUT_SEC = 30;
export const MAX_GENERATION_TIMEOUT_SEC = 600;
