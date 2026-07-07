// Cross-pantheon activity ledger. Materialises every on-chain action we
// track into a single chronological feed: prophecy publishes, quorum
// proposals, quorum approvals, settlements, reputation outcomes, consult
// settlements, receipts, and slash refunds. Each entry carries a Casper
// tx hash that resolves to testnet.cspr.live.
//
// Implemented as a UNION ALL across prophecies and consultations so the
// page loads from a single round-trip.

import sql from "./db";
import type { GodId } from "@pantheon/agents";

const CASPER_DEPLOY_HASH_RE = "^[0-9a-fA-F]{64}$";

export type LedgerKind =
  | "publish"
  | "propose"
  | "approve"
  | "settle"
  | "reputation"
  | "consult-settle"
  | "consult-receipt"
  | "refund";

export interface LedgerEntry {
  ts: Date;
  god_id: GodId;
  kind: LedgerKind;
  tx_hash: string;
  /** Short human-readable summary specific to the action type. */
  detail: string;
  prophecy_id?: number;
  consult_id?: number;
}

export async function getLedger(limit = 100): Promise<LedgerEntry[]> {
  // Each clause emits (ts, god_id, kind, tx_hash, detail) with NULL fillers
  // for the type-specific id columns; the outer ORDER BY DESC + LIMIT lands a
  // single execution plan against the prophecies + consultations indexes.
  const rows = (await sql`
    SELECT * FROM (
      SELECT published_at AS ts, god_id, 'publish'::text AS kind,
             tx_hash, ('on-chain id ' || on_chain_id) AS detail,
             id AS prophecy_id, NULL::bigint AS consult_id
      FROM prophecies WHERE tx_hash IS NOT NULL

      UNION ALL
      SELECT published_at AS ts, god_id, 'propose'::text,
             propose_tx_hash,
             ('quorum #' || COALESCE(quorum_proposal_id::text, '?')) AS detail,
             id, NULL::bigint
      FROM prophecies WHERE propose_tx_hash IS NOT NULL

      UNION ALL
      SELECT published_at AS ts, god_id, 'approve'::text,
             approve_tx_hash,
             ('quorum #' || COALESCE(quorum_proposal_id::text, '?')) AS detail,
             id, NULL::bigint
      FROM prophecies WHERE approve_tx_hash IS NOT NULL

      UNION ALL
      SELECT settled_at AS ts, god_id, 'settle'::text,
             settle_tx_hash,
             ('truth=' || COALESCE(truth::text, '?') ||
              ' brier=' || COALESCE(brier_bp::text, '?')) AS detail,
             id, NULL::bigint
      FROM prophecies WHERE settle_tx_hash IS NOT NULL

      UNION ALL
      SELECT settled_at AS ts, god_id, 'reputation'::text,
             reputation_tx_hash,
             ('brier ' || COALESCE(brier_bp::text, '?') || ' recorded') AS detail,
             id, NULL::bigint
      FROM prophecies
      WHERE reputation_tx_hash IS NOT NULL

      UNION ALL
      SELECT created_at AS ts, god_id, 'consult-settle'::text,
             payment_tx_hash,
             ('petitioner consulted') AS detail,
             NULL::bigint, id
      FROM consultations WHERE payment_tx_hash IS NOT NULL

      UNION ALL
      SELECT created_at AS ts, god_id, 'consult-receipt'::text,
             receipt_tx_hash,
             ('keccak ' || COALESCE(SUBSTRING(receipt_id_hex FROM 1 FOR 12), '?') || '…') AS detail,
             NULL::bigint, id
      FROM consultations WHERE receipt_tx_hash IS NOT NULL

      UNION ALL
      SELECT created_at AS ts, god_id, 'refund'::text,
             refund_tx_hash,
             ('slash from prophecy #' || COALESCE(refund_prophecy_id::text, '?')) AS detail,
             refund_prophecy_id::int, id
      FROM consultations WHERE refund_tx_hash IS NOT NULL
    ) AS u
    WHERE tx_hash ~ ${CASPER_DEPLOY_HASH_RE}
    ORDER BY ts DESC
    LIMIT ${limit};
  `) as unknown as LedgerEntry[];
  return rows;
}
