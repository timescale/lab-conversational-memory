// =============================================================================
// AUTORESEARCH: This is the file the agent modifies.
//
// Two main functions to iterate on:
//   ingest()   — how conversations become memory rows
//   retrieve() — how questions find relevant context
//
// Everything here (embedding, helpers, constants) is fair game.
// =============================================================================

import type { Sql, LoCoMoSample, ParsedSession } from "./types.ts";
import { parseSessions } from "./types.ts";

// -- Config ------------------------------------------------------------------

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_BATCH_SIZE = 2048;
const RETRIEVAL_LIMIT = 10;
const CANDIDATE_LIMIT = 30;
const RRF_K = 60;
const WEIGHTS = { semantic: 1.0, fulltext: 1.0 };

// -- Embedding ---------------------------------------------------------------

export async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required");

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    });
    if (!res.ok) {
      throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    for (const item of data.data) {
      allEmbeddings.push(item.embedding);
    }
  }

  return allEmbeddings;
}

// -- Date Parsing ------------------------------------------------------------

/**
 * Parse LoCoMo date strings like "1:56 pm on 8 May, 2023"
 */
function parseLocomoDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  // Strip "on " and commas, then try native Date parsing
  const cleaned = dateStr.replace(/\bon\s+/gi, "").replace(/,/g, "");
  const d = new Date(cleaned);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function formatTemporal(date: Date): string {
  const iso = date.toISOString();
  return `[${iso},${iso}]`;
}

// -- Ingestion ---------------------------------------------------------------

export async function ingest(
  sample: LoCoMoSample,
  sql: Sql,
): Promise<void> {
  const sessions = parseSessions(sample.conversation);

  // Build rows
  const rows: Array<{
    content: string;
    meta: Record<string, unknown>;
    tree: string;
    temporal: string | null;
  }> = [];

  for (const session of sessions) {
    const sessionDate = parseLocomoDate(session.dateTime);
    const temporal = sessionDate ? formatTemporal(sessionDate) : null;

    for (let i = 0; i < session.turns.length; i++) {
      const turn = session.turns[i]!;
      const content = `${turn.speaker}: ${turn.text}`;

      const meta: Record<string, unknown> = {
        speaker: turn.speaker,
        session_num: session.sessionNum,
        turn_index: i,
        dia_id: turn.dia_id,
        sample_id: sample.sample_id,
      };
      if (turn.blip_caption) {
        meta.blip_caption = turn.blip_caption;
      }

      // ltree labels: alphanumeric + underscore, no leading digit
      const tree = `conv.s${session.sessionNum}`;

      rows.push({ content, meta, tree, temporal });
    }
  }

  if (rows.length === 0) return;

  // Batch embed
  const contents = rows.map((r) => r.content);
  console.log(`  Embedding ${contents.length} memories...`);
  const embeddings = await embed(contents);

  // Batch insert via transactions (sql.json handles jsonb correctly)
  console.log(`  Inserting ${rows.length} memories...`);
  const BATCH = 100;
  for (let b = 0; b < rows.length; b += BATCH) {
    const end = Math.min(b + BATCH, rows.length);
    await sql.begin(async (tx) => {
      for (let i = b; i < end; i++) {
        const row = rows[i]!;
        const vec = `[${embeddings[i]!.join(",")}]`;
        await tx`
          INSERT INTO memory (content, meta, tree, temporal, embedding)
          VALUES (
            ${row.content},
            ${sql.json(row.meta)},
            ${row.tree}::ltree,
            ${row.temporal}::tstzrange,
            ${vec}::halfvec
          )
        `;
      }
    });
  }
}

// -- RRF Fusion --------------------------------------------------------------

interface RankedResult {
  id: string;
  score: number;
}

