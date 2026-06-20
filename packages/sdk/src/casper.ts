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
