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
  NativeTransferBuilder,
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
const SUBMIT_NODE_URLS =
  process.env.CASPER_SUBMIT_NODE_URLS ??
  process.env.CASPER_SUBMIT_NODE_URL ??
  NODE_URL;
const POLL_NODE_URL = process.env.CASPER_POLL_NODE_URL ?? NODE_URL;
const AUTH = process.env.CSPR_CLOUD_API_KEY ?? "";

// "admin" signs administrative writes (settle, reputation outcome,
// register_god). "priest" + per-god priests ("priest_demeter" etc.) co-sign
// settlement quorum proposals. "petitioner" is the configured receipt signer
// for consult commitments. Each god id signs its own publish + future treasury
// actions.
export type SignerName =
  | "admin"
  | "priest"
  | "priest_demeter"
  | "priest_hermes"
  | "priest_apollo"
  | "petitioner"
  | "demeter"
  | "hermes"
  | "apollo";

const signerCache = new Map<SignerName, PrivateKey>();
let clientCache: RpcClient | null = null;
let submitClientCache: SubmitTarget[] | null = null;
let pollClientCache: RpcClient | null = null;

interface SubmitTarget {
  endpoint: string;
  client: RpcClient;
}

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
  if (name.startsWith("priest_")) {
    const god = name.slice("priest_".length).toUpperCase();
    return {
      pemVar: `CASPER_PRIEST_${god}_SECRET_KEY_PEM`,
      pathVar: `CASPER_PRIEST_${god}_SECRET_KEY_PATH`,
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
  const endpoint = formatRpcEndpoint(NODE_URL);
  const handler = new HttpHandler(endpoint);
  attachAuthHeader(handler, endpoint);
  clientCache = new RpcClient(handler);
  return clientCache;
}

function loadSubmitTargets(): SubmitTarget[] {
  if (submitClientCache) return submitClientCache;
  submitClientCache = parseRpcEndpointList(SUBMIT_NODE_URLS).map((url) => {
    const endpoint = formatRpcEndpoint(url);
    const handler = new HttpHandler(endpoint);
    attachAuthHeader(handler, endpoint);
    return { endpoint, client: new RpcClient(handler) };
  });
  return submitClientCache;
}

function loadPollClient(): RpcClient {
  if (pollClientCache) return pollClientCache;
  const handler = new HttpHandler(formatRpcEndpoint(POLL_NODE_URL));
  attachAuthHeader(handler, POLL_NODE_URL);
  pollClientCache = new RpcClient(handler);
  return pollClientCache;
}

function formatRpcEndpoint(url: string): string {
  return url.endsWith("/rpc") ? url : `${url.replace(/\/$/, "")}/rpc`;
}

function rpcEndpointFor(url: string): string {
  return formatRpcEndpoint(url);
}

function parseRpcEndpointList(value: string): string[] {
  const urls = value
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  return Array.from(new Set(urls.length > 0 ? urls : [NODE_URL]));
}

function attachAuthHeader(handler: InstanceType<typeof HttpHandler>, url: string): void {
  if (!AUTH || !shouldUseCSPRCloudAuth(url)) return;
  handler.setCustomHeaders({ Authorization: AUTH });
}

function rpcHeadersFor(url: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH && shouldUseCSPRCloudAuth(url)) h.Authorization = AUTH;
  return h;
}

function shouldUseCSPRCloudAuth(url: string): boolean {
  const host = hostnameOf(url);
  return host === "cspr.cloud" || host.endsWith(".cspr.cloud");
}

