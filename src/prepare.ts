import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";

const DATASET_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";
const DATASET_PATH = "data/locomo10.json";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required. Set it in .env");
    process.exit(1);
  }
  if (!openaiKey) {
    console.error("OPENAI_API_KEY is required. Set it in .env");
    process.exit(1);
  }

  // ---- Download dataset ---------------------------------------------------
  if (!existsSync(DATASET_PATH)) {
    console.log("Downloading LoCoMo dataset...");
    mkdirSync("data", { recursive: true });
    const res = await fetch(DATASET_URL);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const text = await res.text();
    writeFileSync(DATASET_PATH, text);
    const data = JSON.parse(text);
    console.log(`Downloaded ${data.length} conversations.`);
  } else {
    console.log("Dataset already exists at", DATASET_PATH);
  }

  // ---- Set up database ----------------------------------------------------
  const sql = postgres(databaseUrl, { onnotice: () => {} });

  console.log("Creating extensions...");
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS ltree");
  await sql.unsafe("CREATE EXTENSION IF NOT EXISTS pg_textsearch");

  console.log("Creating memory table...");
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS memory (
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

  // Temporal bounds convention (matching memory-engine)
  await sql.unsafe(`
    DO $$ BEGIN
      ALTER TABLE memory ADD CONSTRAINT temporal_bounds_convention CHECK (
        temporal IS NULL
        OR (lower(temporal) = upper(temporal) AND lower_inc(temporal) AND upper_inc(temporal))
        OR (lower(temporal) < upper(temporal) AND lower_inc(temporal) AND NOT upper_inc(temporal))
      );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  console.log("Creating indexes...");
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS memory_embedding_hnsw_idx
      ON memory USING hnsw (embedding halfvec_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS memory_content_bm25_idx
      ON memory USING bm25 (content)
      WITH (text_config = 'english', k1 = 1.2, b = 0.75)
  `);
  await sql.unsafe(
    "CREATE INDEX IF NOT EXISTS memory_meta_gin_idx ON memory USING gin (meta)",
  );
  await sql.unsafe(
    "CREATE INDEX IF NOT EXISTS memory_tree_gist_idx ON memory USING gist (tree)",
  );
  await sql.unsafe(
    "CREATE INDEX IF NOT EXISTS memory_temporal_gist_idx ON memory USING gist (temporal) WHERE temporal IS NOT NULL",
  );

  // ---- Verify -------------------------------------------------------------
  const [row] = await sql`SELECT count(*)::int as count FROM memory`;
  console.log(`\nDone. Memory table has ${row!.count} rows.`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
