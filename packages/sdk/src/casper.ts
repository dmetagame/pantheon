import { readFileSync } from "node:fs";
import * as casperSdkNs from "casper-js-sdk";

// casper-js-sdk ships a CJS bundle. Under Node ESM (tsx) the named exports come
// via the default property; under webpack's RSC bundler they come straight from
// the namespace. Resolve both shapes once.
const casperSdk: typeof casperSdkNs =
  (casperSdkNs as unknown as { default?: typeof casperSdkNs }).default ??
  casperSdkNs;

const {
  Args,
  CLTypeUInt8,
  CLValue,
  ContractCallBuilder,
  HttpHandler,
  Key,
  KeyTypeID,
  PrivateKey,
  PublicKey,
  RpcClient,
} = casperSdk;
type PrivateKey = InstanceType<typeof casperSdk.PrivateKey>;
type RpcClient = InstanceType<typeof casperSdk.RpcClient>;
type CLValue = InstanceType<typeof casperSdk.CLValue>;
type ContractCallBuilder = InstanceType<typeof casperSdk.ContractCallBuilder>;

const CHAIN_NAME = process.env.CASPER_NETWORK ?? "casper-test";
const NODE_URL =
  process.env.CASPER_NODE_URL ?? "https://node.testnet.cspr.cloud/rpc";
const AUTH = process.env.CSPR_CLOUD_API_KEY ?? "";

// "admin" signs administrative writes (settle, record_outcome,
// register_god). "priest" co-signs settlement quorum proposals. "petitioner"
// is the autonomous-agent customer that pays x402 tithes to consult gods.
// Each god id signs its own publish + future treasury actions.
export type SignerName =
  | "admin"
  | "priest"
  | "petitioner"
  | "demeter"
  | "hermes"
  | "apollo";

const signerCache = new Map<SignerName, PrivateKey>();
let clientCache: RpcClient | null = null;

function envForSigner(name: SignerName): { pemVar: string; pathVar: string } {
  if (name === "admin") {
    return {
      pemVar: "CASPER_ADMIN_SECRET_KEY_PEM",
      pathVar: "CASPER_ADMIN_SECRET_KEY_PATH",
    };
  }
  if (name === "priest") {
    return {
      pemVar: "CASPER_PRIEST_SECRET_KEY_PEM",
      pathVar: "CASPER_PRIEST_SECRET_KEY_PATH",
    };
  }
  if (name === "petitioner") {
    return {
      pemVar: "CASPER_PETITIONER_SECRET_KEY_PEM",
      pathVar: "CASPER_PETITIONER_SECRET_KEY_PATH",
    };
  }
  const upper = name.toUpperCase();
  return {
    pemVar: `CASPER_GOD_${upper}_SECRET_KEY_PEM`,
    pathVar: `CASPER_GOD_${upper}_SECRET_KEY_PATH`,
  };
}

export interface GeneratedKey {
  pem: string;
  publicKeyHex: string;
  accountHash: string;
}

export type CasperAlgo = "Ed25519" | "Secp256k1";

/**
 * Generate a fresh Casper keypair. Returned PEM is unencrypted — caller is
 * responsible for writing it to disk with secure permissions.
 *
 * Use Ed25519 for general Casper operations (publish, settle, etc.).
 * Use Secp256k1 for the petitioner because the x402 Facilitator's signature
 * verifier (casper-eip-712) does ECDSA public-key recovery — Ed25519 signatures
 * cannot be verified through it.
 */
export function generateKey(algo: CasperAlgo = "Ed25519"): GeneratedKey {
  const algoCode = algo === "Ed25519" ? 1 : 2;
  const key = PrivateKey.generate(algoCode);
  return {
    pem: key.toPem(),
    publicKeyHex: key.publicKey.toHex(),
    accountHash: key.publicKey.accountHash().toHex(),
  };
}

/** Back-compat alias for callers that hard-code Ed25519. */
export function generateEd25519Key(): GeneratedKey {
  return generateKey("Ed25519");
}

/** Read public key + account hash from an existing PEM (Ed25519 or Secp256k1). */
export function keyInfoFromPem(pem: string): { publicKeyHex: string; accountHash: string } {
  const algo = pem.includes("BEGIN EC PRIVATE KEY") ? 2 : 1;
  const key = PrivateKey.fromPem(pem, algo);
  return {
    publicKeyHex: key.publicKey.toHex(),
    accountHash: key.publicKey.accountHash().toHex(),
  };
}

