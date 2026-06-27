import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { consult, get } from "./api";

const GOD_IDS = ["demeter", "hermes", "apollo"] as const;
const STATUSES = ["pending", "settled", "fulfilled", "broken"] as const;

interface ScoreboardResponse {
  gods: Array<{
    id: string;
    name: string;
    title: string;
    domain: string;
    reputationBp: number;
    prophecies_settled: number;
    prophecies_pending: number;
    last_prophecy_at: string | null;
  }>;
}

interface GodDetailResponse {
  stats: ScoreboardResponse["gods"][number];
  voice: string;
  allowedFeeds: readonly string[];
  recent: Array<{
    id: number;
    on_chain_id: string | null;
    tx_hash: string | null;
    question: string;
    claim: boolean;
    confidence_bp: number;
    reasoning: string;
    published_at: string;
    settles_at: string;
    settled_at: string | null;
    truth: boolean | null;
    brier_bp: number | null;
    source_value: string | null;
    settle_tx_hash: string | null;
    settlement_feed: string | null;
    settlement_comparator: string | null;
    settlement_threshold: string | null;
  }>;
}

function json(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "pantheon",
    version: "0.1.0",
  });

  server.tool(
    "list_pantheon",
    "List the AI gods in the Pantheon with their current on-chain reputation and " +
      "tally of settled vs. pending prophecies. Use this to choose which god to consult.",
    {},
    async () => {
      const data = await get<ScoreboardResponse>("/api/scoreboard");
      return json(data.gods);
    },
  );

  server.tool(
    "get_god",
    "Fetch a single god's full profile — voice, domain, allowed price feeds, and " +
      "the 20 most recent prophecies with on-chain ids, settlement specs, and Brier " +
      "scores where settled. Use this before consulting a god or to inspect track record.",
    {
      godId: z.enum(GOD_IDS).describe("Which god to fetch."),
    },
    async ({ godId }) => {
      const data = await get<GodDetailResponse>(`/api/god/${godId}`);
      return json(data);
    },
  );

  server.tool(
    "recent_prophecies",
    "List recent prophecies across the Pantheon, optionally filtered by god and/or " +
      "lifecycle status. Useful for surveying what the gods have been saying lately.",
    {
      godId: z
        .enum(GOD_IDS)
        .optional()
        .describe("Restrict to one god. Omit to see all three."),
      status: z
        .enum(STATUSES)
        .optional()
        .describe(
          "pending = not yet settled; settled = any outcome; fulfilled = claim " +
            "matched truth; broken = claim contradicted truth.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max rows to return (default 20)."),
    },
    async ({ godId, status, limit }) => {
      const ids = godId ? [godId] : GOD_IDS;
      const cap = limit ?? 20;
      const all: GodDetailResponse["recent"] = [];
      for (const id of ids) {
        const data = await get<GodDetailResponse>(`/api/god/${id}`);
        for (const p of data.recent) {
          if (matchesStatus(p, status)) {
            all.push({ ...p, ...{ god_id: id } } as typeof p);
          }
        }
      }
      all.sort((a, b) => b.published_at.localeCompare(a.published_at));
      return json(all.slice(0, cap));
    },
  );

  server.tool(
    "consult_god",
    "Ask a specific god a question. The server's consult endpoint follows the " +
      "x402 payment-required pattern: without an authorized offering it returns " +
      "the accepts envelope describing the required USDC tithe. With " +
      "PANTHEON_CONSULT_SECRET set, this MCP server uses the demo bearer in lieu " +
      "of an on-chain payment (the verification rail is hackathon-stubbed).",
    {
      godId: z.enum(GOD_IDS),
      question: z
        .string()
        .min(1)
        .max(500)
        .describe("Your question for the god. One sentence works best."),
    },
    async ({ godId, question }) => {
      const result = await consult(godId, question);
      if ("status" in result && result.status === 402) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `The gates of consult are closed. The temple demands an offering:\n\n` +
                JSON.stringify(result, null, 2),
            },
          ],
          isError: true,
        };
      }
      return json(result);
    },
  );

  return server;
}

function matchesStatus(
  p: GodDetailResponse["recent"][number],
  status: (typeof STATUSES)[number] | undefined,
): boolean {
  if (!status) return true;
  const settled = p.settled_at !== null && p.truth !== null;
  if (status === "pending") return !settled;
  if (status === "settled") return settled;
  if (status === "fulfilled") return settled && p.truth === p.claim;
  if (status === "broken") return settled && p.truth !== p.claim;
  return true;
}
