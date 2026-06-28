// x402 protocol helpers for both server and petitioner.
//
// Server side: emit the canonical 402 envelope, then verify + settle an
// incoming X-Payment header via the Casper Facilitator at
// https://x402-facilitator.cspr.cloud.
//
// Client side: catch a 402, sign a TransferAuthorization EIP-712 typed-data
// digest with the petitioner's Casper Ed25519 key, encode the paymentPayload
// as the X-Payment header.
//
// We follow x402 v2 with scheme="exact" against a CEP18 token on
// network="casper:casper-test". See:
//   https://docs.cspr.cloud/x402-facilitator-api/

import * as eip712Ns from "@casper-ecosystem/casper-eip-712";
import * as casperSdkNs from "casper-js-sdk";
import { secp256k1 } from "@noble/curves/secp256k1";

const eip712 =
  (eip712Ns as unknown as { default?: typeof eip712Ns }).default ?? eip712Ns;
const casperSdk =
  (casperSdkNs as unknown as { default?: typeof casperSdkNs }).default ??
  casperSdkNs;

const { PrivateKey, PublicKey } = casperSdk;
type PrivateKey = InstanceType<typeof casperSdk.PrivateKey>;

// ─── types ────────────────────────────────────────────────────────────────

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  payTo: string; // 32-byte account hash hex
  amount: string;
  asset: string; // CEP18 contract package hash hex
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
  resource?: string;
  description?: string;
}

export interface AcceptsEnvelope {
  x402Version: 2;
  accepts: PaymentRequirements[];
  error?: string;
}

export interface TransferAuthorization {
  from: string;
  to: string;
  value: bigint;
  valid_after: bigint;
  valid_before: bigint;
  nonce: string;
}

