# Experiment Log

## Baseline
- **F1=0.392 EM=0.256** (1 sample, 199 QA)
- Per-turn ingestion, hybrid BM25+semantic RRF (k=60, equal weights), top-10

| Cat | Name | F1 | EM | n |
|-----|------|------|------|---|
| 1 | multi-hop | 0.244 | 0.094 | 32 |
| 2 | temporal | 0.098 | 0.000 | 37 |
| 3 | open-domain | 0.342 | 0.154 | 13 |
| 4 | single-hop | 0.445 | 0.214 | 70 |
| 5 | adversarial | 0.660 | 0.660 | 47 |

### Key failure modes
- **Temporal (cat 2)**: Near-total failure. Context has relative phrases ("yesterday", "last week") but no absolute dates. Session dates stored in `temporal` column but never surfaced to Claude.
- **Multi-hop (cat 1)**: Retrieval finds partial evidence but can't connect facts across sessions.
- **Single-hop (cat 4)**: Right neighborhood retrieved but exact fact sometimes missed or diluted.
- **Adversarial (cat 5)**: Already strong. Correctly rejects unanswerable questions.

---

## Exp 1: Inject session dates into ingestion content
- **Hypothesis**: Prepend `[7 May 2023]` to each memory's `content` field at ingestion time so the date is embedded and visible to Claude.
- **Change**: In `ingest()`, added date label prefix to content string.
- **Targets**: Category 2 (temporal) primarily.
- **Result**: F1=0.453 EM=0.251

| Cat | Name | F1 | vs baseline |
|-----|------|------|-------------|
| 1 | multi-hop | 0.278 | +0.034 |
| 2 | temporal | 0.443 | **+0.345** |
| 3 | open-domain | 0.265 | -0.077 |
| 4 | single-hop | 0.463 | +0.018 |
| 5 | adversarial | 0.617 | -0.043 |

- **Analysis**: Huge win on temporal as expected. But open-domain and adversarial regressed — date tokens in the embedding add noise to semantic search, hurting retrieval quality for non-temporal questions.

---

## Exp 3: Inject session dates at retrieval time only
- **Hypothesis**: Keep embeddings clean (no date in content), but when formatting retrieved results for Claude, join the `temporal` column and prepend dates to each line.
- **Change**: In `retrieve()`, SELECT `temporal::text`, parse the date, and prefix each result line with `[7 May 2023]`.
- **Targets**: Category 2 (temporal) primarily.
- **Result**: F1=0.481 EM=0.281

| Cat | Name | F1 | vs baseline |
|-----|------|------|-------------|
| 1 | multi-hop | 0.260 | +0.016 |
| 2 | temporal | 0.459 | **+0.361** |
| 3 | open-domain | 0.297 | -0.045 |
| 4 | single-hop | 0.480 | +0.035 |
| 5 | adversarial | 0.702 | +0.042 |

- **Analysis**: Best result so far. Same temporal boost as exp 1, but better across the board because embeddings stay clean. Adversarial actually improved (likely because cleaner retrieval helps entity distinction). Open-domain slightly down but less than exp 1.

---

## Exp 1+3: Both ingestion and retrieval dates
- **Hypothesis**: Belt-and-suspenders — dates in both the embedding and the output.
- **Change**: Combined exp 1 and exp 3 changes.
- **Result**: F1=0.462 EM=0.251

| Cat | Name | F1 | vs baseline |
|-----|------|------|-------------|
| 1 | multi-hop | 0.292 | +0.048 |
| 2 | temporal | 0.435 | +0.337 |
| 3 | open-domain | 0.362 | +0.020 |
| 4 | single-hop | 0.468 | +0.023 |
| 5 | adversarial | 0.617 | -0.043 |

- **Analysis**: Worse than exp 3 alone. The ingestion-side dates hurt embedding quality (same as exp 1), cancelling out the retrieval-side gains. Redundant date display doesn't help Claude answer better.

---

## Decision
**Adopted exp 3** (retrieve-side date injection only). Best overall F1 at 0.481, +0.089 over baseline. Clean separation: embeddings stay semantic, dates added at presentation time.

---