function hostnameOf(url: string): string {
  try {
    return new URL(formatRpcEndpoint(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
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
  return submitTransaction(tx, signerName);
}

async function submitTransaction(
  tx: Parameters<RpcClient["putTransaction"]>[0] & { hash: { toHex(): string } },
  signerName: SignerName,
): Promise<string> {
  const expectedHash = tx.hash.toHex();
  const pollClient = loadPollClient();
  const failures: string[] = [];

  for (const target of loadSubmitTargets()) {
    try {
      const res = await target.client.putTransaction(tx);
      return res.transactionHash.toHex();
    } catch (err) {
      const error = errorMessage(err);
      if (isLikelyNetworkError(err)) {
        // Lost the response — the tx may have landed anyway. Poll the node by
        // the predetermined hash. If it ended up reverted, surface that as a
        // distinct error so callers don't silently accept a failed action.
        const observed = await pollForTransaction(
          pollClient,
          expectedHash,
          90_000,
        );
        if (observed === "success") {
          console.warn(
            `[casper.send] adopted ${expectedHash} after network error from ${target.endpoint}: ${error}`,
          );
          return expectedHash;
        }
        if (observed === "reverted") {
          throw new Error(
            `Tx ${expectedHash} reverted on chain after a lost-response submission (signer=${signerName}, endpoint=${target.endpoint})`,
          );
        }
      }
      failures.push(`${target.endpoint}: ${error}`);
      if (!isRetryableSubmitError(error) && !isLikelyNetworkError(err)) {
        break;
      }
    }
  }

  throw new Error(
    `all Casper submit endpoints failed for ${expectedHash} (signer=${signerName}): ${failures.join(" | ")}`,
  );
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

function isRetryableSubmitError(message: string): boolean {
  return (
    /\b(408|409|413|425|429|500|502|503|504)\b/.test(message) ||
    /too many requests|rate limit|payload too large|timeout|temporarily unavailable|access lim/i.test(
      message,
    )
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function pollForTransaction(
  _client: RpcClient,
  txHash: string,
  timeoutMs: number,
): Promise<"success" | "reverted" | "not_found"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await fetchTransactionExecutionInfo(txHash);
    if (info) return info.errorMessage ? "reverted" : "success";
    await sleep(5_000);
  }
  return "not_found";
}

interface RawExecutionInfo {
  errorMessage?: string;
  effectBytes: Uint8Array[];
}

async function fetchTransactionExecutionInfo(
  txHash: string,
): Promise<RawExecutionInfo | null> {
  for (const transactionHash of [{ Version1: txHash }, { Deploy: txHash }]) {
    const res = await fetch(rpcEndpointFor(POLL_NODE_URL), {
      method: "POST",
      headers: rpcHeadersFor(POLL_NODE_URL),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "info_get_transaction",
        params: { transaction_hash: transactionHash },
      }),
    });
    if (!res.ok) continue;
    const data = (await res.json()) as {
      result?: {
        execution_info?: {
          execution_result?: unknown;
        };
      };
      error?: { message?: string; data?: string };
    };
    const executionResult = data.result?.execution_info?.execution_result;
    if (!executionResult) continue;
    return parseRawExecutionInfo(executionResult);
  }
  return null;
}

function parseRawExecutionInfo(executionResult: unknown): RawExecutionInfo {
  const root = executionResult as Record<string, unknown>;
  const versioned =
    (root.Version2 as Record<string, unknown> | undefined) ??
    (root.Version1 as Record<string, unknown> | undefined) ??
    root;
  const errorMessage =
    typeof versioned.error_message === "string"
      ? versioned.error_message
      : typeof versioned.errorMessage === "string"
        ? versioned.errorMessage
        : undefined;
  const effects = Array.isArray(versioned.effects) ? versioned.effects : [];
  const effectBytes: Uint8Array[] = [];
  for (const effect of effects) {
    const e = effect as {
      kind?: { Write?: { CLValue?: { bytes?: unknown } } };
      transform?: { WriteCLValue?: { bytes?: unknown } };
    };
    const bytes =
      e.kind?.Write?.CLValue?.bytes ?? e.transform?.WriteCLValue?.bytes;
    if (typeof bytes === "string" && /^[0-9a-f]*$/i.test(bytes)) {
      effectBytes.push(Buffer.from(bytes, "hex"));
    }
  }
  return { errorMessage, effectBytes };
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
  const deadline = Date.now() + timeoutMs;

  let executionInfo: RawExecutionInfo | null = null;
  while (Date.now() < deadline) {
    executionInfo = await fetchTransactionExecutionInfo(txHash);
    if (executionInfo) break;
    await sleep(3_000);
  }
  if (!executionInfo) {
    throw new Error(`Tx ${txHash} not finalized within ${timeoutMs}ms`);
  }
  if (executionInfo.errorMessage) {
    throw new Error(`Tx ${txHash} reverted: ${executionInfo.errorMessage}`);
  }

  for (const raw of executionInfo.effectBytes) {
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
  prophecyId: bigint;
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
  const entryPoint =
    process.env.REPUTATION_OUTCOME_ENTRYPOINT ?? "record_outcome";
  const args =
    entryPoint === "record_prophecy_outcome"
      ? Args.fromMap({
          god_id: CLValue.newCLString(p.godId),
          prophecy_id: CLValue.newCLUint64(p.prophecyId),
          brier_bp: CLValue.newCLUInt32(p.brierBp),
          settled_at: CLValue.newCLUint64(BigInt(p.settledAtMs)),
        })
      : Args.fromMap({
          god_id: CLValue.newCLString(p.godId),
          brier_bp: CLValue.newCLUInt32(p.brierBp),
          settled_at: CLValue.newCLUint64(BigInt(p.settledAtMs)),
        });
  return send(
    "admin",
    (b) => b.byPackageHash(hash).entryPoint(entryPoint).runtimeArgs(args),
    3_500_000_000,
  );
}

export interface TransferCep18Params {
  /** The signer name — the god is the one moving its own treasury. */
  signer: SignerName;
  /** CEP18 token contract package hash (e.g. WCSPR's). */
  tokenPackageHash: string;
  /** 33-byte Casper Key hex for the recipient (00 + 32-byte account hash). */
  recipientAccountKeyHex: string;
  /** Atomic-unit amount to transfer (token's smallest denom). */
  amountMotes: bigint;
}

/**
 * God-signed CEP18 transfer from the god's treasury to a recipient (typically
 * a slashed-prophecy refund to a recent petitioner). Uses the standard
 * CEP-18 `transfer(recipient: Key, amount: U256)` entry-point.
 */
export async function transferCep18FromGod(
  p: TransferCep18Params,
): Promise<string> {
  const tokenHash = mustHex(p.tokenPackageHash, "tokenPackageHash");
  const recipientKey = Key.newKey(`account-hash-${stripKeyTag(p.recipientAccountKeyHex)}`);
  const args = Args.fromMap({
    recipient: CLValue.newCLKey(recipientKey),
    amount: CLValue.newCLUInt256(p.amountMotes),
  });
  return send(
    p.signer,
    (b) =>
      b.byPackageHash(tokenHash).entryPoint("transfer").runtimeArgs(args),
    3_500_000_000,
  );
}

/** Strip the 1-byte Casper Key type-tag if present, leaving a 64-char hex hash. */
function stripKeyTag(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 66 && (clean.startsWith("00") || clean.startsWith("01"))) {
    return clean.slice(2);
  }
  return clean;
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
 * Pantheon's settlement payload: (prophecy_id u64 LE, truth u8,
 * source_value String). Stored inside ProposalKind::Custom.
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

export async function proposeSettlementOnChain(
  p: ProposeSettlementParams,
): Promise<string> {
  if (process.env.PRIEST_QUORUM_PROPOSE_MODE === "typed") {
    const args = Args.fromMap({
      god_id: CLValue.newCLString(p.godId),
      prophecy_id: CLValue.newCLUint64(p.prophecyId),
      truth: CLValue.newCLValueBool(p.truth),
      source_value: CLValue.newCLString(p.sourceValue),
    });
    return send(
      p.godId as SignerName,
      (b) =>
        b
          .byPackageHash(priestQuorumHash())
          .entryPoint("propose_settle")
          .runtimeArgs(args),
      3_500_000_000,
    );
  }

  const payload = encodeSettlementPayload(p.prophecyId, p.truth, p.sourceValue);
  const kindBytes = encodeCustomProposalKind("SettleProphecy", payload);
  const args = Args.fromMap({
    god_id: CLValue.newCLString(p.godId),
    kind: CLValue.newCLAny(kindBytes),
  });
  return send(
    p.godId as SignerName,
    (b) =>
      b
        .byPackageHash(priestQuorumHash())
        .entryPoint("propose")
        .runtimeArgs(args),
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
  const deadline = Date.now() + timeoutMs;

  let executionInfo: RawExecutionInfo | null = null;
  while (Date.now() < deadline) {
    executionInfo = await fetchTransactionExecutionInfo(txHash);
    if (executionInfo) break;
    await sleep(3_000);
  }
  if (!executionInfo) {
    throw new Error(`Tx ${txHash} not finalized within ${timeoutMs}ms`);
  }
  if (executionInfo.errorMessage) {
    throw new Error(`Tx ${txHash} reverted: ${executionInfo.errorMessage}`);
  }

  for (const raw of executionInfo.effectBytes) {
    const idx = findSubarray(raw, PROPOSAL_CREATED_MARKER);
    if (idx < 0) continue;
    const idOffset = idx + PROPOSAL_CREATED_MARKER.length;
    if (idOffset + 8 > raw.length) continue;
    return readU64LE(raw, idOffset);
  }
  throw new Error(`ProposalCreated event not found in tx ${txHash}`);
}

// ─── consult receipts (Tier 2 v2) ─────────────────────────────────────────

import { keccak_256 } from "@noble/hashes/sha3";
import { blake2b } from "@noble/hashes/blake2b";

// ─── on-chain reputation read (Tier 1.H) ──────────────────────────────────

/**
 * The `reputations` mapping is the third user field declared on the
 * Reputation Odra module. Odra prefixes user fields with one internal slot,
 * so the runtime field index is 3. Confirmed by direct testnet query.
 */
const REPUTATIONS_FIELD_INDEX = 3;

/** Derive the Casper dictionary item key for a Mapping<String, _> in Odra. */
function odraMappingDictKey(fieldIndex: number, mappingKey: string): string {
  // Odra packs ≤15-deep paths as a u32 BE — for a top-level field that's
  // just the index encoded in 4 bytes.
  const indexBytes = new Uint8Array([0, 0, 0, fieldIndex]);
  const keyBytes = new TextEncoder().encode(mappingKey);
  const lenLE = new Uint8Array(4);
  new DataView(lenLE.buffer).setUint32(0, keyBytes.length, true);
  const input = new Uint8Array(
    indexBytes.length + lenLE.length + keyBytes.length,
  );
  input.set(indexBytes, 0);
  input.set(lenLE, indexBytes.length);
  input.set(keyBytes, indexBytes.length + lenLE.length);
  return Array.from(blake2b(input, { dkLen: 32 }), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export interface ChainReputation {
  /** Lower = better. EWMA Brier in basis points. */
  accuracyBp: number;
  prophecies_settled: number;
  prophecies_missed: number;
  /** Unix timestamp (ms) of the last reputation outcome call. */
  lastUpdatedMs: bigint;
}

/**
 * Read a god's reputation directly from the Reputation contract's
 * `reputations` mapping. Returns null if the god has no entry yet.
 *
 * Implementation: Odra Mapping<String, V> is stored as a dictionary under
 * the module's `state` URef. The dictionary key is
 * blake2b256(index_bytes || bytesrepr(key)). We query the node by URef +
 * derived key, then bytesrepr-decode the value.
 */
export async function readReputationFromChain(
  godId: string,
): Promise<ChainReputation | null> {
  const contractHash = mustHex(
    process.env.REPUTATION_CONTRACT_VERSION_HASH ??
      process.env.REPUTATION_CONTRACT_HASH,
    "REPUTATION_CONTRACT_VERSION_HASH or REPUTATION_CONTRACT_HASH",
  );

  // Step 1: query the contract entity to find its `state` URef.
  // We use the raw RPC: query_global_state path-less against the contract.
  const stateUref = await fetchContractStateUref(contractHash);
  if (!stateUref) return null;

  // Step 2: compute the Odra-derived dictionary item key.
  const dictKey = odraMappingDictKey(REPUTATIONS_FIELD_INDEX, godId);

  // Step 3: get_dictionary_item by URef.
  const stateRootHash = await fetchLatestStateRootHash();
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "state_get_dictionary_item",
    params: {
      state_root_hash: stateRootHash,
      dictionary_identifier: {
        URef: {
          seed_uref: stateUref,
          dictionary_item_key: dictKey,
        },
      },
    },
  };
  const res = await fetch(rpcEndpoint(), {
    method: "POST",
    headers: rpcHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `state_get_dictionary_item HTTP ${res.status}: ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    result?: {
      stored_value?: { CLValue?: { bytes?: string } };
    };
    error?: { message?: string; data?: string };
  };
  if (data.error) {
    // "value was not found in the global state" → god not yet recorded.
    if ((data.error.data ?? "").includes("not found")) return null;
    throw new Error(
      `state_get_dictionary_item failed: ${data.error.message}: ${data.error.data}`,
    );
  }
  const clBytesHex = data.result?.stored_value?.CLValue?.bytes;
  if (!clBytesHex) return null;
  return decodeGodReputation(clBytesHex);
}

function decodeGodReputation(clBytesHex: string): ChainReputation {
  // CLValue is a List<U8>: first 4 bytes = u32 LE length, then the bytesrepr
  // of the GodReputation struct in declaration order:
  //   accuracy_bp: u32 LE (4 bytes)
  //   prophecies_settled: u32 LE (4 bytes)
  //   prophecies_missed: u32 LE (4 bytes)
  //   last_updated: u64 LE (8 bytes)
  // Total payload: 20 bytes; outer wrapper: 24 bytes hex (48 chars beyond the
  // u32 length prefix).
  const all = Buffer.from(clBytesHex, "hex");
  const payload = all.subarray(4); // strip u32 length prefix
  if (payload.length < 20) {
    throw new Error(
      `Reputation payload too short: expected 20+ bytes, got ${payload.length}`,
    );
  }
  return {
    accuracyBp: payload.readUInt32LE(0),
    prophecies_settled: payload.readUInt32LE(4),
    prophecies_missed: payload.readUInt32LE(8),
    lastUpdatedMs: payload.readBigUInt64LE(12),
  };
}

function rpcEndpoint(): string {
  return NODE_URL.endsWith("/rpc")
    ? NODE_URL
    : `${NODE_URL.replace(/\/$/, "")}/rpc`;
}

function rpcHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (AUTH && shouldUseCSPRCloudAuth(NODE_URL)) h.Authorization = AUTH;
  return h;
}

async function fetchLatestStateRootHash(): Promise<string> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "chain_get_state_root_hash",
    params: {},
  };
  const res = await fetch(rpcEndpoint(), {
    method: "POST",
    headers: rpcHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `chain_get_state_root_hash HTTP ${res.status}: ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    result?: { state_root_hash?: string };
    error?: { message?: string; data?: string };
  };
  if (data.error) {
    throw new Error(
      `chain_get_state_root_hash failed: ${data.error.message}: ${data.error.data}`,
    );
  }
  const stateRootHash = data.result?.state_root_hash;
  if (!stateRootHash) {
    throw new Error("chain_get_state_root_hash returned no state_root_hash");
  }
  return stateRootHash;
}

/** Fetch the `state` URef from the contract entity's named keys. */
async function fetchContractStateUref(
  contractHash: string,
): Promise<string | null> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "query_global_state",
    params: {
      state_identifier: null,
      key: `hash-${contractHash}`,
      path: [],
    },
  };
  const res = await fetch(rpcEndpoint(), {
    method: "POST",
    headers: rpcHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`query_global_state HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    result?: {
      stored_value?: {
        Contract?: { named_keys?: Array<{ name: string; key: string }> };
      };
    };
    error?: { message?: string; data?: string };
  };
  if (data.error) {
    throw new Error(
      `query_global_state failed: ${data.error.message}: ${data.error.data}`,
    );
  }
  const nk = data.result?.stored_value?.Contract?.named_keys ?? [];
  const state = nk.find((k) => k.name === "state");
  return state?.key ?? null;
}

/**
 * Derive the deterministic receipt hash for a consultation. The same inputs
 * always produce the same hash, so anyone with (godId, question, answer,
 * settleTxHash) can recompute it and find the matching on-chain receipt.
 *
 * We use `keccak256` (the same hash casper-eip-712 ships) so the same digest
 * is computable in any environment that already has the x402 dep tree.
 */
export function consultReceiptHash(
  godId: string,
  question: string,
  answer: string,
  settleTxHash: string,
): Uint8Array {
  const payload = `${godId}|${question}|${answer}|${settleTxHash}`;
  return keccak_256(new TextEncoder().encode(payload));
}

/**
 * Extract the lower 6 bytes (48 bits) of a 32-byte hash as a JS-safe integer
 * for use as a native-transfer `id`. casper-js-sdk's NativeTransferBuilder.id()
 * takes a JS `number` (capped at Number.MAX_SAFE_INTEGER = 2^53 − 1), so we
 * stay under that ceiling. 48 bits of entropy is plenty for a single user —
 * birthday collision odds are ~1 in 11M after a million receipts.
 */
export function receiptHashToTransferId(hash: Uint8Array): number {
  if (hash.length < 6) throw new Error("receipt hash must be ≥ 6 bytes");
  let id = 0;
  for (let i = 0; i < 6; i++) {
    id += hash[i] * 2 ** (8 * i);
  }
  return id;
}

export interface ConsultReceiptParams {
  godId: string;
  question: string;
  answer: string;
  settleTxHash: string;
  /** God's public key (with algorithm prefix). The receipt goes to the god
   *  as a tiny native CSPR tribute — Casper 2.x rejects self-transfers
   *  with "Invalid purse". */
  recipientPublicKeyHex: string;
  /** Petitioner CSPR cost for the receipt write, defaults to 2.5 CSPR
   *  (Casper testnet native-transfer payment minimum). */
  paymentMotes?: bigint;
  /** Receipt motes value sent in the transfer. Defaults to 2.5 CSPR —
   *  the network rejects sub-minimum transfer amounts. */
  receiptValueMotes?: bigint;
}

export interface ConsultReceipt {
  txHash: string;
  hashHex: string;
  transferId: string;
}

/**
 * On-chain receipt for a consultation. The configured receipt signer issues a
 * tiny transfer whose `id` is derived from the receipt hash. The transfer lands
 * on chain as a verifiable commitment to "this answer was issued for this
 * x402 settlement". Anyone with the off-chain (question, answer, settleTx) can
 * recompute the hash and confirm the matching transfer-id on cspr.live without
 * trusting our database.
 */
export async function recordConsultReceiptOnChain(
  p: ConsultReceiptParams,
): Promise<ConsultReceipt> {
  const hash = consultReceiptHash(
    p.godId,
    p.question,
    p.answer,
    p.settleTxHash,
  );
  const transferId = receiptHashToTransferId(hash);
  const hashHex = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );

  const key = loadSigner("petitioner");
  const recipientPubKey = PublicKey.fromHex(p.recipientPublicKeyHex);
  // NativeTransferBuilder.payment() takes a JS number; amount() takes a
  // string-or-BigNumber CLUInt512; id() takes a JS number. Target must be a
  // different account from the sender — Casper 2.x rejects self-transfers
  // with "Invalid purse".
  const tx = new NativeTransferBuilder()
    .from(key.publicKey)
    .chainName(CHAIN_NAME)
    .payment(Number(p.paymentMotes ?? 2_500_000_000n))
    .ttl(30 * 60 * 1000)
    .target(recipientPubKey)
    .amount((p.receiptValueMotes ?? 2_500_000_000n).toString())
    .id(transferId)
    .build();
  await tx.sign(key);
  return {
    txHash: await submitTransaction(tx, "petitioner"),
    hashHex,
    transferId: String(transferId),
  };
}
