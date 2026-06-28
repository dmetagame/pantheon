import sql from "./db";
import { GODS, type GodId } from "@pantheon/agents";

export interface ConsultationRow {
  id: number;
  god_id: GodId;
  question: string;
  answer: string;
  paid_amount_usdc: string | null;
  payment_tx_hash: string | null;
  petitioner: string | null;
  receipt_tx_hash: string | null;
  receipt_id_hex: string | null;
  refund_tx_hash: string | null;
  refund_amount: string | null;
  refund_prophecy_id: string | null;
  created_at: Date;
}

/**
 * Recent consultations for a single god (newest first). Cap matches the
 * prophecy feed for visual symmetry.
 */
export async function getRecentConsultations(
  godId: GodId,
  limit = 10,
): Promise<ConsultationRow[]> {
  if (!(godId in GODS)) return [];
  return (await sql`
    SELECT id, god_id, question, answer, paid_amount_usdc, payment_tx_hash,
           petitioner, receipt_tx_hash, receipt_id_hex,
           refund_tx_hash, refund_amount, refund_prophecy_id, created_at
    FROM consultations
    WHERE god_id = ${godId}
    ORDER BY created_at DESC
    LIMIT ${limit};
  `) as unknown as ConsultationRow[];
}