## Exp 2-MCP: Prev/next linked memories with MCP tool
- **Hypothesis**: Store prev_id/next_id in each memory's metadata linking adjacent turns. Give the QA-answering Claude an MCP tool (`get_memory_by_id`) to fetch neighboring memories on demand. Include memory IDs in retrieved context so Claude can navigate.
- **Changes**: (1) `memory.ts`: client-side UUIDs, prev/next in meta, IDs in retrieve output. (2) New `mcp-server.ts` exposing `get_memory_by_id`. (3) `evaluate.ts`: pass `--mcp-config` and `--allowedTools` to `claude -p`. Moved `buildPrompt` to `memory.ts`.
- **Targets**: Category 1 (multi-hop), category 4 (single-hop).
- **Result**: F1=0.448 EM=0.251

| Cat | Name | F1 | vs exp3 |
|-----|------|------|---------|
| 1 | multi-hop | 0.276 | +0.016 |
| 2 | temporal | 0.418 | -0.041 |
| 3 | open-domain | 0.312 | +0.015 |
| 4 | single-hop | 0.468 | -0.012 |
| 5 | adversarial | 0.596 | -0.106 |

- **Analysis**: Worse than exp 3 alone (0.448 vs 0.481). The tool availability hurt more than it helped. Adversarial dropped significantly (-0.106) — Claude may be using the tool to find supporting evidence for questions it should reject as unanswerable. Temporal also regressed, possibly because tool-call overhead crowds out direct date reading. The ID metadata in the context output adds noise to every result line.
- **Decision**: Infrastructure changes (MCP server, buildPrompt in memory.ts) kept for future use. Need to investigate whether the regression comes from (a) the tool distracting Claude, (b) the verbose ID metadata in context, or (c) reduced answer quality from MCP startup overhead.

---

## Exp 2-MCP control: No tool, no IDs — isolating the regression
- **Hypothesis**: If we remove the MCP tool and IDs from context (making output identical to exp 3), performance should recover to ~0.481. This isolates whether the regression was from the tool or from noise.
- **Changes**: Removed ID/prev/next from context lines, removed tool mention from prompt, removed `--mcp-config` and `--allowedTools` from claude call. Context output is now identical to exp 3.
- **Result**: F1=0.451 EM=0.256

| Cat | Name | F1 | vs exp3 |
|-----|------|------|---------|
| 1 | multi-hop | 0.236 | -0.024 |
| 2 | temporal | 0.436 | -0.023 |
| 3 | open-domain | 0.244 | -0.053 |
| 4 | single-hop | 0.470 | -0.010 |
| 5 | adversarial | 0.638 | -0.064 |

- **Analysis**: Still below exp 3 (0.451 vs 0.481) despite identical context output. Since the only code differences are client-side UUIDs and prev/next stored in meta (neither affects what Claude sees), this ~0.03 gap is likely **run-to-run LLM variance**. This means the exp 2-MCP regression (-0.033 from this control) was partially real (tool distraction) and partially noise.
- **Decision**: Scores have a noise floor of ~0.03 F1. The MCP tool showed a small real negative effect on adversarial questions. Keep infrastructure, revisit tool-use approach when we have a stronger prompt that instructs Claude when to use vs ignore the tool.

---

## Variance test: Re-run exp 3 with identical code
- **Purpose**: Quantify run-to-run LLM variance by re-running the committed exp 3 code with no changes.
- **Result**: F1=0.447 EM=0.251 (vs original exp 3 F1=0.481)

| Cat | Name | F1 (original) | F1 (rerun) | Delta |
|-----|------|---------------|------------|-------|
| 1 | multi-hop | 0.260 | 0.249 | -0.011 |
| 2 | temporal | 0.459 | 0.433 | -0.026 |
| 3 | open-domain | 0.297 | 0.297 | 0.000 |
| 4 | single-hop | 0.480 | 0.446 | -0.034 |
| 5 | adversarial | 0.702 | 0.638 | -0.064 |

- **Analysis**: **0.034 F1 variance** between identical runs. Adversarial shows the most volatility (0.064 swing). This means all exp 2-MCP results (0.448, 0.451) were within noise of exp 3. Only deltas >0.04 should be considered signal.
- **Implication**: Previous experiments exp 1 (+0.061 over baseline) and exp 3 (+0.089 over baseline) are clearly above noise. The MCP tool experiments were inconclusive.
