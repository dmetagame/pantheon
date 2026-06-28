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
  generateKey,
  keyInfoFromPem,
  setPriesthoodOnChain,
  proposeSettlementOnChain,
  approveProposalOnChain,
  confirmProposalCreatedId,
  recordConsultReceiptOnChain,
  consultReceiptHash,
  receiptHashToTransferId,
} from "./casper";
export type {
  PublishParams,
  SettleParams,
  RecordOutcomeParams,
  RegisterGodParams,
  SignerName,
  GeneratedKey,
  SetPriesthoodParams,
  ProposeSettlementParams,
  ApproveProposalParams,
  ConsultReceiptParams,
  ConsultReceipt,
} from "./casper";

export {
  buildAcceptsEnvelope,
  decodePaymentHeader,
  pubkeyToAccountHash,
  pubkeyToAccountKeyHex,
  signPaymentPayload,
  verifyOnFacilitator,
  settleOnFacilitator,
} from "./x402";
export type {
  AcceptsEnvelope,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  TransferAuthorization,
  VerifyResponse,
  BuildAcceptsOpts,
  BuildAndSignOpts,
} from "./x402";
