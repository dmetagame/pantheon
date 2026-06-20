/**
 * Seed local DB with realistic-looking prophecies so the frontend has
 * something to render before the real prophesy cron runs.
 *
 *   DATABASE_URL=postgres://... pnpm db:seed
 */
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const sql = postgres(connectionString, {
  ssl: connectionString.includes("neon.tech") ? "require" : undefined,
  max: 1,
});

type Seed = {
  god_id: "demeter" | "hermes" | "apollo";
  question: string;
  claim: boolean;
  confidence_bp: number;
  reasoning: string;
  oracle_source: string;
  ageHours: number;
  settlesInHours: number;
  truth?: boolean;
  source_value?: string;
};

const SEEDS: Seed[] = [
  // Demeter — yields (mostly hits)
  {
    god_id: "demeter",
    question: "Will the USDC-CSPR pool TVL exceed $9M in 24h?",
    claim: true, confidence_bp: 7800,
    reasoning: "Steady inflows from the new Strain harvest. Soil is rich.",
    oracle_source: "cspr.cloud/tvl",
    ageHours: 30, settlesInHours: -6,
    truth: true, source_value: "TVL: $9.4M",
  },
  {
    god_id: "demeter",
    question: "Will Demeter Vault APY drop below 5% this week?",
    claim: false, confidence_bp: 8500,
    reasoning: "No blight on the horizon. Harvest holds steady at 7.2%.",
    oracle_source: "cspr.cloud/tvl",
    ageHours: 96, settlesInHours: -72,
    truth: false, source_value: "APY: 7.1%",
  },
  {
    god_id: "demeter",
    question: "Will any major Casper pool depeg by >1% in 48h?",
    claim: false, confidence_bp: 9000,
    reasoning: "The soil is dry but not cracking. No blight foreseen.",
    oracle_source: "cspr.cloud/tvl",
    ageHours: 2, settlesInHours: 22,
  },

  // Hermes — prices (mixed)
  {
    god_id: "hermes",
    question: "Will BTC close above $99k tomorrow?",
    claim: true, confidence_bp: 6800,
    reasoning: "Funding flat, OI rising. The road runs uphill.",
    oracle_source: "pyth/hermes",
    ageHours: 26, settlesInHours: -2,
    truth: false, source_value: "BTC close: $97,820",
  },
  {
    god_id: "hermes",
    question: "Will ETH outperform BTC by >2% in 24h?",
    claim: true, confidence_bp: 7200,
    reasoning: "Sharper turns ahead — ETH catches the bend first.",
    oracle_source: "pyth/hermes",
    ageHours: 50, settlesInHours: -26,
    truth: true, source_value: "ETH/BTC +3.1%",
  },
  {
    god_id: "hermes",
    question: "Will BTC volatility (IV) drop below 40 today?",
    claim: false, confidence_bp: 7500,
    reasoning: "Storms gather. The runner does not slow.",
    oracle_source: "pyth/hermes",
    ageHours: 1, settlesInHours: 23,
  },

  // Apollo — macro/RWA (calibrated)
  {
    god_id: "apollo",
    question: "Will the US 10Y yield breach 4.40% this week?",
    claim: true, confidence_bp: 7000,
    reasoning: "The tide turns slowly but the long horizon shows ascent.",
    oracle_source: "casper-rwa-oracle",
    ageHours: 24, settlesInHours: 144,
  },
  {
    god_id: "apollo",
    question: "Will RWA-tokenized T-bill AUM rise >$200M this week?",
    claim: true, confidence_bp: 8200,
    reasoning: "Sovereign flows quicken. The tide rises.",
    oracle_source: "casper-rwa-oracle",
    ageHours: 168, settlesInHours: -24,
    truth: true, source_value: "Net inflow: +$340M",
  },
  {
    god_id: "apollo",
    question: "Will gold close above $2,750 by Friday?",
    claim: false, confidence_bp: 6500,
    reasoning: "The tide recedes. Light wanes from the metal.",
    oracle_source: "casper-rwa-oracle",
    ageHours: 6, settlesInHours: 90,
  },
];

function brierBp(claim: boolean, confidenceBp: number, truth: boolean): number {
  const pTruthBp = claim === truth ? confidenceBp : 10_000 - confidenceBp;
  const diff = 10_000 - pTruthBp;
  return Math.floor((diff * diff) / 10_000);
}

async function run() {
  console.log("▸ wiping existing prophecies & consultations...");
  await sql`TRUNCATE prophecies, consultations RESTART IDENTITY;`;

  console.log(`▸ seeding ${SEEDS.length} prophecies...`);
  for (const s of SEEDS) {
    const publishedAt = new Date(Date.now() - s.ageHours * 3600_000);
    const settlesAt = new Date(publishedAt.getTime() + (s.ageHours + s.settlesInHours) * 3600_000);
    const settled = s.truth !== undefined;
    const brier = settled ? brierBp(s.claim, s.confidence_bp, s.truth!) : null;
    await sql`
      INSERT INTO prophecies
        (god_id, question, claim, confidence_bp, reasoning, oracle_source,
         published_at, settles_at, truth, brier_bp, source_value, settled_at)
      VALUES (
        ${s.god_id}, ${s.question}, ${s.claim}, ${s.confidence_bp},
        ${s.reasoning}, ${s.oracle_source},
        ${publishedAt}, ${settlesAt},
        ${s.truth ?? null}, ${brier}, ${s.source_value ?? null},
        ${settled ? settlesAt : null}
      );
    `;
  }

  console.log("✓ seed complete");
  await sql.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
