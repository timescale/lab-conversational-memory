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
