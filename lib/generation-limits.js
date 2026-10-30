// Shared by configuration and request orchestration. The deadline covers all
// provider attempts for one generation, including its single corrective retry.
export const DEFAULT_GENERATION_TIMEOUT_SEC = 300;
export const MIN_GENERATION_TIMEOUT_SEC = 30;
// Allow two 580-second CLI invocations plus inter-attempt validation margin.
export const MAX_GENERATION_TIMEOUT_SEC = 1200;
