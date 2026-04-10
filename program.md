# Memory Retrieval Research Program

## Objective

Maximize F1 score on LoCoMo QA benchmark by improving memory ingestion and retrieval in `src/memory.ts`.

## Baseline

- One memory per conversation turn
- Hybrid search: BM25 + semantic cosine similarity, fused with RRF (k=60, equal weights)
- Top-10 results returned as numbered context for Claude
- No metadata filtering, no query rewriting, no reranking

## Workflow

1. Read this file and review `results/history.jsonl` for past experiments
2. Modify `src/memory.ts`
3. Run `bun run eval:quick --desc "what I changed"` (2 samples, fast)
4. If promising, run `bun run eval --desc "what I changed"` (all 10)
5. Compare F1 against previous best
6. If better: commit with `git commit -m "F1=X.XXX EM=X.XXX | description"`
7. If worse: revert with `git checkout src/memory.ts`
8. Repeat

## What You Can Change in memory.ts

### Ingestion (`ingest()`)
- **Chunking**: per-turn (baseline), per-session, sliding window, topic-based
- **Content format**: raw dialog, structured facts, summaries, observations
- **Metadata**: speaker, topics, entities, sentiment → `meta` JSONB
- **Tree paths**: organize by conversation/session, speaker, topic
- **Temporal**: session dates, inferred event timestamps
- **Derived memories**: session summaries, entity profiles, cross-session links

### Retrieval (`retrieve()`)
- **RRF weights**: tune semantic vs fulltext balance
- **candidateLimit**: how many candidates per search mode (default 30)
- **Top-K**: how many final results (default 10)
- **Metadata filters**: scope search by speaker, session, time
- **Query rewriting**: decompose multi-hop questions, expand queries
- **Re-ranking**: use LLM to re-score retrieved results
- **Multi-step**: retrieve, expand context, retrieve again

### Embedding
- **Model**: text-embedding-3-small (baseline), text-embedding-3-large
- **What gets embedded**: raw content, augmented content, summaries

## Constraints

- `memory.ts` must export `ingest(sample, sql)` and `retrieve(question, sql)`
- The memory table schema is fixed (see prepare.ts) — but you can ALTER TABLE to add columns/indexes
- Use the database for storage and search — don't bypass it with in-memory structures
- Keep API costs reasonable

## Ideas to Explore (by expected impact)

### Tier 1: Quick wins
1. **RRF weight tuning** — try semantic=0.7/fulltext=0.3, vice versa
2. **Top-K and candidateLimit tuning** — try k=5, k=15, k=20; candidates=50
3. **Sliding window chunks** — group 2-3 consecutive turns for conversational context
4. **Speaker metadata in content** — format as dialog rather than just "speaker: text"

### Tier 2: Moderate effort
5. **Session summaries** — create additional summary memories per session
6. **Temporal filtering** — use session dates for category-2 (temporal) questions
7. **Tree-based scoping** — use ltree paths to narrow retrieval scope
8. **Observation extraction** — pre-process conversations to extract factual observations

### Tier 3: Advanced
9. **Query decomposition** — break multi-hop questions into sub-queries
10. **LLM reranking** — use Claude to re-score retrieved results before answering
11. **Category-aware retrieval** — detect question type, use different strategies
12. **Entity linking** — track entities across sessions for multi-hop resolution

## Experiment Log

| Run | Timestamp | F1 | EM | Samples | Description |
|-----|-----------|----|----|---------|-------------|
| 1 | | — | — | 2 | Baseline: per-turn + hybrid RRF |
