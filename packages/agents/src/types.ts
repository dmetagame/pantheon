export type GodId = "demeter" | "hermes" | "apollo";

export interface God {
  id: GodId;
  name: string;
  title: string;
  domain: string;
  voice: string;
  systemPrompt: string;
  cadenceCron: string;
}

export interface Prophecy {
  id: string;
  godId: GodId;
  question: string;
  claim: "yes" | "no";
  confidence: number;
  reasoning: string;
  publishedAt: Date;
  settlesAt: Date;
  outcome?: ProphecyOutcome;
}

export interface ProphecyOutcome {
  truth: "yes" | "no";
  brierScore: number;
  settledAt: Date;
  source: string;
}
