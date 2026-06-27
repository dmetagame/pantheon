const DEFAULT_BASE = "http://localhost:3030";

export function baseUrl(): string {
  return process.env.PANTHEON_API_URL?.replace(/\/$/, "") ?? DEFAULT_BASE;
}

export function consultSecret(): string | undefined {
  return process.env.PANTHEON_CONSULT_SECRET;
}

export async function get<T>(path: string): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface ConsultResult {
  god: string;
  question: string;
  answer: string;
}

export interface PaymentRequired {
  status: 402;
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    resource: string;
    description: string;
  }>;
  error: string;
}

/**
 * POST a question to /api/consult/<god>. If the server returns 402 we surface
 * the canonical x402 `accepts` envelope so the caller (agent) can decide how to
 * pay. When PANTHEON_CONSULT_SECRET is set we send it as a Bearer token, which
 * the hackathon-stage backend treats as a stand-in for a verified payment.
 */
export async function consult(
  godId: string,
  question: string,
): Promise<ConsultResult | PaymentRequired> {
  const url = `${baseUrl()}/api/consult/${godId}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret = consultSecret();
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ question }),
  });

  if (res.status === 402) {
    const body = (await res.json().catch(() => ({}))) as Partial<PaymentRequired>;
    return {
      status: 402,
      accepts: body.accepts ?? [],
      error: body.error ?? "Payment required.",
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`consult ${godId} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as ConsultResult;
}
