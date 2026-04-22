# Achieving SOTA Results on Conversational Memory Using Agentic Search with Postgres running on Ghost

Long-term conversational memory — the ability to recall and reason over months of past conversations — is one of the hardest unsolved problems in AI assistants. Most approaches stuff retrieved context into a prompt and hope for the best. We took a different approach: give the AI agent direct access to search tools backed by Postgres, and let it decide how to find what it needs.

The result: **F1=0.665** on the LoCoMo benchmark (raw, full 10-sample) with Claude Sonnet, up from the previous state-of-the-art of F1=0.598 set by Omni-SimpleMem with GPT-4o — achieved with a single Postgres table. Even with the smaller Claude Haiku, we reach F1=0.638. The key insight isn't better embeddings or fancier retrieval — it's that an agent with the right search tools outperforms any fixed retrieval pipeline.

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

## What We Learned (45+ Experiments)

We ran 45+ experiments over several days, testing one hypothesis at a time. Here are the findings that mattered:

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

### 8. Multi-hop needs iterative search, not broader search

Multi-hop was our weakest category. Analysis of recall=0 failures revealed the pattern: 10 of 26 failures gave up after just 1-2 searches, and 23 of 26 repeated the same query verbatim instead of reformulating. The agent wasn't decomposing multi-hop questions into sub-queries.

Prompting the model to "search for each sub-topic separately, use results from one search to guide the next, and do at least 3 searches for multi-fact questions" improved multi-hop recall from 0.592 to 0.651 (+10%) with no regression in other categories. The key insight: multi-hop doesn't need more results per search — it needs more searches with different queries, each informed by what the previous search found.

### 9. Open-domain has a low ceiling on this benchmark

Deep analysis of open-domain failures (the weakest non-adversarial category) revealed that many gold answers are creative inferences never stated in the conversation — "What hobby could Andrew pick up?" expects "install a bird feeder," which appears nowhere in the text. Others require recognizing locations from shared photos (e.g., identifying a trail map image as a specific national park). We identified several benchmark errors in this category.

The practical limit for open-domain is the benchmark itself, not the retrieval system. We improved open-domain accuracy by encouraging the model to make inferences rather than defaulting to "no information available," but diminishing returns set in quickly.

## Comparison with Prior Work

Our system achieves the highest F1 score on LoCoMo among all systems evaluated with rigorous, deterministic metrics — F1=0.665 raw with Sonnet, surpassing Omni-SimpleMem's F1=0.598 with GPT-4o. F1 scoring (token-level overlap with stemming) is reproducible and comparable across papers without ambiguity.

Several recent systems report only LLM-as-judge accuracy, which we believe has three methodological problems:

1. **Judge variance is massive and underspecified.** We found 18 percentage points of spread in overall accuracy from changing only the judge model and prompt (see our analysis below). Most papers don't disclose their exact judge prompt, and some don't even name the judge model — making cross-paper comparison meaningless.
2. **Dropping adversarial removes the hallucination guardrail.** Most papers exclude 446 adversarial questions from scoring. These questions test whether a system correctly rejects unanswerable queries. Without them, you can boost accuracy on other categories by prompting the model to guess aggressively — inflating numbers while increasing hallucinations in production.
3. **The benchmark has ~8% error rate, yet systems report 90%+ accuracy.** We identified 164 questions (8.3%) with wrong gold answers, unsupported citations, or answers requiring image understanding from photos with no text equivalent. Any system claiming above ~91% accuracy is partly measuring agreement with benchmark noise.

Nonetheless, we include these numbers for completeness and find our system competitive even on this metric — despite using a single Postgres table with no graphs, no summarization, and no specialized memory management.

### F1 Scores

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
| **Ours** | **Claude Haiku** | 0.420 | 0.645 | 0.567 | 0.311 | 0.883 | 0.638 |
| **Ours** | **Claude Sonnet** | 0.453 | **0.673** | **0.625** | 0.400 | **0.870** | **0.665** |

Our system achieves the highest overall F1 (0.665 with Sonnet, 0.638 with Haiku) vs 0.598 for Omni-SimpleMem, despite a dramatically simpler architecture. The prior systems involve multi-stage pipelines: Omni-SimpleMem uses pyramid expansion, LLM summarization, BM25 hybrid retrieval, and adaptive top-k — all discovered through an automated architecture search. MemGPT requires a custom memory management OS with paging. A-MEM builds associative memory graphs.

Our system is a single Postgres table with standard indexes (HNSW, BM25, ltree, tstzrange) exposed as MCP tools. There is no summarization, no fact extraction, no entity graphs, no custom memory management. The raw conversation turns go into the table; the agent decides how to search them. The complexity lives in the search tool interface, not in the pipeline.

