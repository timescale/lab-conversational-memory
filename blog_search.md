# Achieving SOTA Results on Conversational Memory Using Agentic Search with Postgres running on Tiger Data

Long-term conversational memory — the ability to recall and reason over months of past conversations — is one of the hardest unsolved problems in AI assistants. Most approaches stuff retrieved context into a prompt and hope for the best. We took a different approach: give the AI agent direct access to search tools backed by Postgres, and let it decide how to find what it needs.

The result: **F1=0.665** and **85.1% accuracy** on the LoCoMo benchmark (raw, full 10-sample) with Claude Sonnet, up from the previous F1 state-of-the-art of 0.598 set by Omni-SimpleMem with GPT-4o — achieved with a single Postgres table. Even with the smaller Claude Haiku, we reach F1=0.638 and 75.3% accuracy. The key insight isn't better embeddings or fancier retrieval — it's that an agent with the right search tools outperforms any fixed retrieval pipeline.

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

We ran 45+ experiments over two weeks, one change at a time. A note on how to read the numbers: every experiment was selected on a single conversation (conv-26, ~200 questions), where identical reruns vary by about ±0.04 F1. Adopted changes were then validated on all 10 conversations (1,986 questions) at checkpoints. Unless labeled otherwise, the numbers below come from those full runs, and deltas are paired on the same questions with 95% bootstrap intervals. One identical-config repeat of the full benchmark, run three hours apart, differed by 0.0002 F1, while its individual conversations swung by up to 0.06. That is the whole argument for validating on all ten conversations. The exception is finding 1, where the fixed pipeline was only ever measured on the tuning conversation; those numbers are labeled as such.

### 1. Agentic search beats fixed retrieval

Our first version was a fixed pipeline: embed the question, run hybrid search, stuff the top 10 results into the prompt. On the tuning conversation it peaked at F1 0.481 after adding session dates to the results. The same day, on the same conversation and model, giving the agent a single search tool and letting it decide what to query scored 0.584. That gap of 0.10 is well outside the rerun noise and is the cleanest fixed-versus-agentic comparison we have. The final system scores 0.627 on that conversation.

The agent adapts its strategy per question. For "What has Melanie painted?" it might run:
```
search(semantic="Melanie painted", fulltext="Melanie paint", tree="conv.melanie.*")
```
For "When did Caroline go to the pride parade?" it combines:
```
search(semantic="Caroline pride parade", grep="pride|parade|march")
```

One lesson we learned the hard way: when we swapped the simple tool for the production-matching nine-parameter search schema, F1 on that conversation dropped by 0.09. The agent spent its limited tool budget fetching schemas instead of searching. Tool schema complexity is a first-order variable, and a good part of the program was recovering ground the richer interface had cost.

### 2. Let the agent search as much as it wants

The largest single validated gain came from deleting a constraint. Removing the tool-call cap (previously six) moved full-benchmark F1 from 0.615 to 0.646 with Sonnet, a paired gain of +0.031 (95% CI +0.018 to +0.044). All ten conversations moved in the same direction, from +0.010 to +0.067. Multi-hop rose +0.048 and single-hop +0.042. Adversarial did not move. The agent self-regulates: mean tool calls per question went from 2.7 to 3.2, and the final system averages 3.9 with a median of 3.

### 3. Grep as a filter: a multi-hop gain with an adversarial cost

We added Postgres regex (`~*`) as a search parameter that filters the ranked semantic and full-text results. The agent uses it for synonym expansion on list questions:
```
grep: "painted|drew|art|canvas|sketch"
```

On the full benchmark, the window in which grep shipped shows a trade rather than a free win: multi-hop +0.046 (CI +0.015 to +0.079) and single-hop +0.022, against adversarial −0.036 (CI −0.058 to −0.014). Overall F1 moved +0.012, not distinguishable from zero. Grep appears in about half of all searches. Two prompt changes shipped in the same window, one telling the agent it could filter on the facts subtree and one tightening adversarial rejection, so the adversarial cost belongs to the window as a whole. Grep is the largest change in it and the one that most increases what the agent retrieves.

We also found a bug worth knowing about: 13% of searches used grep alone, which fell into a filter-only path ordered by insertion time, effectively random. Grep-only searches now return an error and must combine with a ranked mode. That share dropped below 1%.

### 4. Tree paths, image captions, and context windows: real together, not separable

Four changes shipped between two full-benchmark checkpoints, along with the grep-only fix above: speaker-first tree paths, a case fix to them, image captions, and a wider context window.

- **Speaker-first tree paths.** Memories are organized as `conv.{speaker}.s{N}`, and the agent may filter with `tree: "conv.melanie.*"`. We had prohibited speaker filtering to protect adversarial accuracy; with the attribution prompt in place the prohibition was no longer needed. A silent bug mattered more than the design: the agent wrote `conv.Melanie.*` while paths are lowercase, so 30 of 42 filters matched nothing until the prompt said "speaker is lowercase". On the full benchmark the filter is used in 10% of searches.
- **Image captions.** LoCoMo turns include shared images with `blip_caption` descriptions, stored in metadata and invisible to search. Appending them to the content made 1,226 turns searchable for the first time.
- **Context windows on `me_memory_get`.** The tool returns surrounding turns. We tested windows of 1, 2, and 3 on the tuning conversation; the differences were inside the noise floor, and we settled on 2 as a design choice.

Together these moved full-benchmark F1 by +0.024 with Haiku (CI +0.010 to +0.039), and adversarial held at 0.887 to 0.893 on 441 questions. Which of the five carried the gain is not knowable from our data. On the tuning conversation the same bundle looked like +0.061, roughly the 3x inflation you should expect from selecting changes on one conversation.

