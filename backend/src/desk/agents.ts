/** Stages actually run by the candidate desk; no simulated analysts or fills. */
export const PIPELINE_ORDER = ["Market", "Candidate", "Guardian", "Execution"] as const;
