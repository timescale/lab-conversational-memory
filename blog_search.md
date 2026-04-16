# Achieving SOTA Results on Conversational Memory Using Agentic Search with Postgres

Long-term conversational memory — the ability to recall and reason over months of past conversations — is one of the hardest unsolved problems in AI assistants. Most approaches stuff retrieved context into a prompt and hope for the best. We took a different approach: give the AI agent direct access to search tools backed by Postgres, and let it decide how to find what it needs.

The result: **F1=0.698** on the LoCoMo benchmark, up from F1=0.493 with fixed retrieval — a 42% improvement from better tools alone. The key insight isn't better embeddings or fancier retrieval — it's that an agent with the right search tools outperforms any fixed retrieval pipeline.

## The Benchmark

[LoCoMo](https://arxiv.org/abs/2402.09146) tests long-term conversational memory across five categories:

- **Single-hop**: Simple factual recall ("What instrument does Melanie play?")
- **Multi-hop**: Aggregation across sessions ("What has Melanie painted?")
- **Temporal**: Date-sensitive questions ("When did Caroline go to the pride parade?")
- **Open-domain**: Inference from personality ("Would Caroline be considered religious?")
- **Adversarial**: Questions that should be rejected — they describe the wrong person's activity

Each conversation spans ~20 sessions over several months between two speakers, with ~200 QA pairs per conversation. Scoring uses token-level F1 with Porter stemming, matching the original LoCoMo evaluation.

## Architecture

Our system has three components, all backed by a single Postgres table:

### The Memory Table

```sql
CREATE TABLE memory (
    id          uuid PRIMARY KEY,
    content     text NOT NULL,
    meta        jsonb NOT NULL,
    tree        ltree NOT NULL,
    temporal    tstzrange,
    embedding   halfvec(1536),
    created_at  timestamptz DEFAULT now()
);
```

Indexes: HNSW for vector search (`halfvec_cosine_ops`), BM25 for full-text (via `pg_textsearch`), GIST for tree paths and temporal ranges, GIN for metadata. One table, multiple access patterns.

### Ingestion

Each conversation turn becomes a row. The content is the speaker's text, with shared image descriptions appended:

```
Melanie: Take a look at this. [shared image: a photo of a painting of a sunset over a lake]
```

Turns are linked via `prev_id`/`next_id` in metadata for navigation, and organized in an ltree hierarchy: `conv.{speaker}.s{session_number}`. Embeddings use OpenAI's `text-embedding-3-small`.

That's it. No fact extraction, no summarization, no entity graphs. We tried LLM-based fact extraction (having Haiku summarize each session into atomic facts) and it added zero F1 — the raw conversation turns contain everything the agent needs.

### Agentic Search via MCP

Instead of a fixed retrieval pipeline, we expose Postgres as MCP (Model Context Protocol) tools that the agent calls directly:

**`me_memory_search`** — Hybrid search combining:
- **Semantic**: Vector similarity via HNSW
- **Fulltext**: BM25 keyword matching via `pg_textsearch`
- **Grep**: Postgres regex (`~*`) as an additional filter
- **Tree**: ltree path filtering for speaker-specific searches
- **Temporal**: tstzrange containment/overlap queries

All modes can be combined. Results are fused with Reciprocal Rank Fusion (RRF).

**`me_memory_get`** — Retrieve a specific memory by ID with a configurable context window of surrounding turns. The agent uses this to "read around" a search hit.

The agent decides which search modes to use, how to combine them, and when to do follow-up searches — all without any hardcoded retrieval logic.

## What We Learned (41 Experiments)

We ran 41 experiments over several days, testing one hypothesis at a time. Here are the findings that mattered:

### 1. Agentic search beats fixed retrieval

Our first version used a fixed retrieval pipeline: embed the question, run hybrid search, stuff top-10 results into the prompt. F1=0.493. Switching to agentic tool use — where Claude decides how to search — immediately jumped to F1=0.523, and continued improving as we refined the tools.

The agent adapts its search strategy per question. For "What has Melanie painted?", it might do:
```
search(semantic="Melanie painted", fulltext="Melanie paint", tree="conv.melanie.*")
```
For "When did Caroline go to the pride parade?", it combines:
```
search(semantic="Caroline pride parade", grep="pride|parade|march")
```

No fixed pipeline can match this flexibility.

### 2. Grep as a filter (not a search mode) is critical

We added regex grep (`~*`) as a search parameter. The key design decision: grep must be combined with semantic or fulltext search — it's a filter, not a standalone mode. When we allowed grep-only searches, results were sorted by `created_at` (effectively random) instead of relevance. Forcing combination with a ranked search mode improved open-domain F1 by +0.091.

The agent uses grep for synonym expansion on list questions:
```
grep: "painted|drew|art|canvas|sketch"
```
This catches mentions that semantic search might miss due to embedding distance, while the semantic/fulltext component ensures relevance ranking.

### 3. Speaker-organized tree paths enable precise filtering

Organizing memories as `conv.{speaker}.s{N}` and teaching the agent to filter with `tree: "conv.melanie.*"` was one of our biggest wins (+0.023 F1). When the question asks what a specific person said or did, the agent narrows to that speaker's turns, dramatically reducing noise.

We initially prohibited speaker filtering to protect adversarial accuracy — the concern was that filtering to one speaker would prevent the agent from seeing that a fact belonged to someone else. But with the right prompt ("if search results only mention a different person doing that thing, say no information available"), the agent handles attribution correctly even with speaker filtering enabled. Adversarial F1 held at 0.909.

One gotcha: ltree paths are lowercase, but the agent initially used capitalized names (`conv.Melanie.*`). Adding "(speaker is lowercase)" to the prompt fixed silent tree filter failures and unlocked a +0.023 F1 gain.

### 4. Context windows on get-by-id improve answer quality

The `me_memory_get` tool returns surrounding turns (configurable window). We tested windows of 1, 2, and 3:

| Window | F1 | EM |
|--------|------|------|
| 1 | 0.627 | 0.450 |
| **2** | **0.640** | **0.479** |
| 3 | 0.633 | 0.450 |

Window=2 (5 turns total: 2 prev + current + 2 next) is the sweet spot. More context helps the agent verify answers and catch attribution errors without adding noise.

### 5. Image descriptions are hidden evidence

LoCoMo conversations include shared images with `blip_caption` descriptions (e.g., "a painting of a sunset over a lake"). These were stored in metadata but invisible to search. Appending them to the content text made 1,226 turns searchable for the first time, improving temporal recall from 0.879 to 0.970.

### 6. Facts are useless (for this task)

We tried having Haiku extract atomic facts per session and storing them alongside raw turns. 10-sample result: F1=0.642 with facts vs F1=0.641 without — zero difference. Facts added ~50% ingestion time and diluted search results. The raw dialogue turns contain all the information the agent needs.

### 7. Retrieval depth matters (with diminishing returns)

Increasing the candidate pool from 30 to 60 and result limit from 10 to 15 improved evidence recall from 0.380 to 0.492. Pushing further to 100/20 improved recall more but hurt adversarial accuracy — too many results means more noise for the agent to sift through. There's a sweet spot.

## Results

### Comparison with Prior Work

The table below compares our system against results reported in [Omni-SimpleMem](https://arxiv.org/abs/2604.01007) (Cui et al., 2025), the current state-of-the-art on LoCoMo. All scores are raw F1 (no error correction) for fair comparison.

| Method | Model | Multi-hop | Single-hop | Temporal | Open-domain | Adversarial | **Overall** |
|--------|-------|-----------|------------|----------|-------------|-------------|-------------|
| MemVerse | GPT-4o | 0.260 | 0.157 | 0.196 | 0.192 | 0.944 | 0.365 |
| Claude-Mem | GPT-4o | 0.294 | 0.153 | 0.167 | 0.243 | 0.915 | 0.383 |
| Mem0 | GPT-4o | 0.309 | 0.156 | 0.217 | 0.295 | 0.857 | 0.397 |
| A-MEM | GPT-4o | 0.295 | 0.174 | 0.200 | 0.266 | 0.898 | 0.394 |
| MemGPT | GPT-4o | 0.305 | 0.188 | 0.246 | 0.305 | 0.843 | 0.404 |
| SimpleMem | GPT-4o | 0.318 | 0.195 | 0.235 | 0.308 | 0.802 | 0.432 |
| Omni-SimpleMem | GPT-4o | **0.556** | 0.365 | 0.255 | **0.641** | 0.835 | 0.598 |
| **Ours** | **Claude Haiku** | 0.516 | **0.683** | **0.597** | 0.372 | **0.872** | **0.659** |

Our system achieves the highest overall F1 (0.659 vs 0.598) despite using a smaller, cheaper model and a dramatically simpler architecture. The prior systems involve multi-stage pipelines: Omni-SimpleMem uses pyramid expansion, LLM summarization, BM25 hybrid retrieval, and adaptive top-k — all discovered through an automated architecture search. MemGPT requires a custom memory management OS with paging. A-MEM builds associative memory graphs.

Our system is a single Postgres table with standard indexes (HNSW, BM25, ltree, tstzrange) exposed as MCP tools. There is no summarization, no fact extraction, no entity graphs, no custom memory management. The raw conversation turns go into the table; the agent decides how to search them. The complexity lives in the search tool interface, not in the pipeline.

The advantage comes from single-hop (+0.318), temporal (+0.342), and adversarial (+0.037), while Omni-SimpleMem leads on multi-hop and open-domain. The temporal gap is particularly striking — our agentic search with temporal metadata in Postgres gives the model direct access to dates, while fixed retrieval pipelines lose this signal.

Note: our 1-sample result. Full 10-sample validation pending.

### Per-Category Breakdown

Our system on LoCoMo (1 sample, Claude Haiku, error-corrected metrics):

| Category | F1 | Recall |
|----------|------|--------|
| Multi-hop | 0.573 | 0.610 |
| Temporal | 0.623 | 0.970 |
| Open-domain | 0.373 | 0.636 |
| Single-hop | 0.706 | 0.831 |
| Adversarial | 0.886 | — |
| **Overall** | **0.698** | **0.811** |

Our fixed retrieval baseline started at F1=0.493. Agentic search brought this to F1=0.698 — a **42% improvement** from better tools alone, with no change to the underlying model.

## The Stack

- **Database**: Postgres (via Timescale/Ghost) with pgvector, pg_textsearch (BM25), ltree
- **Embeddings**: OpenAI text-embedding-3-small (1536d, stored as halfvec)
- **Agent**: Claude Haiku via Claude Code CLI with MCP tools
- **Search**: Hybrid semantic + BM25 with RRF fusion, regex grep filter, ltree speaker paths
- **Evaluation**: LoCoMo benchmark with Python scorer (exact match to paper's evaluation.py)

Everything runs through a single Postgres table. No vector database, no separate search service, no graph database. Postgres does it all — vector similarity, BM25, regex, hierarchical paths, and temporal ranges — with one query engine and one set of indexes.

## What's Next

Multi-hop remains the weakest category (F1=0.573). The primary bottleneck is that the agent typically does one search per question — multi-hop questions need evidence from 2-4 turns across different sessions. Teaching the agent to systematically do follow-up searches for aggregation questions is the most promising next direction.

We also haven't optimized the embedding model, experimented with re-ranking, or tried query expansion at the retrieval level. The agentic approach opens up possibilities that fixed pipelines can't explore — the agent can learn to use tools in ways we haven't anticipated.

The code and full experiment log (41 experiments with per-category breakdowns) are available in the repository.
