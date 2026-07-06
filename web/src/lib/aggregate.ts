// Cross-pantheon aggregates. Single query that returns the headline numbers
// across all three gods, computed off the DB tables we already maintain.

import sql from "./db";

export interface PantheonStats {
  /** Total prophecies that landed on chain settle_tx_hash. */
  totalSettled: number;
  /** Pending = published, has on_chain_id/spec, not yet settled. */
  totalPending: number;
  /** On-chain publishes from before settlement specs were persisted. */
  totalLegacyBlocked: number;
  /** Total successful x402 consultations. */
  totalConsults: number;
  /** Total bond-pool refunds dispatched after broken prophecies. */
  totalRefunds: number;
  /** Total WCSPR refunded back to petitioners, in atomic motes. */
  totalRefundedMotes: string;
  /** Total quorum-gated chain actions (publish + propose + approve + settle
   *  + reputation outcome + receipt + refund). */
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
          WHERE settled_at IS NULL
            AND on_chain_id IS NOT NULL
            AND settlement_feed IS NOT NULL
            AND settlement_comparator IS NOT NULL
            AND settlement_threshold IS NOT NULL
        )::int AS pending,
        COUNT(*) FILTER (
          WHERE settled_at IS NULL
            AND on_chain_id IS NOT NULL
            AND (
              settlement_feed IS NULL
              OR settlement_comparator IS NULL
              OR settlement_threshold IS NULL
            )
        )::int AS legacy_blocked,
        COUNT(*) FILTER (WHERE tx_hash IS NOT NULL)::int AS pub,
        COUNT(*) FILTER (WHERE propose_tx_hash IS NOT NULL)::int AS prop,
        COUNT(*) FILTER (WHERE approve_tx_hash IS NOT NULL)::int AS appr,
        COUNT(*) FILTER (
          WHERE reputation_tx_hash IS NOT NULL
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
      p.legacy_blocked,
      c.consult,
      c.refund,
      c.refunded,
      (p.pub + p.prop + p.appr + p.settled + p.rep + c.consult + c.receipt + c.refund)::int AS actions
    FROM p, c;
  `) as unknown as Array<{
    settled: number;
    pending: number;
    legacy_blocked: number;
    consult: number;
    refund: number;
    refunded: string;
    actions: number;
  }>;
  return {
    totalSettled: row.settled,
    totalPending: row.pending,
    totalLegacyBlocked: row.legacy_blocked,
    totalConsults: row.consult,
    totalRefunds: row.refund,
    totalRefundedMotes: row.refunded,
    totalChainActions: row.actions,
  };
}