export function loadSigner(name: SignerName): PrivateKey {
  const cached = signerCache.get(name);
  if (cached) return cached;

  // Prefer the inline PEM env var (used in production on Vercel where the
  // filesystem is read-only); fall back to a file path for local dev.
  const { pemVar, pathVar } = envForSigner(name);
  const pemInline = process.env[pemVar];
  const pemPath = process.env[pathVar];
  let pem: string;
  if (pemInline && pemInline.includes("BEGIN")) {
    pem = pemInline.replace(/\\n/g, "\n");
  } else if (pemPath) {
    pem = readFileSync(pemPath, "utf8");
  } else {
    throw new Error(`Neither ${pemVar} nor ${pathVar} is set`);
  }
  // Casper PrivateKey enum: 1 = Ed25519, 2 = Secp256k1.
  const algo = pem.includes("BEGIN EC PRIVATE KEY") ? 2 : 1;
  const key = PrivateKey.fromPem(pem, algo);
  signerCache.set(name, key);
  return key;
}

export function loadClient(): RpcClient {
  if (clientCache) return clientCache;
  const endpoint = NODE_URL.endsWith("/rpc")
    ? NODE_URL
    : `${NODE_URL.replace(/\/$/, "")}/rpc`;
  const handler = new HttpHandler(endpoint);
  if (AUTH) handler.setCustomHeaders({ Authorization: AUTH });
  clientCache = new RpcClient(handler);
  return clientCache;
}

function mustHex(v: string | undefined, name: string): string {
  if (!v || !/^[0-9a-f]{64}$/i.test(v)) {
    throw new Error(`${name} missing or not a 32-byte hex hash`);
  }
  return v.toLowerCase();
}

function clBytes(buf: Uint8Array): CLValue {
  // Casper `bytesrepr::Bytes` wire format == CLType::List(U8): u32 LE length + raw bytes.
  // CLByteArray is fixed-length and lacks the length prefix, so it doesn't match.
  return CLValue.newCLList(
    CLTypeUInt8,
    Array.from(buf, (b) => CLValue.newCLUint8(b)),
  );
}

