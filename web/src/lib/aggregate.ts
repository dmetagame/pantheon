// Cross-pantheon aggregates. Single query that returns the headline numbers
// across all three gods, computed off the DB tables we already maintain.

import sql from "./db";

export interface PantheonStats {
  /** Total prophecies that landed on chain settle_tx_hash. */
  totalSettled: number;
  /** Pending = published, has on_chain_id, not yet settled. */
  totalPending: number;
  /** Total successful x402 consultations. */
  totalConsults: number;
  /** Total bond-pool refunds dispatched after broken prophecies. */
  totalRefunds: number;
  /** Total WCSPR refunded back to petitioners, in atomic motes. */
  totalRefundedMotes: string;
  /** Total quorum-gated chain actions (publish + propose + approve + settle
   *  + record_outcome + receipt + refund). */
  totalChainActions: number;
}

export async function getPantheonStats(): Promise<PantheonStats> {
  const [row] = (await sql`
    WITH p AS (
      SELECT
        COUNT(*) FILTER (
          WHERE settle_tx_hash IS NOT NULL
        )::int AS settled,
        COUNT(*) FILTER (
          WHERE settled_at IS NULL AND on_chain_id IS NOT NULL
        )::int AS pending,
        COUNT(*) FILTER (WHERE tx_hash IS NOT NULL)::int AS pub,
        COUNT(*) FILTER (WHERE propose_tx_hash IS NOT NULL)::int AS prop,
        COUNT(*) FILTER (WHERE approve_tx_hash IS NOT NULL)::int AS appr,
        COUNT(*) FILTER (
          WHERE reputation_tx_hash IS NOT NULL
            AND reputation_tx_hash != 'backfilled-pre-tier-0-review'
        )::int AS rep
      FROM prophecies
    ),
    c AS (
      SELECT
        COUNT(*) FILTER (WHERE payment_tx_hash IS NOT NULL)::int AS consult,
        COUNT(*) FILTER (WHERE receipt_tx_hash IS NOT NULL)::int AS receipt,
        COUNT(*) FILTER (WHERE refund_tx_hash IS NOT NULL)::int AS refund,
        COALESCE(SUM(refund_amount) FILTER (WHERE refund_amount IS NOT NULL), 0)::text AS refunded
      FROM consultations
    )
    SELECT
      p.settled,
      p.pending,
      c.consult,
      c.refund,
      c.refunded,
      (p.pub + p.prop + p.appr + p.settled + p.rep + c.consult + c.receipt + c.refund)::int AS actions
    FROM p, c;
  `) as unknown as Array<{
    settled: number;
    pending: number;
    consult: number;
    refund: number;
    refunded: string;
    actions: number;
  }>;
  return {
    totalSettled: row.settled,
    totalPending: row.pending,
    totalConsults: row.consult,
    totalRefunds: row.refund,
    totalRefundedMotes: row.refunded,
    totalChainActions: row.actions,
  };
}
