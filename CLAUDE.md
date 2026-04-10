# Autoresearch Memory

An autoresearch harness for improving long-term conversational memory, evaluated against the LoCoMo benchmark.

## Quick Start

```bash
bun install
bun run setup          # download dataset + create DB schema (run once)
bun run eval:quick     # evaluate on 2 samples (fast iteration)
bun run eval           # evaluate on all 10 samples (full run)
```

## Architecture (Autoresearch Pattern)

- `src/memory.ts` — **THE ONLY FILE YOU MODIFY.** Contains `ingest()` and `retrieve()`.
- Everything else is fixed infrastructure. Do not modify other source files.
- Read `program.md` for research instructions and experiment ideas.

## Workflow

1. Read `program.md` and `results/history.jsonl`
2. Modify `src/memory.ts` to improve retrieval
3. Run `bun run eval:quick --desc "what changed"`
4. If F1 improved: `git commit` with scores in the message
5. If F1 regressed: `git checkout src/memory.ts`
6. Repeat

**Always test one experiment at a time.** Do not batch multiple hypotheses into a single eval run. This ensures clean signal on what helped or hurt.

## DB Schema

The `memory` table matches memory-engine's layout:

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, gen_random_uuid() |
| content | text | NOT NULL |
| meta | jsonb | NOT NULL, must be object |
| tree | ltree | NOT NULL, default '' |
| temporal | tstzrange | point `[t,t]` or range `[t,t)` |
| embedding | halfvec(1536) | OpenAI text-embedding-3-small |
| created_at | timestamptz | auto |
| updated_at | timestamptz | nullable |

Indexes: HNSW (halfvec_cosine_ops), BM25 (pg_textsearch), GIN (meta), GIST (tree), GIST (temporal).

You can ALTER TABLE to add columns or indexes if needed.

## Environment

Requires `.env` with:
- `DATABASE_URL` — Ghost Postgres connection string
- `OPENAI_API_KEY` — for embeddings

QA answering uses `claude -p` (Claude Code CLI), so no separate API key needed.

## Results

- `results/history.jsonl` — one-line summary per eval run (scan this first)
- `results/eval-{timestamp}.json` — full per-question details
- Git log — experiment history with scores in commit messages

## Experiment Log

`experimental_log.md` is the detailed record of all experiments. For every experiment, log:
- The hypothesis and what you changed
- Which categories it targets
- Full per-category results table with deltas vs baseline
- Analysis of why it helped or hurt
- The decision (adopted, reverted, or combined with another experiment)

Update the log immediately after each experiment, before moving on to the next one.
