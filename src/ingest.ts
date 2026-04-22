// Pre-ingest all LoCoMo conversations into per-sample tables.
// Run once after setup, or after changing ingestion in memory.ts.
//
// Usage: bun run ingest              # all 10 samples
//        bun run ingest --sample-id conv-26  # single sample
//        bun run ingest --force      # re-ingest even if tables exist

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { ingest } from "./memory.ts";
import type { LoCoMoSample } from "./types.ts";

export function tableNameForSample(sampleId: string): string {
  return `memory_${sampleId.replace(/-/g, "_")}`;
}

async function createTable(sql: ReturnType<typeof postgres>, tableName: string): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      content    text NOT NULL,
      meta       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object'),
      tree       ltree NOT NULL DEFAULT '',
      temporal   tstzrange,
      embedding  halfvec(1536),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz
    )
  `);
  await sql.unsafe(`
    DO $$ BEGIN
      ALTER TABLE ${tableName} ADD CONSTRAINT ${tableName}_temporal_bounds CHECK (
        temporal IS NULL
        OR (lower(temporal) = upper(temporal) AND lower_inc(temporal) AND upper_inc(temporal))
        OR (lower(temporal) < upper(temporal) AND lower_inc(temporal) AND NOT upper_inc(temporal))
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS ${tableName}_embedding_hnsw_idx
      ON ${tableName} USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS ${tableName}_content_bm25_idx
      ON ${tableName} USING bm25 (content)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS ${tableName}_meta_gin_idx ON ${tableName} USING gin (meta)`,
  );
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS ${tableName}_tree_gist_idx ON ${tableName} USING gist (tree)`,
  );
  await sql.unsafe(
    `CREATE INDEX IF NOT EXISTS ${tableName}_temporal_gist_idx ON ${tableName} USING gist (temporal) WHERE temporal IS NOT NULL`,
  );
}

function parseArgs() {
  const args = process.argv.slice(2);
  let sampleId: string | null = null;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sample-id" && args[i + 1]) {
      sampleId = args[i + 1]!;
      i++;
    } else if (args[i] === "--force") {
      force = true;
    }
  }

  return { sampleId, force };
}

async function main() {
  const { sampleId, force } = parseArgs();

  const dataset: LoCoMoSample[] = JSON.parse(
    readFileSync("data/locomo10.json", "utf-8"),
  );
  const samples = sampleId
    ? dataset.filter((d) => d.sample_id === sampleId)
    : dataset;

  if (samples.length === 0) {
    console.error(`No samples found${sampleId ? ` for ${sampleId}` : ""}`);
    process.exit(1);
  }

  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });

  for (const sample of samples) {
    const tableName = tableNameForSample(sample.sample_id);
    console.log(`--- ${sample.sample_id} → ${tableName} ---`);

    // Check if already populated
    await createTable(sql, tableName);
    const [row] = await sql.unsafe(`SELECT count(*)::int as count FROM ${tableName}`);
    if (row!.count > 0 && !force) {
      console.log(`  Already has ${row!.count} rows (use --force to re-ingest)`);
      continue;
    }

    // Truncate and ingest
    const t0 = performance.now();
    await sql.unsafe(`TRUNCATE ${tableName}`);
    await ingest(sample, sql, tableName);
    const [finalRow] = await sql.unsafe(`SELECT count(*)::int as count FROM ${tableName}`);
    console.log(`  ${finalRow!.count} memories stored (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