### 5. Facts are useless (for this task)

We had Haiku extract atomic facts per session and stored them alongside raw turns. A clean ablation on the tuning conversation showed no difference. On the full benchmark, the run without facts scored 0.642 against 0.641 for the last run with them, with a paired interval spanning zero. That comparison also absorbed two other changes, including removing a category hint from the prompt that we expected to cost F1, so the safe statement is that dropping facts did not lower F1. Facts added about 50% to ingestion time and diluted search results, so we removed extraction entirely.

### 6. Multi-hop: iterative search improves recall, not yet F1

Multi-hop is our weakest category. Inspecting the zero-recall failures in the full run showed that 15 of 38 stopped after one or two searches. We added a prompt instruction to decompose multi-fact questions into sub-queries and let each search inform the next.

On the full benchmark with Sonnet, multi-hop recall rose from 0.592 to 0.651 (error-corrected; the paired interval on all questions is +0.028 to +0.092), temporal recall also rose, and the number of multi-hop questions with zero recall fell from 38 to 26 of 282. F1 did not move. The mechanism is less clear than we first thought: average tool calls on multi-hop questions barely changed (4.0 to 4.2), so the gain appears to come from different queries rather than more of them, and an ingestion change that made image queries searchable shipped in the same run.

### 7. Adversarial is the binding constraint, and we paid for our gains with it

The pattern that recurred throughout: any change that made the model more willing to answer, or added more retrievable content, hurt adversarial rejection. A blanket instruction to infer from available evidence collapsed adversarial on the tuning conversation. Three-turn sliding-window memories, per-speaker profile memories, and "use exact words from the memories" all hurt it, the last one catastrophically. Most were reverted for that reason alone. The one inference change that survived was narrow, limited to questions phrased as "might," "would," or "could," and it held adversarial on the full benchmark.

The full-benchmark trajectory shows the cost we did accept. From the first 10-sample checkpoint to the final Sonnet run, overall F1 rose +0.050 (CI +0.035 to +0.065): multi-hop +0.105, single-hop +0.079, temporal +0.062. Adversarial fell from 0.922 to 0.870 (CI −0.076 to −0.027). Anyone scoring without adversarial would have seen only the gains. That is the strongest argument we know for keeping it in the metric.

### 8. What didn't help

Reverted with no signal or negative on the tuning conversation, none validated further: RRF weight tuning, score-based truncation, showing relevance scores to the agent, set-union merging from the Omni-SimpleMem paper, category-aware prompting, semantic-only search for inferential questions, and relative-to-absolute date prompting. Candidate-pool depth had no measurable F1 effect at any setting; we kept 60 candidates and 15 results for recall. A standalone grep tool scored the same as the grep parameter and was dropped to keep a three-tool interface. No fact-extraction variant survived: more thorough extraction, cross-session aggregation, and speaker profiles each hurt, and the base version added nothing on the full benchmark.

### 9. Open-domain has a low ceiling on this benchmark

Analysis of open-domain failures showed that many gold answers are creative inferences never stated in the conversation. "What hobby could Andrew pick up?" expects "install a bird feeder," which appears nowhere in the text. Others require recognizing a location from a shared photo. We reported two benchmark errors in this category where the gold answer is supported by no text or image metadata. Encouraging the model to infer rather than refuse helped a little; the practical limit is the benchmark, not the retrieval system.

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

The fixed retrieval pipeline was measured only on the tuning conversation, where its best configuration reached F1 0.481 and the final agentic system reaches 0.627, both raw. See finding 1.

## The Stack

- **Database**: Postgres (via Tiger Data) with pgvector, pg_textsearch (BM25), ltree
- **Embeddings**: OpenAI text-embedding-3-small (1536d, stored as halfvec)
- **Agent**: Claude Sonnet (or Haiku) via Claude Code CLI with MCP tools
- **Search**: Hybrid semantic + BM25 with RRF fusion, regex grep filter, ltree speaker paths
- **Evaluation**: LoCoMo benchmark with Python scorer (exact match to paper's evaluation.py)

Everything runs through a single Postgres table. No vector database, no separate search service, no graph database. Postgres does it all — vector similarity, BM25, regex, hierarchical paths, and temporal ranges — with one query engine and one set of indexes.

We run on a [Tiger Data](https://www.tigerdata.com) PostgreSQL instance for two reasons: the ability to fork a database for running experiments quickly, and the fact that it's one of the only hosted providers offering [pg_textsearch](https://github.com/timescale/pg_textsearch), which enables true BM25 scoring as a native Postgres index.

## What's Next

Multi-hop remains the weakest category (F1=0.485 with Sonnet). We improved multi-hop recall from 0.592 to 0.651 by prompting the agent to do iterative follow-up searches — decomposing multi-fact questions into sub-queries instead of stopping after one broad search. But there's still headroom: 13% of multi-hop questions have zero recall (no evidence retrieved at all).

Open-domain (F1=0.441) is limited by the benchmark itself — many gold answers are creative inferences never stated in the conversation, or require image understanding from shared photos. We identified and reported several benchmark errors where gold answers (e.g., "Voyageurs National Park") aren't supported by any text or image metadata in the data.

We also haven't optimized the embedding model, experimented with re-ranking, or tried query expansion at the retrieval level. The agentic approach opens up possibilities that fixed pipelines can't explore — the agent can learn to use tools in ways we haven't anticipated.

The code and full experiment log (45+ experiments with per-category breakdowns) are available in the repository.
