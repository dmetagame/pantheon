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
  KeyTypeID,
  PrivateKey,
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

let cached: { key: PrivateKey; client: RpcClient } | null = null;

function loadAdmin(): { key: PrivateKey; client: RpcClient } {
  if (cached) return cached;

  const pemPath = process.env.CASPER_ADMIN_SECRET_KEY_PATH;
  if (!pemPath) {
    throw new Error("CASPER_ADMIN_SECRET_KEY_PATH not set");
  }
  const pem = readFileSync(pemPath, "utf8");
  // Casper PrivateKey enum: 1 = Ed25519, 2 = Secp256k1.
  const algo = pem.includes("BEGIN EC PRIVATE KEY") ? 2 : 1;
  const key = PrivateKey.fromPem(pem, algo);

  const endpoint = NODE_URL.endsWith("/rpc")
    ? NODE_URL
    : `${NODE_URL.replace(/\/$/, "")}/rpc`;
  const handler = new HttpHandler(endpoint);
  if (AUTH) handler.setCustomHeaders({ Authorization: AUTH });
  const client = new RpcClient(handler);

  cached = { key, client };
  return cached;
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
  builderFn: (b: ContractCallBuilder) => void,
  gas: number,
): Promise<string> {
  const { key, client } = loadAdmin();
  const b = new ContractCallBuilder()
    .from(key.publicKey)
    .chainName(CHAIN_NAME)
    .payment(gas)
    .ttl(30 * 60 * 1000);
  builderFn(b);
  const tx = b.build();
  await tx.sign(key);
  const res = await client.putTransaction(tx);
  return res.transactionHash.toHex();
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
  return send(
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
  const { client } = loadAdmin();
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
  return send(
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
    (b) =>
      b.byPackageHash(hash).entryPoint("record_outcome").runtimeArgs(args),
    3_500_000_000,
  );
}
