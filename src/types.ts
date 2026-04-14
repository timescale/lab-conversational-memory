import type postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// LoCoMo dataset types
// ---------------------------------------------------------------------------

export interface Turn {
  speaker: string;
  text: string;
  dia_id: string;
  blip_caption?: string;
  img_url?: string[];
  query?: string;
}

export interface QAPair {
  question: string;
  answer: string;
  category: number;
  evidence: string[];
  adversarial_answer?: string;
}

/**
 * A LoCoMo conversation uses dynamic keys:
 *   session_1, session_2, ...           → Turn[]
 *   session_1_date_time, ...            → string
 *   speaker_a, speaker_b                → string
 */
export interface LoCoMoConversation {
  [key: string]: unknown;
}

export interface LoCoMoSample {
  sample_id: string;
  conversation: LoCoMoConversation;
  qa: QAPair[];
  observation?: unknown;
  session_summary?: unknown;
  event_summary?: unknown;
}

// ---------------------------------------------------------------------------
// Parsed session (extracted from dynamic keys)
// ---------------------------------------------------------------------------

export interface ParsedSession {
  sessionNum: number;
  dateTime: string;
  turns: Turn[];
}

export function parseSessions(conv: LoCoMoConversation): ParsedSession[] {
  const sessions: ParsedSession[] = [];
  const sessionNums = Object.keys(conv)
    .filter((k) => /^session_\d+$/.test(k))
    .map((k) => Number.parseInt(k.split("_")[1]!))
    .sort((a, b) => a - b);

  for (const num of sessionNums) {
    const turns = conv[`session_${num}`] as Turn[] | undefined;
    const dateTime = conv[`session_${num}_date_time`] as string | undefined;
    if (turns) {
      sessions.push({ sessionNum: num, dateTime: dateTime ?? "", turns });
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Eval result types
// ---------------------------------------------------------------------------

export const CATEGORY_NAMES: Record<number, string> = {
  1: "multi-hop",
  2: "temporal",
  3: "open-domain",
  4: "single-hop",
  5: "adversarial",
};

export interface QAResult {
  sampleId: string;
  question: string;
  answer: string;
  prediction: string;
  category: number;
  f1: number;
  em: number;
  recall: number;
  context: string;
}

export interface EvalRun {
  timestamp: string;
  samples: number;
  totalQA: number;
  overallF1: number;
  overallEM: number;
  byCategory: Record<number, { count: number; f1: number; em: number }>;
  bySample: Record<string, { count: number; f1: number; em: number }>;
  description: string;
  results: QAResult[];
}