function rrfFusion(
  bm25Results: Array<{ id: string }>,
  semanticResults: Array<{ id: string }>,
  k: number,
  weights: { fulltext: number; semantic: number },
): RankedResult[] {
  const scores = new Map<string, number>();

  bm25Results.forEach((result, index) => {
    const rank = index + 1;
    const score = weights.fulltext / (k + rank);
    scores.set(result.id, (scores.get(result.id) ?? 0) + score);
  });

  semanticResults.forEach((result, index) => {
    const rank = index + 1;
    const score = weights.semantic / (k + rank);
    scores.set(result.id, (scores.get(result.id) ?? 0) + score);
  });

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// -- Retrieval ---------------------------------------------------------------

export async function retrieve(
  question: string,
  sql: Sql,
): Promise<string> {
  const [queryEmbedding] = await embed([question]);
  const vec = `[${queryEmbedding!.join(",")}]`;

  // Run BM25 and semantic search in parallel
  const [bm25Results, semanticResults] = await Promise.all([
    sql.unsafe<Array<{ id: string; content: string; score: number }>>(
      `SELECT id, content,
              -(content <@> to_bm25query($1, 'memory_content_bm25_idx')) as score
       FROM memory
       WHERE content <@> to_bm25query($1, 'memory_content_bm25_idx') < 0
       ORDER BY score DESC, created_at DESC
       LIMIT $2`,
      [question, CANDIDATE_LIMIT],
    ),
    sql.unsafe<Array<{ id: string; content: string; score: number }>>(
      `SELECT id, content,
              (1 - (embedding <=> $1::halfvec)) as score
       FROM memory
       WHERE embedding IS NOT NULL
         AND (embedding <=> $1::halfvec) < 1.0
       ORDER BY score DESC, created_at DESC
       LIMIT $2`,
      [vec, CANDIDATE_LIMIT],
    ),
  ]);

  // Fuse with RRF
  const fused = rrfFusion(bm25Results, semanticResults, RRF_K, WEIGHTS);
  const topIds = fused.slice(0, RETRIEVAL_LIMIT).map((r) => r.id);

  if (topIds.length === 0) return "(no relevant memories found)";

  // Fetch full content + temporal for top results, preserving RRF rank order
  const rows = await sql.unsafe<Array<{ id: string; content: string; temporal: string | null }>>(
    `SELECT id, content, temporal::text FROM memory WHERE id = ANY($1::uuid[])`,
    [topIds],
  );

  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const lines = topIds
    .map((id, i) => {
      const row = rowMap.get(id);
      if (!row) return "";
      // Extract date from temporal range like ["2023-05-07 ...","2023-05-07 ..."]
      let datePrefix = "";
      if (row.temporal) {
        const m = row.temporal.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) {
          const d = new Date(m[1]!);
          datePrefix = `[${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}] `;
        }
      }
      return `${i + 1}. ${datePrefix}${row.content}`;
    })
    .filter((line) => line.length > 3);

  return lines.join("\n");
}

// -- Prompt ------------------------------------------------------------------

export function buildPrompt(
  question: string,
  context: string,
  category: number,
): string {
  // Tool mode: no pre-retrieved context, Claude searches via MCP tools
  if (!context) {
    const base = `You have access to memory tools. Use me_memory_search to find relevant conversation memories, then answer the question. You can use me_memory_get to retrieve a specific memory by ID for more detail. Use at most 3 tool calls total. If the information is not available, say "no information available".

IMPORTANT: Your final answer must be ONLY a short phrase — no explanations, no reasoning, no markdown. Just the answer itself.

`;
    if (category === 2) {
      return `${base}Question: ${question} Answer with a specific date or time period.\nShort answer:`;
    }
    return `${base}Question: ${question}\nShort answer:`;
  }

  // Context mode: pre-retrieved context in prompt
  const base = `Based on the following retrieved memories from a conversation, write an answer in the form of a short phrase for the following question. Answer with exact words from the memories whenever possible. If the information is not available, say "no information available".

Memories:
${context}

`;

  if (category === 2) {
    return `${base}Question: ${question} Use dates from the memories to answer with an approximate date.\nShort answer:`;
  }

  return `${base}Question: ${question}\nShort answer:`;
}
