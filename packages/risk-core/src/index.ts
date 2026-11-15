/**
 * Skeleton. The risk engine (8 rules, sizing, RiskApproval) is built in Prompt 4.
 * Fail closed: until then every intent is rejected, so no order can ever be approved by accident.
 */
export type RejectionReason = 'RISK_ENGINE_NOT_IMPLEMENTED';

export interface RiskDecision {
  approved: false;
  reasons: readonly RejectionReason[];
}

export function evaluate(): RiskDecision {
  return { approved: false, reasons: ['RISK_ENGINE_NOT_IMPLEMENTED'] };
}
