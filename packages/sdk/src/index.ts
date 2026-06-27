export const PANTHEON_NETWORK = "casper-test" as const;

export {
  publishOnChain,
  confirmPublishedId,
  settleOnChain,
  recordOutcomeOnChain,
  registerGodOnChain,
  loadSigner,
  loadClient,
  generateEd25519Key,
  keyInfoFromPem,
} from "./casper";
export type {
  PublishParams,
  SettleParams,
  RecordOutcomeParams,
  RegisterGodParams,
  SignerName,
  GeneratedKey,
} from "./casper";