async function send(
  signerName: SignerName,
  builderFn: (b: ContractCallBuilder) => void,
  gas: number,
): Promise<string> {
  const key = loadSigner(signerName);
  const client = loadClient();
  const b = new ContractCallBuilder()
    .from(key.publicKey)
    .chainName(CHAIN_NAME)
    .payment(gas)
    .ttl(30 * 60 * 1000);
  builderFn(b);
  const tx = b.build();
  await tx.sign(key);
  // Every Casper tx is identified by a hash deterministically derived from
  // its signed body, so we already know what tx hash to look for even before
  // the node accepts it. If putTransaction's response is lost to a network
  // error, this is the hash we poll for to decide adopt-vs-retry.
  const expectedHash = tx.hash.toHex();
  try {
    const res = await client.putTransaction(tx);
    return res.transactionHash.toHex();
  } catch (err) {
    if (!isLikelyNetworkError(err)) throw err;
    // Lost the response — the tx may have landed anyway. Poll the node by
    // the predetermined hash. If it ends up reverted, surface that as a
    // distinct error so the cron can decide whether to retry or give up;
    // we don't want to silently return a hash for a failed action.
    const observed = await pollForTransaction(client, expectedHash, 90_000);
    if (observed === "success") {
      console.warn(
        `[casper.send] adopted ${expectedHash} after network error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return expectedHash;
    }
    if (observed === "reverted") {
      throw new Error(
        `Tx ${expectedHash} reverted on chain after a lost-response submission (signer=${signerName})`,
      );
    }
    throw err;
  }
}

function isLikelyNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Node's undici-backed fetch surfaces codes either on the error itself or
  // on its .cause. Cover both shapes plus the canonical socket codes.
  const direct = (err as { code?: unknown }).code;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  const codes = [direct, cause?.code].filter(
    (c): c is string => typeof c === "string",
  );
  const networkCodes = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "FetchError",
  ]);
  if (codes.some((c) => networkCodes.has(c))) return true;
  // String fallback for libraries that bury the code in the message.
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i.test(
    err.message,
  );
}

async function pollForTransaction(
  client: RpcClient,
  txHash: string,
  timeoutMs: number,
): Promise<"success" | "reverted" | "not_found"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await client.getTransactionByTransactionHash(txHash);
      const info = res?.executionInfo as
        | { executionResult: { errorMessage?: string } }
        | undefined;
      if (info) {
        return info.executionResult.errorMessage ? "reverted" : "success";
      }
    } catch {
      // not yet indexed by the node — keep polling
    }
    await sleep(5_000);
  }
  return "not_found";
}

export interface PublishParams {
  godId: string;
  questionHash: Uint8Array;
  claim: boolean;
  confidenceBp: number;
  settlesAtMs: number;
  oracleSource: string;
}

export async function publishOnChain(p: PublishParams): Promise<string> {
  const hash = mustHex(
    process.env.PROPHECY_REGISTRY_HASH,
    "PROPHECY_REGISTRY_HASH",
  );
  const args = Args.fromMap({
    god_id: CLValue.newCLString(p.godId),
    question_hash: clBytes(p.questionHash),
    claim: CLValue.newCLValueBool(p.claim),
    confidence_bp: CLValue.newCLUInt32(p.confidenceBp),
    settles_at: CLValue.newCLUint64(BigInt(p.settlesAtMs)),
    oracle_source: CLValue.newCLString(p.oracleSource),
  });
  // The god itself signs its publish. ProphecyRegistry's `require_publisher`
  // check enforces that the signing account matches the registered publisher
  // for that god_id, so this only works once register_god has been called with
  // the god's public key (see scripts/register-gods.ts).
  return send(
    p.godId as SignerName,
    (b) => b.byPackageHash(hash).entryPoint("publish").runtimeArgs(args),
    3_500_000_000,
  );
}

// CES on Casper-2/Odra writes each event to the `__events` dictionary as a
// CLValue::Any whose payload contains the bytesrepr-encoded event name (Odra
// prepends `event_` to the Rust struct name) followed by the fields in
// declaration order. We scan for the literal marker
// "[23 LE]event_ProphecyPublished" — once found, the next 8 bytes are the
// `id: u64` field little-endian.
const PROPHECY_PUBLISHED_NAME = "event_ProphecyPublished";
const PROPHECY_PUBLISHED_MARKER: Uint8Array = (() => {
  const name = new TextEncoder().encode(PROPHECY_PUBLISHED_NAME);
  const out = new Uint8Array(4 + name.length);
  new DataView(out.buffer).setUint32(0, name.length, true);
  out.set(name, 4);
  return out;
})();

function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function readU64LE(buf: Uint8Array, offset: number): bigint {
  let id = 0n;
  for (let i = 0; i < 8; i++) {
    id |= BigInt(buf[offset + i]) << BigInt(8 * i);
  }
  return id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll until the publish tx is finalized, then scan its dictionary writes for
 * the ProphecyPublished event and return the assigned on-chain id.
 */
export async function confirmPublishedId(
  txHash: string,
  timeoutMs = 120_000,
): Promise<bigint> {
  const client = loadClient();
  const deadline = Date.now() + timeoutMs;

  let executionInfo: { executionResult: { errorMessage?: string; effects: unknown[] } } | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await client.getTransactionByTransactionHash(txHash);
      if (res.executionInfo) {
        executionInfo = res.executionInfo as typeof executionInfo;
        break;
      }
    } catch {
      // Tx not yet indexed by the node — keep polling.
    }
    await sleep(3_000);
  }
  if (!executionInfo) {
    throw new Error(`Tx ${txHash} not finalized within ${timeoutMs}ms`);
  }
  const err = executionInfo.executionResult.errorMessage;
  if (err) {
    throw new Error(`Tx ${txHash} reverted: ${err}`);
  }

  for (const t of executionInfo.executionResult.effects as Array<{
    key: { type: number };
    kind: { isWriteCLValue: () => boolean; parseAsWriteCLValue: () => CLValue };
  }>) {
    if (t.key.type !== KeyTypeID.Dictionary) continue;
    if (!t.kind.isWriteCLValue()) continue;
    let raw: Uint8Array;
    try {
      raw = t.kind.parseAsWriteCLValue().bytes();
    } catch {
      continue;
    }
    const idx = findSubarray(raw, PROPHECY_PUBLISHED_MARKER);
    if (idx < 0) continue;
    const idOffset = idx + PROPHECY_PUBLISHED_MARKER.length;
    if (idOffset + 8 > raw.length) continue;
    return readU64LE(raw, idOffset);
  }
  throw new Error(`ProphecyPublished event not found in tx ${txHash}`);
}

export interface SettleParams {
  id: bigint;
  truth: boolean;
  sourceValue: string;
}

export async function settleOnChain(p: SettleParams): Promise<string> {
  const hash = mustHex(
    process.env.PROPHECY_REGISTRY_HASH,
    "PROPHECY_REGISTRY_HASH",
  );
  const args = Args.fromMap({
    id: CLValue.newCLUint64(p.id),
    truth: CLValue.newCLValueBool(p.truth),
    source_value: CLValue.newCLString(p.sourceValue),
  });
  // Admin signs settle. The on-chain entry-point is `require_admin`; for the
  // upcoming PriestQuorum flow the admin acts as the off-chain executor of a
  // quorum-approved decision rather than as a unilateral oracle.
  return send(
    "admin",
    (b) => b.byPackageHash(hash).entryPoint("settle").runtimeArgs(args),
    3_500_000_000,
  );
}

export interface RecordOutcomeParams {
  godId: string;
  brierBp: number;
  settledAtMs: number;
}

export async function recordOutcomeOnChain(
  p: RecordOutcomeParams,
): Promise<string> {
  const hash = mustHex(
    process.env.REPUTATION_CONTRACT_HASH,
    "REPUTATION_CONTRACT_HASH",
  );
  const args = Args.fromMap({
    god_id: CLValue.newCLString(p.godId),
    brier_bp: CLValue.newCLUInt32(p.brierBp),
    settled_at: CLValue.newCLUint64(BigInt(p.settledAtMs)),
  });
  return send(
    "admin",
    (b) =>
      b.byPackageHash(hash).entryPoint("record_outcome").runtimeArgs(args),
    3_500_000_000,
  );
}

// ─── bytesrepr helpers ────────────────────────────────────────────────────

function u32LE(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

function u64LE(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function bytesreprString(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  return concat(u32LE(b.length), b);
}

function bytesreprBytes(b: Uint8Array): Uint8Array {
  return concat(u32LE(b.length), b);
}

/**
 * Encode `PriestQuorum::ProposalKind::Custom { tag, payload }` as Odra's
 * bytesrepr. Variant indices (in declaration order):
 *   0 = WithdrawUsdc, 1 = LiquidateTemple, 2 = UpdateStrategy, 3 = Custom.
 */
function encodeCustomProposalKind(tag: string, payload: Uint8Array): Uint8Array {
  const VARIANT_CUSTOM = 3;
  return concat(
    new Uint8Array([VARIANT_CUSTOM]),
    bytesreprString(tag),
    bytesreprBytes(payload),
  );
}

/**
 * Pantheon's settlement payload: (prophecy_id u64 LE, truth u8, source_value String).
 * Stored inside ProposalKind::Custom { tag: "SettleProphecy", payload }.
 */
function encodeSettlementPayload(
  prophecyId: bigint,
  truth: boolean,
  sourceValue: string,
): Uint8Array {
  return concat(
    u64LE(prophecyId),
    new Uint8Array([truth ? 1 : 0]),
    bytesreprString(sourceValue),
  );
}

export interface RegisterGodParams {
  godId: string;
  /** Hex public key (with the 1-byte algorithm prefix Casper uses). */
  publisherPublicKeyHex: string;
}

/**
 * Admin call to ProphecyRegistry.register_god — sets the authorised publisher
 * for a god so that god's keypair can publish prophecies for itself.
 */
export async function registerGodOnChain(
  p: RegisterGodParams,
): Promise<string> {
  const hash = mustHex(
    process.env.PROPHECY_REGISTRY_HASH,
    "PROPHECY_REGISTRY_HASH",
  );
  // Odra `Address::Account(AccountHash)` <=> Casper `Key::Account(hash)`. We
  // derive the account hash from the god's public key and wrap it as a CLKey.
  const publisherPK = PublicKey.fromHex(p.publisherPublicKeyHex);
  const publisherKey = Key.newKey(publisherPK.accountHash().toPrefixedString());
  const args = Args.fromMap({
    god_id: CLValue.newCLString(p.godId),
    publisher: CLValue.newCLKey(publisherKey),
  });
  return send(
    "admin",
    (b) =>
      b.byPackageHash(hash).entryPoint("register_god").runtimeArgs(args),
    3_500_000_000,
  );
}

// ─── PriestQuorum ─────────────────────────────────────────────────────────

function priestQuorumHash(): string {
  return mustHex(process.env.PRIEST_QUORUM_HASH, "PRIEST_QUORUM_HASH");
}

function addressKeyFromHex(publicKeyHex: string): InstanceType<typeof Key> {
  return Key.newKey(PublicKey.fromHex(publicKeyHex).accountHash().toPrefixedString());
}

export interface SetPriesthoodParams {
  godId: string;
  godPublicKeyHex: string;
  priestPublicKeyHex: string;
}

/**
 * Admin call to PriestQuorum.set_priesthood — registers (god, priest) as the
 * two-of-two co-signers for proposals scoped to this god_id.
 */
export async function setPriesthoodOnChain(
  p: SetPriesthoodParams,
): Promise<string> {
  const args = Args.fromMap({
    god_id: CLValue.newCLString(p.godId),
    god: CLValue.newCLKey(addressKeyFromHex(p.godPublicKeyHex)),
    priest: CLValue.newCLKey(addressKeyFromHex(p.priestPublicKeyHex)),
  });
  return send(
    "admin",
    (b) =>
      b.byPackageHash(priestQuorumHash()).entryPoint("set_priesthood").runtimeArgs(args),
    3_500_000_000,
  );
}

export interface ProposeSettlementParams {
  godId: string;
  prophecyId: bigint;
  truth: boolean;
  sourceValue: string;
}

/**
 * God-signed call to PriestQuorum.propose with kind = Custom {
 *   tag: "SettleProphecy", payload: bytesrepr(prophecyId, truth, sourceValue)
 * }. The on-chain ProposalKind enum's `Custom` variant lets us encode the
 * settlement decision without expanding the contract ABI. The off-chain
 * orchestrator decodes the same payload when finalising
 * ProphecyRegistry.settle.
 */
export async function proposeSettlementOnChain(
  p: ProposeSettlementParams,
): Promise<string> {
  const payload = encodeSettlementPayload(p.prophecyId, p.truth, p.sourceValue);
  const kindBytes = encodeCustomProposalKind("SettleProphecy", payload);
  const args = Args.fromMap({
    god_id: CLValue.newCLString(p.godId),
    // ProposalKind is an `#[odra::odra_type]` enum; its CLType is `Any` so we
    // pass the bytesrepr-encoded variant as a CL_Any value.
    kind: CLValue.newCLAny(kindBytes),
  });
  return send(
    p.godId as SignerName,
    (b) =>
      b.byPackageHash(priestQuorumHash()).entryPoint("propose").runtimeArgs(args),
    3_500_000_000,
  );
}

export interface ApproveProposalParams {
  proposalId: bigint;
  /** Whichever side signs — for v1 the priest slot is admin. */
  signer: SignerName;
}

export async function approveProposalOnChain(
  p: ApproveProposalParams,
): Promise<string> {
  const args = Args.fromMap({
    proposal_id: CLValue.newCLUint64(p.proposalId),
  });
  return send(
    p.signer,
    (b) =>
      b.byPackageHash(priestQuorumHash()).entryPoint("approve").runtimeArgs(args),
    3_500_000_000,
  );
}

// Parse ProposalCreated id from a propose tx receipt, mirroring
// confirmPublishedId's event-marker scan.
const PROPOSAL_CREATED_NAME = "event_ProposalCreated";
const PROPOSAL_CREATED_MARKER: Uint8Array = (() => {
  const name = new TextEncoder().encode(PROPOSAL_CREATED_NAME);
  const out = new Uint8Array(4 + name.length);
  new DataView(out.buffer).setUint32(0, name.length, true);
  out.set(name, 4);
  return out;
})();

export async function confirmProposalCreatedId(
  txHash: string,
  timeoutMs = 120_000,
): Promise<bigint> {
  const client = loadClient();
  const deadline = Date.now() + timeoutMs;

  let executionInfo: { executionResult: { errorMessage?: string; effects: unknown[] } } | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await client.getTransactionByTransactionHash(txHash);
      if (res.executionInfo) {
        executionInfo = res.executionInfo as typeof executionInfo;
        break;
      }
    } catch {
      // not yet indexed
    }
    await sleep(3_000);
  }
  if (!executionInfo) {
    throw new Error(`Tx ${txHash} not finalized within ${timeoutMs}ms`);
  }
  const err = executionInfo.executionResult.errorMessage;
  if (err) {
    throw new Error(`Tx ${txHash} reverted: ${err}`);
  }

  for (const t of executionInfo.executionResult.effects as Array<{
    key: { type: number };
    kind: { isWriteCLValue: () => boolean; parseAsWriteCLValue: () => CLValue };
  }>) {
    if (t.key.type !== KeyTypeID.Dictionary) continue;
    if (!t.kind.isWriteCLValue()) continue;
    let raw: Uint8Array;
    try {
      raw = t.kind.parseAsWriteCLValue().bytes();
    } catch {
      continue;
    }
    const idx = findSubarray(raw, PROPOSAL_CREATED_MARKER);
    if (idx < 0) continue;
    const idOffset = idx + PROPOSAL_CREATED_MARKER.length;
    if (idOffset + 8 > raw.length) continue;
    return readU64LE(raw, idOffset);
  }
  throw new Error(`ProposalCreated event not found in tx ${txHash}`);
}
