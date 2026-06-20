export const PANTHEON_NETWORK = "casper-test" as const;

export {
  publishOnChain,
  settleOnChain,
  recordOutcomeOnChain,
} from "./casper";
export type {
  PublishParams,
  SettleParams,
  RecordOutcomeParams,
} from "./casper";