The advantage comes from single-hop (+0.308), temporal (+0.370), and adversarial (+0.035), while Omni-SimpleMem leads on multi-hop and open-domain. The temporal gap is particularly striking — our agentic search with temporal metadata in Postgres gives the model direct access to dates, while fixed retrieval pipelines lose this signal.

### LLM-as-Judge Accuracy

#### A Warning on Reliability

Recent work has moved toward LLM-as-judge accuracy as the primary LoCoMo metric, following [Mem0](https://arxiv.org/abs/2504.19413) (Chhikara et al., 2025). A judge model (typically GPT-4o-mini) compares the generated answer against the gold answer with generous grading — "as long as it touches on the same topic, count it as CORRECT." This captures semantic equivalence that F1 misses (e.g., "May 7th" vs "7 May 2023").

However, these numbers should be compared with caution. We ran the same set of predictions (Sonnet, full 10-sample) through four different judge configurations — varying only the judge model and prompt — and found massive variance:

| Judge / Prompt | Multi-hop | Single-hop | Temporal | Open-domain | **Overall (w/o Adv)** |
|----------------|-----------|------------|----------|-------------|----------------------|
| Haiku / Prompt A | 45.0 | 77.2 | 65.7 | 49.0 | 67.1 |
| Haiku / Prompt B | 55.0 | 87.3 | 77.6 | 64.6 | 77.9 |
| GPT-4o-mini / Prompt A | 46.5 | 79.8 | 75.1 | 51.0 | 70.9 |
| GPT-4o-mini / Prompt B | 79.8 | 90.6 | 82.2 | 62.5 | 85.1 |

Same predictions, same gold answers — **18 percentage points of spread** in overall accuracy depending on judge configuration. Multi-hop swings by **35 points**. The only stable category is adversarial (1 point spread), since it's a binary match/reject that doesn't require semantic judgment.

Prompt A is a neutral evaluation prompt ("decide whether the ground-truth content is present in the model's response"). Prompt B is the Mem0/APEX-MEM generous grading prompt ("as long as it touches on the same topic, count it as CORRECT"). The prompt matters more than the judge model — Prompt B with either judge model produces 8-15 points higher accuracy than Prompt A with the same model.

This means cross-paper accuracy comparisons are unreliable unless, at the very least, the exact same judge model, prompt, and temperature are used. A 5-point accuracy difference between two systems could easily be an artifact of different judge configurations rather than a real capability gap. F1, while imperfect (it penalizes valid paraphrases), is at least deterministic and reproducible.

With that caveat, here is how we compare using Prompt B with GPT-4o-mini (matching the Mem0 evaluation framework used by most recent papers):

#### Comparison Table

Most papers exclude adversarial questions (446 of 1,986) from accuracy scoring. We report both. This matters: adversarial questions act as a guardrail against prompt tuning that inflates other categories. It's easy to boost multi-hop or open-domain accuracy by encouraging the model to guess — but this increases hallucinations on adversarial questions where the correct answer is "no information available." Excluding adversarial from scoring removes this check.

| Method | Model | Judge | Judge Prompt | Multi-hop | Single-hop | Temporal | Open-domain | Adversarial | **Overall (w/o Adv)** | **Overall (w/ Adv)** |
|--------|-------|-------|--------------|-----------|------------|----------|-------------|-------------|----------------------|---------------------|
| Mem0 | GPT-4o | GPT-4o-mini | Mem0 | — | — | — | — | — | 68.4 | — |
| GAAMA | GPT-4o-mini | GPT-4o-mini | fact coverage* | 72.2 | 87.2 | 71.9 | 49.3 | — | 78.9 | — |
| **Ours** | **Claude Haiku** | **GPT-4o-mini** | **Mem0** | 70.9 | 81.3 | 72.9 | 42.7 | 89.7 | **75.3** | **78.5** |
| APEX-MEM | Claude 4.5 Haiku | undisclosed | undisclosed | — | — | — | — | — | 84.9 | — |
| **Ours** | **Claude Sonnet** | **GPT-4o-mini** | **Mem0** | **79.8** | **90.6** | **82.2** | 62.5 | **88.6** | **85.1** | **85.9** |
| APEX-MEM | Claude 4.5 Sonnet | undisclosed | undisclosed | — | — | — | — | — | 88.4 | — |
| APEX-MEM | GPT-5 | undisclosed | undisclosed | 86.3 | 89.9 | 90.6 | **91.7** | 86.8 | 89.5 | 88.9 |
| MemMachine | GPT-4.1-mini | GPT-4o-mini | Mem0 | 88.3 | 95.1 | 91.6 | 71.9 | — | 91.7 | — |
| HyperMem | GPT-4.1-mini | GPT-4o-mini | Mem0 | **93.6** | **96.1** | **89.7** | 70.8 | — | **92.7** | — |

\* GAAMA uses a continuous key fact coverage score rather than binary CORRECT/WRONG, so its numbers are not directly comparable.

All numbers in the table above are raw (no error correction) for fair comparison against other systems. However, we identified errors in 8.3% of LoCoMo questions (164 of 1,986) — wrong gold answers, unsupported citations, or answers requiring image understanding from photos with no text equivalent. We are confident there are more. This means any system reporting above ~91% accuracy is likely being evaluated partly on benchmark noise rather than genuine capability. Results at that level should be interpreted with caution.

Our system is competitive with dedicated memory architectures while using a dramatically simpler design. With Claude Sonnet, we reach 85.1% — between APEX-MEM's Haiku (84.9%) and Sonnet (88.4%) results, despite having no graph structures, no summarization pipelines, and no specialized memory management.

## Our Per-Category Breakdown

Our system on LoCoMo (full 10 samples, error-corrected metrics). We exclude 164 questions with benchmark errors — wrong gold answers, unsupported evidence citations, or gold answers that require image understanding from photos not available as text (e.g., "Voyageurs National Park" as the answer when no text or metadata contains the park name). The initial error list comes from the [LoCoMo Audit](https://github.com/dial481/locomo-audit); we [added our own corrections](https://github.com/timescale/autoresearch_convo/blob/main/harness/data/adversarial-errors.json), primarily on adversarial questions. These are excluded below to measure system performance rather than benchmark noise:

| Category | Haiku F1 | Sonnet F1 | Sonnet Acc | Sonnet Recall |
|----------|----------|-----------|------------|---------------|
| Multi-hop | 0.445 | 0.485 | 0.825 | 0.651 |
| Temporal | 0.581 | 0.648 | 0.860 | 0.916 |
| Open-domain | 0.328 | 0.441 | 0.679 | 0.555 |
| Single-hop | 0.670 | 0.696 | 0.932 | 0.883 |
| Adversarial | 0.893 | 0.880 | 0.896 | — |
| **Overall** | **0.666** | **0.694** | **0.887** | **0.831** |

Our fixed retrieval baseline started at F1=0.493. Agentic search brought this to F1=0.694 with Sonnet — a **41% improvement** from better tools alone, with no change to the underlying architecture.

## The Stack

- **Database**: Postgres (via Timescale/Ghost) with pgvector, pg_textsearch (BM25), ltree
- **Embeddings**: OpenAI text-embedding-3-small (1536d, stored as halfvec)
- **Agent**: Claude Sonnet (or Haiku) via Claude Code CLI with MCP tools
- **Search**: Hybrid semantic + BM25 with RRF fusion, regex grep filter, ltree speaker paths
- **Evaluation**: LoCoMo benchmark with Python scorer (exact match to paper's evaluation.py)

Everything runs through a single Postgres table. No vector database, no separate search service, no graph database. Postgres does it all — vector similarity, BM25, regex, hierarchical paths, and temporal ranges — with one query engine and one set of indexes.

We run on a [Ghost](https://ghost.build) PostgreSQL instance for two reasons: a generous free tier that makes running these experiments easy and free, and the fact that it's one of the only hosted providers offering [pg_textsearch](https://github.com/timescale/pg_textsearch), which enables true BM25 scoring as a native Postgres index.

## What's Next

Multi-hop remains the weakest category (F1=0.485 with Sonnet). We improved multi-hop recall from 0.592 to 0.651 by prompting the agent to do iterative follow-up searches — decomposing multi-fact questions into sub-queries instead of stopping after one broad search. But there's still headroom: 13% of multi-hop questions have zero recall (no evidence retrieved at all).

Open-domain (F1=0.441) is limited by the benchmark itself — many gold answers are creative inferences never stated in the conversation, or require image understanding from shared photos. We identified and reported several benchmark errors where gold answers (e.g., "Voyageurs National Park") aren't supported by any text or image metadata in the data.

We also haven't optimized the embedding model, experimented with re-ranking, or tried query expansion at the retrieval level. The agentic approach opens up possibilities that fixed pipelines can't explore — the agent can learn to use tools in ways we haven't anticipated.

The code and full experiment log (45+ experiments with per-category breakdowns) are available in the repository.