export interface PaymentPayload {
  x402Version: 2;
  resource: { url: string; description?: string; mimeType?: string };
  accepted: PaymentRequirements;
  payload: {
    signature: string;
    publicKey: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

export interface VerifyResponse {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
  invalidMessage?: string;
}

export interface SettleResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
  errorReason?: string;
  errorMessage?: string;
}

// ─── config ───────────────────────────────────────────────────────────────

function envConfig() {
  return {
    facilitatorUrl:
      process.env.X402_FACILITATOR_URL ?? "https://x402-facilitator.cspr.cloud",
    network: process.env.X402_NETWORK ?? "casper:casper-test",
    tokenHash: must(process.env.X402_TOKEN_HASH, "X402_TOKEN_HASH"),
    tokenName: process.env.X402_TOKEN_NAME ?? "Cep18x402",
    tokenVersion: process.env.X402_TOKEN_VERSION ?? "1",
    consultAmount: process.env.X402_CONSULT_AMOUNT ?? "200000",
    cloudAuth: process.env.CSPR_CLOUD_API_KEY ?? "",
  };
}

function must(v: string | undefined, name: string): string {
  if (!v) throw new Error(`${name} env var is required for x402`);
  return v;
}

// ─── account-hash helpers ─────────────────────────────────────────────────

/** Convert a hex-prefixed Casper public key to its bare 32-byte account hash hex. */
export function pubkeyToAccountHash(publicKeyHex: string): string {
  return PublicKey.fromHex(publicKeyHex).accountHash().toHex();
}

/**
 * x402 wire format expects payTo / authorization.from / authorization.to to be
 * 33-byte hex strings: 1-byte Casper Key type tag (`00` = Account) followed by
 * the 32-byte account hash. The Facilitator's "invalid payTo account-hash"
 * error means a missing type tag.
 */
export function pubkeyToAccountKeyHex(publicKeyHex: string): string {
  return `00${pubkeyToAccountHash(publicKeyHex)}`;
}

function accountHashToKeyHex(accountHashHex: string): string {
  const clean = accountHashHex.startsWith("0x")
    ? accountHashHex.slice(2)
    : accountHashHex;
  // Already prefixed? Leave it.
  if (clean.length === 66 && clean.startsWith("00")) return clean;
  return `00${clean}`;
}

// ─── server: emit accepts envelope ────────────────────────────────────────

export interface BuildAcceptsOpts {
  godPublicKeyHex: string;
  amount?: string; // micro-token units; defaults to env
  resourceUrl?: string;
  description?: string;
  /** Server keeps requests valid for this many seconds. */
  maxTimeoutSeconds?: number;
}

export function buildAcceptsEnvelope(opts: BuildAcceptsOpts): AcceptsEnvelope {
  const cfg = envConfig();
  const requirement: PaymentRequirements = {
    scheme: "exact",
    network: cfg.network,
    payTo: pubkeyToAccountKeyHex(opts.godPublicKeyHex),
    amount: opts.amount ?? cfg.consultAmount,
    asset: cfg.tokenHash,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 900,
    extra: { name: cfg.tokenName, version: cfg.tokenVersion },
    resource: opts.resourceUrl,
    description: opts.description,
  };
  return {
    x402Version: 2,
    accepts: [requirement],
    error: "Payment required.",
  };
}

// ─── server: verify + settle through facilitator ──────────────────────────

async function facilitatorPost<T>(path: string, body: unknown): Promise<T> {
  const cfg = envConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.cloudAuth) headers.Authorization = cfg.cloudAuth;
  const res = await fetch(`${cfg.facilitatorUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `facilitator ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

export async function verifyOnFacilitator(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<VerifyResponse> {
  return facilitatorPost("/verify", { paymentPayload, paymentRequirements });
}

export async function settleOnFacilitator(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResponse> {
  return facilitatorPost("/settle", { paymentPayload, paymentRequirements });
}

// ─── server: decode X-Payment header ──────────────────────────────────────

/** Returns null if missing/malformed so callers can render a 402. */
export function decodePaymentHeader(headerValue: string | null): PaymentPayload | null {
  if (!headerValue) return null;
  try {
    const json = Buffer.from(headerValue, "base64").toString("utf8");
    return JSON.parse(json) as PaymentPayload;
  } catch {
    return null;
  }
}

// ─── client: sign TransferAuthorization + build X-Payment header ──────────

export interface BuildAndSignOpts {
  signerKey: PrivateKey;
  recipient: string; // god account hash hex (32 bytes)
  amount: string; // matches paymentRequirements.amount
  paymentRequirements: PaymentRequirements;
  resourceUrl: string;
  /** Window for which this authorisation is valid. Defaults to 10 min. */
  validForSeconds?: number;
}

export async function signPaymentPayload(opts: BuildAndSignOpts): Promise<{
  payload: PaymentPayload;
  header: string;
}> {
  const cfg = envConfig();
  // EIP-712 TransferAuthorizationTypes declares from/to as `bytes32` so we
  // sign over the bare 32-byte account hashes. The on-wire JSON payload
  // separately carries the 33-byte Casper Key form (account-type tag + hash)
  // because that's what the Facilitator's payTo/from/to validators expect.
  const fromAccountHash = stripHexPrefix(
    opts.signerKey.publicKey.accountHash().toHex(),
  );
  const toAccountHash = stripHexPrefix(stripKeyPrefix(opts.recipient));
  const fromKeyHex = `00${fromAccountHash}`;
  const toKeyHex = `00${toAccountHash}`;
  const validForSeconds = opts.validForSeconds ?? 600;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = nowSeconds - 60n; // small backdate slack for clock skew
  const validBefore = nowSeconds + BigInt(validForSeconds);

  const nonce = randomNonce32Hex();
  const auth: TransferAuthorization = {
    from: ensureHexPrefix(fromAccountHash),
    to: ensureHexPrefix(toAccountHash),
    value: BigInt(opts.amount),
    valid_after: validAfter,
    valid_before: validBefore,
    nonce: ensureHexPrefix(nonce),
  };

  const domain = eip712.buildDomain(
    opts.paymentRequirements.extra.name,
    opts.paymentRequirements.extra.version,
    cfg.network,
    ensureHexPrefix(opts.paymentRequirements.asset),
  );

  // CASPER_DOMAIN_TYPES is required when the domain uses Casper-specific
  // fields (chain_name, contract_package_hash). Without it the lib falls back
  // to EVM domain types (name/version/chainId/verifyingContract), producing a
  // different domain separator than the Facilitator computes — the symptom
  // is the Facilitator's "invalid_exact_casper_invalid_signature".
  const digestBytes = eip712.hashTypedData(
    domain,
    eip712.TransferAuthorizationTypes,
    "TransferAuthorization",
    auth as unknown as Record<string, unknown>,
    { domainTypes: eip712.CASPER_DOMAIN_TYPES },
  ) as Uint8Array;
  // The Casper x402 Facilitator verifies signatures via casper-eip-712's
  // recoverAddress(), which only accepts secp256k1 ECDSA signatures with a
  // recovery byte: `r || s || v` (65 bytes). casper-js-sdk's PrivateKey.sign
  // for secp256k1 returns 64 raw bytes (r || s) without v, so we sign
  // through @noble/curves directly to get a recoverable Signature.
  const publicKeyHex = opts.signerKey.publicKey.toHex();
  if (!publicKeyHex.startsWith("02")) {
    throw new Error(
      "x402 requires a Secp256k1 keypair (publicKey starts with 02). " +
        `Got ${publicKeyHex.slice(0, 2)} — regenerate the petitioner key as Secp256k1.`,
    );
  }
  const privateKeyBytes = opts.signerKey.toBytes();
  const nobleSig = secp256k1.sign(digestBytes, privateKeyBytes, {
    prehash: false,
  });
  const sigCompact = nobleSig.toCompactRawBytes(); // 64 bytes: r || s
  const sigBytes = new Uint8Array(65);
  sigBytes.set(sigCompact, 0);
  sigBytes[64] = nobleSig.recovery ?? 0;
  const sigHex = bytesToHex(sigBytes);

  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: opts.resourceUrl },
    accepted: opts.paymentRequirements,
    payload: {
      signature: sigHex,
      publicKey: opts.signerKey.publicKey.toHex(),
      authorization: {
        from: fromKeyHex,
        to: toKeyHex,
        value: auth.value.toString(),
        validAfter: auth.valid_after.toString(),
        validBefore: auth.valid_before.toString(),
        nonce: stripHexPrefix(auth.nonce),
      },
    },
  };

  const header = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return { payload, header };
}

// ─── small encoding helpers ───────────────────────────────────────────────

function randomNonce32Hex(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

function ensureHexPrefix(s: string): string {
  return s.startsWith("0x") ? s : `0x${s}`;
}

function stripHexPrefix(s: string): string {
  return s.startsWith("0x") ? s.slice(2) : s;
}

/**
 * Strip the 1-byte Casper Key type tag (`00...` for Account) so the caller
 * gets back the bare 32-byte account hash hex. Tolerates input that's already
 * bare 32-byte hex.
 */
function stripKeyPrefix(s: string): string {
  const clean = stripHexPrefix(s);
  if (clean.length === 66 && clean.startsWith("00")) return clean.slice(2);
  return clean;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = stripHexPrefix(hex);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
