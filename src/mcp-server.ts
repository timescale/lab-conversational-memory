import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

const server = new McpServer({
  name: "memory",
  version: "1.0.0",
});

server.tool(
  "get_memory_by_id",
  "Retrieve a memory by its UUID. Returns content, date, and metadata including prev_id/next_id for adjacent conversation turns.",
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
    let dateStr = "";
    if (row.temporal) {
      const m = (row.temporal as string).match(/(\d{4}-\d{2}-\d{2})/);
      if (m) {
        const d = new Date(m[1]!);
        dateStr = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      }
    }
    const meta = row.meta as Record<string, unknown>;
    const result = {
      id: row.id,
      date: dateStr,
      content: row.content,
      speaker: meta.speaker,
      session: meta.session_num,
      prev_id: meta.prev_id ?? null,
      next_id: meta.next_id ?? null,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
