import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import postgres from "postgres";
import { embed } from "./memory.ts";

const CANDIDATE_LIMIT = 30;
const RETRIEVAL_LIMIT = 10;
const RRF_K = 60;

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

function formatDate(temporal: string | null): string {
  if (!temporal) return "";
  const m = temporal.match(/(\d{4}-\d{2}-\d{2})/);
  if (!m) return "";
  const d = new Date(m[1]!);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const server = new McpServer({
  name: "recall",
  version: "1.0.0",
});

server.tool(
  "search_memories",
  "Search conversation memories using hybrid semantic + keyword search. Returns the most relevant memories ranked by relevance. Use this to find information needed to answer questions.",
  { query: z.string().describe("Natural language search query") },
  async ({ query }) => {
    const [queryEmbedding] = await embed([query]);
    const vec = `[${queryEmbedding!.join(",")}]`;

    const [bm25Results, semanticResults] = await Promise.all([
      sql.unsafe<Array<{ id: string; content: string; score: number }>>(
        `SELECT id, content,
                -(content <@> to_bm25query($1, 'memory_content_bm25_idx')) as score
         FROM memory
         WHERE content <@> to_bm25query($1, 'memory_content_bm25_idx') < 0
         ORDER BY score DESC, created_at DESC
         LIMIT $2`,
        [query, CANDIDATE_LIMIT],
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

    // RRF fusion
    const scores = new Map<string, number>();
    bm25Results.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1.0 / (RRF_K + i + 1));
    });
    semanticResults.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) ?? 0) + 1.0 / (RRF_K + i + 1));
    });
    const topIds = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, RETRIEVAL_LIMIT)
      .map(([id]) => id);

    if (topIds.length === 0) {
      return { content: [{ type: "text" as const, text: "No memories found." }] };
    }

    const rows = await sql.unsafe<Array<{ id: string; content: string; temporal: string | null }>>(
      `SELECT id, content, temporal::text FROM memory WHERE id = ANY($1::uuid[])`,
      [topIds],
    );

    const rowMap = new Map(rows.map((r) => [r.id, r]));
    const lines = topIds.map((id, i) => {
      const row = rowMap.get(id);
      if (!row) return "";
      const date = formatDate(row.temporal);
      const datePrefix = date ? `[${date}] ` : "";
      return `${i + 1}. ${datePrefix}${row.content} (id: ${row.id})`;
    }).filter(Boolean);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
);

server.tool(
  "get_memory_by_id",
  "Retrieve a specific memory by its UUID. Use this to get context around a search result — each memory has prev_id/next_id linking to adjacent conversation turns.",
  { id: z.string().describe("UUID of the memory to retrieve") },
  async ({ id }) => {
    const rows = await sql`
      SELECT id, content, meta, temporal::text, tree::text
      FROM memory WHERE id = ${id}::uuid
    `;
    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "Memory not found" }] };
    }
    const row = rows[0]!;
    const date = formatDate(row.temporal as string | null);
    const meta = row.meta as Record<string, unknown>;

    // Fetch prev/next content inline for convenience
    const neighbors: Record<string, unknown> = {};
    for (const dir of ["prev_id", "next_id"] as const) {
      const nid = meta[dir];
      if (nid) {
        const [n] = await sql`SELECT id, content, temporal::text FROM memory WHERE id = ${nid as string}::uuid`;
        if (n) {
          neighbors[dir] = {
            id: n.id,
            date: formatDate(n.temporal as string | null),
            content: n.content,
          };
        }
      }
    }

    const result = {
      id: row.id,
      date,
      content: row.content,
      speaker: meta.speaker,
      session: meta.session_num,
      prev: neighbors.prev_id ?? null,
      next: neighbors.next_id ?? null,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
