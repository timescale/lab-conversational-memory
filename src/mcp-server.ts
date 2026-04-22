import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import postgres from "postgres";
import { embed } from "./memory.ts";

const RRF_K = 60;

const TABLE = process.env.MEMORY_TABLE ?? "memory";
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

// ---------------------------------------------------------------------------
// me_memory_search — matches memory-engine interface
// ---------------------------------------------------------------------------

server.tool(
  "me_memory_search",
  `Search memories. Modes: semantic, fulltext, or combinations. grep is an optional regex filter — it MUST be combined with semantic and/or fulltext (never alone). Use grep with | for synonym expansion: grep "car|truck|vehicle|auto" + semantic "driving" finds ALL driving mentions.`,
  {
    semantic: z.string().nullable().describe("Natural language query for semantic/meaning search"),
    fulltext: z.string().nullable().describe("Keywords/phrases for BM25 exact matching"),
    grep: z.string().nullable().describe("Regex pattern (case-insensitive). Use | for OR synonyms. Returns ALL matches."),
    meta: z.record(z.unknown()).nullable().describe("Filter by metadata attributes (null to omit)"),
    tree: z.string().nullable().describe("Filter by tree path. Bare path matches exactly — use path.* for descendants."),
    temporal: z.object({
      contains: z.string().nullable().describe("Find memories containing this point in time"),
      overlaps: z.object({
        start: z.string().describe("Start of range"),
        end: z.string().describe("End of range"),
      }).nullable().describe("Find memories overlapping this range"),
      within: z.object({
        start: z.string().describe("Start of range"),
        end: z.string().describe("End of range"),
      }).nullable().describe("Find memories fully within this range"),
    }).nullable().describe("Temporal filter for search (null to omit)"),
    weights: z.object({
      fulltext: z.number().min(0).max(1).nullable().describe("Weight for BM25 keyword matching (0-1)"),
      semantic: z.number().min(0).max(1).nullable().describe("Weight for semantic similarity (0-1)"),
    }).nullable().describe("Weights for hybrid search ranking (null to omit)"),
    candidateLimit: z.number().int().min(0).max(1000).describe("Candidates per search mode before RRF fusion (0 = default 60)"),
    limit: z.number().int().min(0).max(1000).describe("Maximum results (0 = default 15)"),
    order_by: z.enum(["asc", "desc"]).nullable().describe("Sort direction for filter-only searches. Default: desc"),
  },
  async (params) => {
    const candidateLimit = params.candidateLimit || 60;
    const limit = params.limit || 15;
    const wSemantic = params.weights?.semantic ?? 1.0;
    const wFulltext = params.weights?.fulltext ?? 1.0;

    // Build WHERE clauses for filters
    const filters: string[] = [];
    const filterValues: unknown[] = [];
    let paramIdx = 1;

    if (params.tree) {
      // Support ltree patterns: bare path = exact, *.foo.* = lquery, foo & bar = ltxtquery
      if (params.tree.includes("*")) {
        filters.push(`tree ~ $${paramIdx}::lquery`);
      } else {
        filters.push(`tree <@ $${paramIdx}::ltree`);
      }
      filterValues.push(params.tree);
      paramIdx++;
    }

    if (params.meta) {
      filters.push(`meta @> $${paramIdx}::jsonb`);
      filterValues.push(JSON.stringify(params.meta));
      paramIdx++;
    }

    if (params.temporal) {
      if (params.temporal.contains != null) {
        filters.push(`temporal @> $${paramIdx}::timestamptz`);
        filterValues.push(params.temporal.contains);
        paramIdx++;
      }
      if (params.temporal.overlaps) {
        filters.push(`temporal && tstzrange($${paramIdx}::timestamptz, $${paramIdx + 1}::timestamptz)`);
        filterValues.push(params.temporal.overlaps.start, params.temporal.overlaps.end);
        paramIdx += 2;
      }
      if (params.temporal.within) {
        filters.push(`temporal <@ tstzrange($${paramIdx}::timestamptz, $${paramIdx + 1}::timestamptz)`);
        filterValues.push(params.temporal.within.start, params.temporal.within.end);
        paramIdx += 2;
      }
    }

    // Grep acts as an additional filter — combines with semantic/fulltext or works standalone
    const hasGrep = params.grep && params.grep.length > 0;
    if (hasGrep) {
      filters.push(`content ~* $${paramIdx}`);
      filterValues.push(params.grep);
      paramIdx++;
    }

    const filterClause = filters.length > 0 ? " AND " + filters.join(" AND ") : "";

    // Determine search mode
    const hasSemantic = params.semantic && params.semantic.length > 0;
    const hasFulltext = params.fulltext && params.fulltext.length > 0;

    // Grep must be combined with semantic or fulltext
    if (hasGrep && !hasSemantic && !hasFulltext) {
      return { content: [{ type: "text" as const, text: "Error: grep must be combined with semantic and/or fulltext search. grep is a filter, not a standalone search mode. Add a semantic or fulltext query." }] };
    }

    let results: Array<{ id: string; content: string; meta: Record<string, unknown>; temporal: string | null; tree: string | null; score: number }>;

    if (hasSemantic || hasFulltext) {
      // Search mode: run BM25 and/or semantic, fuse with RRF
      const bm25Results: Array<{ id: string }> = [];
      const semanticResults: Array<{ id: string }> = [];

      if (hasFulltext) {
        const bm25 = await sql.unsafe<Array<{ id: string }>>(
          `SELECT id FROM ${TABLE}
           WHERE content <@> to_bm25query($1, '${TABLE}_content_bm25_idx') < 0${filterClause}
           ORDER BY -(content <@> to_bm25query($1, '${TABLE}_content_bm25_idx')) DESC, created_at DESC
           LIMIT $2`,
          [params.fulltext, candidateLimit, ...filterValues],
        );
        bm25Results.push(...bm25);
      }

      if (hasSemantic) {
        const [queryEmbedding] = await embed([params.semantic!]);
        const vec = `[${queryEmbedding!.join(",")}]`;
        const sem = await sql.unsafe<Array<{ id: string }>>(
          `SELECT id FROM ${TABLE}
           WHERE embedding IS NOT NULL
             AND (embedding <=> $1::halfvec) < 1.0${filterClause}
           ORDER BY (embedding <=> $1::halfvec) ASC, created_at DESC
           LIMIT $2`,
          [vec, candidateLimit, ...filterValues],
        );
        semanticResults.push(...sem);
      }

      // RRF fusion
      const scores = new Map<string, number>();
      bm25Results.forEach((r, i) => {
        scores.set(r.id, (scores.get(r.id) ?? 0) + wFulltext / (RRF_K + i + 1));
      });
      semanticResults.forEach((r, i) => {
        scores.set(r.id, (scores.get(r.id) ?? 0) + wSemantic / (RRF_K + i + 1));
      });

      const topIds = Array.from(scores.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([id, score]) => ({ id, score }));

      if (topIds.length === 0) {
        return { content: [{ type: "text" as const, text: "No results found." }] };
      }

      const rows = await sql.unsafe<Array<{ id: string; content: string; meta: Record<string, unknown>; temporal: string | null; tree: string | null }>>(
        `SELECT id, content, meta, temporal::text, tree::text FROM ${TABLE} WHERE id = ANY($1::uuid[])`,
        [topIds.map((r) => r.id)],
      );

      const rowMap = new Map(rows.map((r) => [r.id, r]));
      results = topIds.map((t) => {
        const row = rowMap.get(t.id);
        if (!row) return null;
        return { ...row, score: t.score };
      }).filter(Boolean) as typeof results;
    } else {
      // Filter-only mode
      const orderDir = params.order_by ?? "desc";
      const rows = await sql.unsafe<Array<{ id: string; content: string; meta: Record<string, unknown>; temporal: string | null; tree: string | null }>>(
        `SELECT id, content, meta, temporal::text, tree::text FROM ${TABLE}
         WHERE true${filterClause}
         ORDER BY created_at ${orderDir === "asc" ? "ASC" : "DESC"}
         LIMIT $1`,
        [limit, ...filterValues],
      );
      results = rows.map((r) => ({ ...r, score: 0 }));
    }

    // Format as concise lines: date + content + id
    const lines = results.map((r, i) => {
      const date = formatDate(r.temporal);
      const datePrefix = date ? `[${date}] ` : "";
      return `${i + 1}. ${datePrefix}${r.content} (id: ${r.id})`;
    });

    // Collect dia_ids for eval recall tracking
    const diaIds = results.map((r) => r.meta?.dia_id).filter(Boolean);

    return {
      content: [
        { type: "text" as const, text: lines.length > 0 ? lines.join("\n") : "No results found." },
        ...(diaIds.length > 0 ? [{ type: "text" as const, text: `<!--evidence:${JSON.stringify(diaIds)}-->` }] : []),
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// me_memory_get — matches memory-engine interface
// ---------------------------------------------------------------------------

server.tool(
  "me_memory_get",
  `Retrieve a single memory by its ID with surrounding conversation context.

Returns the memory content, date, and adjacent turns. Use window to control how many prev/next turns to include (default 1). Increase window for more context.`,
  {
    id: z.string().describe("The UUID of the memory"),
    window: z.number().int().min(0).max(10).describe("Number of prev/next turns to include (default 2)").default(2),
  },
  async ({ id, window: windowSize }) => {
    const rows = await sql.unsafe<Array<Record<string, unknown>>>(
      `SELECT id, content, meta, temporal::text, tree::text
       FROM ${TABLE} WHERE id = $1::uuid`,
      [id],
    );
    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "Memory not found" }] };
    }
    const row = rows[0]!;
    const meta = row.meta as Record<string, unknown>;

    const diaIds: string[] = [];
    const prevLines: string[] = [];
    const nextLines: string[] = [];

    // Walk backwards through prev chain
    let currentId = meta.prev_id as string | undefined;
    for (let i = 0; i < windowSize && currentId; i++) {
      const [prev] = await sql.unsafe(`SELECT id, content, meta, temporal::text FROM ${TABLE} WHERE id = $1::uuid`, [currentId]);
      if (!prev) break;
      const date = formatDate(prev.temporal as string | null);
      const prevMeta = prev.meta as Record<string, unknown>;
      prevLines.unshift(`[prev${windowSize > 1 ? ` -${i + 1}` : ""}] ${date ? `[${date}] ` : ""}${prev.content} (id: ${prev.id})`);
      if (prevMeta.dia_id) diaIds.push(prevMeta.dia_id as string);
      currentId = prevMeta.prev_id as string | undefined;
    }

    // Current memory
    const date = formatDate(row.temporal as string | null);
    const currentLine = `[this] ${date ? `[${date}] ` : ""}${row.content} (id: ${row.id})`;
    if (meta.dia_id) diaIds.push(meta.dia_id as string);

    // Walk forwards through next chain
    currentId = meta.next_id as string | undefined;
    for (let i = 0; i < windowSize && currentId; i++) {
      const [next] = await sql.unsafe(`SELECT id, content, meta, temporal::text FROM ${TABLE} WHERE id = $1::uuid`, [currentId]);
      if (!next) break;
      const date = formatDate(next.temporal as string | null);
      const nextMeta = next.meta as Record<string, unknown>;
      nextLines.push(`[next${windowSize > 1 ? ` +${i + 1}` : ""}] ${date ? `[${date}] ` : ""}${next.content} (id: ${next.id})`);
      if (nextMeta.dia_id) diaIds.push(nextMeta.dia_id as string);
      currentId = nextMeta.next_id as string | undefined;
    }

    const lines = [...prevLines, currentLine, ...nextLines];

    return {
      content: [
        { type: "text" as const, text: lines.join("\n") },
        ...(diaIds.length > 0 ? [{ type: "text" as const, text: `<!--evidence:${JSON.stringify(diaIds)}-->` }] : []),
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// me_memory_tree — matches memory-engine interface
// ---------------------------------------------------------------------------

server.tool(
  "me_memory_tree",
  `View the hierarchical tree structure of memories with counts at each node.

Shows how memories are organized and how many exist at each level. Use to understand the overall shape of stored knowledge before searching.`,
  {
    tree: z.string().nullable().describe("Root path to display from (e.g., conv.s1). Null for full tree"),
    levels: z.number().int().min(0).max(100).describe("Maximum depth to display (0 = unlimited)"),
  },
  async ({ tree, levels }) => {
    const maxLevels = levels || 100;
    let rows;
    if (tree) {
      rows = await sql.unsafe(
        `SELECT subpath(tree, 0, nlevel($1::ltree) + $2) as path,
                count(*)::int as count
         FROM ${TABLE}
         WHERE tree <@ $1::ltree
         GROUP BY path
         ORDER BY path`,
        [tree, maxLevels],
      );
    } else {
      rows = await sql.unsafe(
        `SELECT subpath(tree, 0, $1) as path,
                count(*)::int as count
         FROM ${TABLE}
         GROUP BY path
         ORDER BY path`,
        [maxLevels],
      );
    }
    const nodes = rows.map((r) => ({ path: r.path, count: r.count }));
    return { content: [{ type: "text" as const, text: JSON.stringify({ nodes }, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
