# Experiment Log

Previous experiments (infrastructure setup, tool mode, prompt tuning) are in [experimental_log_phase1.md](experimental_log_phase1.md). We restarted the log because we established a new realistic baseline using production-matching memory-engine MCP tools.

## Baseline (realistic)

- **F1=0.493 EM=0.322** (1 sample, 199 QA, tool mode, ~160s)
- Eval mode: tool — Claude searches via MCP tools (no pre-retrieved context)
- MCP tools: `me_memory_search`, `me_memory_get`, `me_memory_tree` (matching memory-engine interface)
- Ingestion: per-turn memories with speaker, session metadata, temporal dates
- Prompt: short phrase answer, 3 tool call limit
- Variance: ~0.03-0.04 F1 noise floor between identical runs

| Cat | Name | F1 | EM | n |
|-----|------|------|------|---|
| 1 | multi-hop | 0.222 | 0.031 | 32 |
| 2 | temporal | 0.573 | 0.189 | 37 |
| 3 | open-domain | 0.285 | 0.077 | 13 |
| 4 | single-hop | 0.430 | 0.271 | 70 |
| 5 | adversarial | 0.766 | 0.766 | 47 |

### Key remaining opportunities
- **Multi-hop (0.222)**: Lowest non-adversarial category. Evidence scattered across sessions.
- **Single-hop (0.430)**: Largest category (70q). Claude's search queries sometimes miss the key turn.
- **Open-domain (0.285)**: Small category (13q) but low. Requires inference from context.
- **Temporal (0.573)**: Improved dramatically from original 0.098 baseline but still room to grow.
- **Adversarial (0.766)**: Strong. Claude correctly rejects unanswerable questions.

---

## Exp 1+6: Non-deferred tools + 5 call limit
- **Hypothesis**: ToolSearch wastes 1 of 3 tool calls per question (199/199 questions). Using `--strict-mcp-config` + `--tools` makes our 3 tools non-deferred, eliminating ToolSearch overhead. Raising tool limit from 3 to 5 gives Claude room for follow-up searches and get_memory_by_id.
- **Changes**: evaluate.ts: added `--strict-mcp-config`, `--tools`, `--allowedTools` flags. memory.ts: tool limit 3→5 in prompt.
- **Targets**: All categories via more tool calls; single-hop especially (more follow-up searches).
- **Result**: F1=0.523 EM=0.347 (180s)

| Cat | Name | F1 | vs baseline |
|-----|------|------|-------------|
| 1 | multi-hop | 0.202 | -0.020 |
| 2 | temporal | 0.557 | -0.016 |
| 3 | open-domain | 0.290 | +0.005 |
| 4 | single-hop | **0.531** | **+0.101** |
| 5 | adversarial | 0.766 | 0.000 |

- **Tool usage**: 344 searches (up from 224), 0 ToolSearch calls (down from 199), 67 questions with 2+ searches (up from 18), 2 me_memory_get calls.
- **Analysis**: Single-hop gained +0.101 (clearly above noise). Claude now does follow-up searches instead of giving up after 1 attempt. Multi-hop and temporal slightly down (within noise). The freed-up tool budget is being used for more search attempts.
- **Decision**: **Adopted.** New best F1=0.523.

---

## Exp 4: Concise search result formatting
- **Hypothesis**: MCP search returns verbose JSON (meta, tree, score fields). Simplifying to `"1. [date] content (id: uuid)"` reduces token overhead so Claude parses results faster and more accurately.
- **Changes**: mcp-server.ts: replaced JSON.stringify response with numbered lines showing date + content + id.
- **Targets**: All categories — less noise in tool responses.
- **Result**: F1=0.535 EM=0.372

| Cat | Name | F1 | vs prev |
|-----|------|------|---------|
| 1 | multi-hop | 0.282 | +0.080 |
| 2 | temporal | **0.699** | **+0.142** |
| 3 | open-domain | 0.228 | -0.062 |
| 4 | single-hop | 0.524 | -0.007 |
| 5 | adversarial | 0.681 | -0.085 |

- **Analysis**: Temporal surged +0.142 — dates are now prominently visible in the format `[7 May 2023]` rather than buried in JSON. Multi-hop gained +0.080. Adversarial dipped (within noise). Overall +0.012.
- **Decision**: **Adopted.** F1=0.535.

---

## Exp 9: Reduce false "no information" via prompt
- **Hypothesis**: 38 false "no information available" on answerable questions. Prompting Claude to "answer based on what you find, even if it requires inference" should recover some.
- **Changes**: memory.ts: added inference encouragement, changed "no info" to only when search returns nothing relevant.
- **Result**: F1=0.477 EM=0.307

| Cat | Name | F1 | vs prev |
|-----|------|------|---------|
| 1 | multi-hop | 0.289 | +0.007 |
| 2 | temporal | 0.708 | +0.009 |
| 3 | open-domain | **0.398** | **+0.170** |
| 4 | single-hop | 0.533 | +0.009 |
| 5 | adversarial | **0.362** | **-0.319** |

- **Analysis**: Open-domain surged +0.170 and other non-adversarial categories improved slightly. But adversarial collapsed from 0.681 to 0.362 — Claude now answers questions it should reject. The inference encouragement directly undermines adversarial rejection. Net negative.
- **Decision**: **Reverted.** The adversarial cost (-0.319) far outweighs non-adversarial gains.

---

## Exp 2: 3-turn sliding window chunks
- **Hypothesis**: Multi-hop evidence is fragmented across single turns. Adding 3-turn sliding window memories captures adjacent Q&A pairs and cross-turn context.
- **Changes**: memory.ts: added sliding window loop creating additional memories for every 3 consecutive turns per session (~370 extra memories).
- **Targets**: Cat 1 (multi-hop), cat 4 (single-hop).
- **Result**: F1=0.522 EM=0.327

| Cat | Name | F1 | vs prev |
|-----|------|------|---------|
| 1 | multi-hop | 0.306 | +0.024 |
| 2 | temporal | 0.657 | -0.042 |
| 3 | open-domain | 0.217 | -0.011 |
| 4 | single-hop | **0.642** | **+0.118** |
| 5 | adversarial | **0.468** | **-0.213** |

- **Analysis**: Single-hop surged +0.118 — window memories capture Q&A pairs that single turns split. But adversarial collapsed -0.213 — window memories mix both speakers' topics, so adversarial questions about the wrong person now find loosely related content. Same pattern as exp 9: more context helps factual recall but hurts rejection.
- **Key insight**: Adversarial performance is the binding constraint. Any change that adds more retrievable content hurts adversarial. Need to improve factual recall WITHOUT increasing false positives for unanswerable questions.
- **Decision**: **Reverted.** Net F1 -0.013.

---

## Exp 10: RRF weight tuning
- **Hypothesis**: Adjusting the balance between semantic and fulltext search in RRF fusion could improve precision.
- **Changes**: mcp-server.ts: changed default weights from 1.0/1.0.
- **Targets**: Cat 1 (multi-hop), cat 4 (single-hop).
- **Results**:

| Weights (sem/ft) | F1 | Cat 1 | Cat 2 | Cat 3 | Cat 4 | Cat 5 |
|-------------------|------|-------|-------|-------|-------|-------|
| 1.0/1.0 (baseline) | 0.535 | 0.282 | 0.699 | 0.228 | 0.524 | 0.681 |
| 1.5/0.5 | 0.540 | 0.321 | 0.657 | 0.257 | 0.551 | 0.660 |
| 0.5/1.5 | 0.525 | 0.241 | 0.647 | 0.378 | 0.514 | 0.681 |

- **Analysis**: All three within noise (~0.015 spread). RRF weights are not a meaningful lever at this stage. The hybrid fusion is already working well with equal weights.
- **Decision**: **Reverted to 1.0/1.0.** No signal.

---

## Exp 7: Speaker-specific tree paths
- **Hypothesis**: Using speaker-specific tree paths (`conv.s5.caroline` instead of `conv.s5`) enables tree filtering by speaker, which could help adversarial questions distinguish between speakers.
- **Changes**: memory.ts: tree path includes speaker name. E.g., `conv.s3.melanie`.
- **Targets**: Cat 5 (adversarial), cat 4 (single-hop).
- **Result**: F1=0.556 EM=0.377

| Cat | Name | F1 | vs prev (exp4) |
|-----|------|------|----------------|
| 1 | multi-hop | 0.273 | -0.009 |
| 2 | temporal | 0.683 | -0.016 |
| 3 | open-domain | 0.323 | +0.095 |
| 4 | single-hop | 0.550 | +0.026 |
| 5 | adversarial | 0.723 | +0.042 |

- **Analysis**: Overall +0.021. Adversarial improved +0.042 (at noise boundary but directionally positive). Only 8/344 searches actually used tree filters — the gain likely comes from speaker names being indexed in the tree, subtly improving search discrimination. No adversarial regression, which is the key constraint.
- **Decision**: **Adopted.** F1=0.556.

---

## Exp 7b: Prompt Claude to use tree filtering by speaker
- **Hypothesis**: Claude only used tree filters 8/344 times. Explicitly telling it about the tree structure and when to filter by speaker should boost adversarial.
- **Changes**: memory.ts: added tree path documentation and usage guidance to prompt.
- **Result**: F1=0.542 EM=0.352

| Cat | Name | F1 | vs exp7 |
|-----|------|------|---------|
| 1 | multi-hop | 0.367 | +0.094 |
| 2 | temporal | 0.676 | -0.007 |
| 3 | open-domain | 0.340 | +0.017 |
| 4 | single-hop | 0.524 | -0.026 |
| 5 | adversarial | 0.638 | -0.085 |

- **Analysis**: Tree filter usage surged from 8 to 317/650 searches. But overall F1 dropped -0.014. Filtering by speaker misses cross-speaker context needed for answers (e.g., "What does Melanie think about Caroline's adoption?" needs both speakers' turns). Adversarial dipped because aggressive filtering produces fewer results, leading Claude to answer from partial evidence rather than reject.
- **Decision**: **Reverted.** Tree paths help passively but explicit filtering hurts.

---

## Exp 8: LLM fact extraction per session
- **Hypothesis**: Extract structured, speaker-attributed facts from each session via LLM (haiku). Facts like "Caroline moved from Sweden 4 years ago" directly answer multi-hop questions that raw turns fragment. Speaker attribution preserves adversarial.
- **Changes**: memory.ts: added fact extraction loop using `claude -p --model haiku`. Facts stored with tree `facts.s{N}.{speaker}`.
- **Targets**: Cat 1 (multi-hop), cat 4 (single-hop).
- **Result**: **F1=0.560 EM=0.367** — new best. 837 memories (419 turns + 418 facts).

| Cat | Name | F1 | vs exp7 |
|-----|------|------|---------|
| 1 | multi-hop | **0.363** | **+0.090** |
| 2 | temporal | 0.671 | -0.012 |
| 3 | open-domain | 0.323 | 0.000 |
| 4 | single-hop | 0.554 | +0.004 |
| 5 | adversarial | 0.681 | -0.042 |

- **Analysis**: Multi-hop surged +0.090 — extracted facts consolidate scattered evidence into single searchable memories. Adversarial -0.042 within noise — speaker-attributed facts don't pollute cross-speaker queries. Ingestion slower (142s) due to LLM calls but answer phase fast (153s).
- **Decision**: **Adopted.** F1=0.560, new best.

---

## Exp 8b: More thorough fact extraction prompt
- **Hypothesis**: The original extraction misses specific details (pets, books, gifts). A more thorough prompt with date context and explicit categories should capture more.
- **Changes**: memory.ts: expanded extraction prompt with date context, relative→absolute date conversion, "be thorough — extract even minor details".
- **Result**: F1=0.522 EM=0.357. 1049 memories (vs 837 in exp8).

| Cat | Name | F1 | vs exp8 |
|-----|------|------|---------|
| 1 | multi-hop | 0.256 | -0.107 |
| 2 | temporal | 0.687 | +0.016 |
| 3 | open-domain | 0.314 | -0.009 |
| 4 | single-hop | 0.504 | -0.050 |
| 5 | adversarial | 0.660 | -0.021 |

- **Analysis**: More facts (1049 vs 837) diluted search quality. Multi-hop dropped -0.107 — too many facts compete for the top-10 results, pushing out the relevant ones. Temporal slightly up from date context. The concise extraction is better than exhaustive.
- **Decision**: **Reverted.** Original exp8 prompt retained.

---

## Exp 5: Category-aware prompting
- **Hypothesis**: Tailored instructions for multi-hop ("try different search queries") and temporal ("look at dates in brackets") could improve those categories.
- **Changes**: memory.ts: category-specific prompt suffixes for cat 1 and cat 2.
- **Result**: F1=0.525 EM=0.327

| Cat | Name | F1 | vs exp8 |
|-----|------|------|---------|
| 1 | multi-hop | 0.292 | -0.071 |
| 2 | temporal | 0.558 | -0.113 |
| 3 | open-domain | 0.337 | +0.014 |
| 4 | single-hop | 0.515 | -0.039 |
| 5 | adversarial | 0.723 | +0.042 |

- **Analysis**: Both targeted categories regressed. The extra instructions may cause Claude to overthink or waste tool calls on suboptimal search strategies instead of its default behavior which already works reasonably well.
- **Decision**: **Reverted.**

---

## Exp 11: Prev/next pointers + me_memory_get navigation
- **Hypothesis**: Adding prev/next turn IDs to metadata and returning adjacent turns from me_memory_get lets Claude see conversation context without adding to the search pool (preserving adversarial).
- **Changes**: memory.ts: client-side UUIDs, prev_id/next_id in turn metadata. mcp-server.ts: me_memory_get returns [prev] [this] [next] formatted context.
- **Targets**: Cat 1 (multi-hop), cat 5 (adversarial — verify context).
- **Result**: F1=0.552 EM=0.367. 89 me_memory_get calls.

| Cat | Name | F1 | vs exp8 |
|-----|------|------|---------|
| 1 | multi-hop | 0.278 | -0.085 |
| 2 | temporal | 0.655 | -0.016 |
| 3 | open-domain | 0.299 | -0.024 |
| 4 | single-hop | 0.513 | -0.041 |
| 5 | adversarial | **0.787** | **+0.106** |

- **Analysis**: Adversarial gained +0.106 (above noise) — seeing surrounding turns helps Claude verify whether a fact belongs to the right speaker. Other categories slightly down (within noise). Overall F1 roughly flat but adversarial is a valuable gain.
- **Decision**: **Adopted.** Adversarial improvement is reliable signal.

---

## Exp 11b/c: Tool call limit tuning (5 → 6 → 8)
- **Hypothesis**: More tool calls let Claude do follow-up searches and get_memory_by_id navigation.
- **Results**:

| Limit | F1 | EM | Cat 1 | Cat 2 | Cat 4 | Cat 5 |
|-------|------|------|-------|-------|-------|-------|
| 5 | 0.552 | 0.367 | 0.278 | 0.655 | 0.513 | 0.787 |
| **6** | **0.562** | **0.392** | 0.298 | 0.698 | 0.569 | 0.681 |
| 8 | 0.554 | 0.357 | 0.354 | 0.661 | 0.577 | 0.638 |

- **Analysis**: 6 is the sweet spot. 8 gives more multi-hop/single-hop but adversarial drops. At 6, temporal peaks at 0.698 and overall F1+EM are both best. Claude self-regulates at avg 2.2 calls even with limit 8 — the limit mainly affects edge cases.
- **Decision**: **Adopted limit=6.** F1=0.562, EM=0.392 — new best on both metrics.

---

## Exp 12+13: candidateLimit and top-K tuning
- **Hypothesis**: More candidates before RRF fusion (30→50) or more results returned (10→15) could surface more relevant memories.
- **Results**:

| Change | F1 | Cat 1 | Cat 5 |
|--------|------|-------|-------|
| Baseline (30/10) | 0.562 | 0.298 | 0.681 |
| candidateLimit=50 | 0.548 | 0.335 | 0.702 |
| limit=15 | 0.558 | 0.393 | 0.638 |

- **Analysis**: Both within noise. limit=15 improved multi-hop +0.095 but hurt adversarial -0.043 (same pattern). candidateLimit=50 had no clear effect. These knobs don't move the needle meaningfully.
- **Decision**: **Both reverted.** Keep defaults 30/10.

---

## Exp 15: Score-based truncation
- **Hypothesis**: Drop search results below a threshold relative to the top score. Fewer low-quality results should help adversarial rejection.
- **Results**: 30% threshold F1=0.535, 50% threshold F1=0.540. Neither improved adversarial (0.660, 0.638). RRF scores are too clustered for thresholding to discriminate.
- **Decision**: **Reverted.**

---

## Exp 14: Show relevance scores in results
- **Hypothesis**: Adding `[score: 0.023]` to results lets Claude judge confidence and reject low-quality matches.
- **Result**: F1=0.559. Multi-hop 0.377 (+0.079), open-domain 0.405 (+0.049), but adversarial flat at 0.660. Within noise overall.
- **Decision**: **Reverted.** Scores add token overhead without clear benefit.

---

## Exp 19: me_memory_grep exact substring tool
- **Hypothesis**: A grep-like tool for exact substring matching could find specific nouns (book titles, pet names) that BM25/semantic misses.
- **Result**: F1=0.529. Only 24/413 tool calls used grep. Claude barely uses it. Adversarial dropped to 0.596 — 4th tool adds schema complexity.
- **Decision**: **Reverted.** Tool kept in mcp-server.ts but not in allowed list.

---

## Exp 20: Adversarial-aware prompt (speaker attribution check)
- **Hypothesis**: 15/47 adversarial failures are entity swaps — question asks about person A but search finds the info attributed to person B. Telling Claude to check speaker attribution should fix this.
- **Changes**: memory.ts: added "If the question asks about one person but the search results only mention a different person doing that thing, say no information available."
- **Targets**: Cat 5 (adversarial).
- **Result**: **F1=0.594 EM=0.407** — new best F1.

| Cat | Name | F1 | vs prev |
|-----|------|------|---------|
| 1 | multi-hop | 0.289 | -0.009 |
| 2 | temporal | **0.704** | +0.006 |
| 3 | open-domain | **0.403** | +0.047 |
| 4 | single-hop | 0.510 | -0.059 |
| 5 | adversarial | **0.894** | **+0.213** |

- **Analysis**: Adversarial surged +0.213 — the speaker check directly addresses entity-swap questions. Temporal and open-domain also improved. Single-hop dipped slightly (some questions cross-reference speakers, so the check makes Claude too cautious).
- **Follow-up (exp20+21)**: Adding "essential words only" format pushed adversarial to 0.936 and EM to 0.427 but temporal dropped to 0.610 (too tight). Reverted format change.
- **Decision**: **Adopted.** F1=0.594, EM=0.407.

---

## Exp 2-retry: Sliding window with adversarial prompt
- **Hypothesis**: With the adversarial prompt protecting cat 5, the sliding window (which previously gave single-hop +0.118) might now be net positive.
- **Result**: F1=0.583. Single-hop 0.590 (+0.080) but temporal 0.556 (-0.148), adversarial 0.830 (-0.064). Window memories dilute temporal search quality.
- **Decision**: **Reverted.** Net negative.

---

## Exp 22: Fact extraction with specific names/numbers emphasis
- **Hypothesis**: Multi-hop failures are often vague facts ("home country" instead of "Sweden"). Emphasizing specific names, titles, numbers, and places in the extraction prompt should capture the details that matter.
- **Changes**: memory.ts: fact extraction prompt now says "Include specific names, titles, numbers, and places — never use vague terms" and explicitly lists pets, books, artworks, family details.
- **Result**: **F1=0.606 EM=0.402** — new best F1. 771 memories.

| Cat | Name | F1 | vs exp20 |
|-----|------|------|---------|
| 1 | multi-hop | 0.335 | +0.046 |
| 2 | temporal | 0.623 | -0.081 |
| 3 | open-domain | **0.462** | +0.059 |
| 4 | single-hop | 0.569 | +0.059 |
| 5 | adversarial | 0.872 | -0.022 |

- **Analysis**: Multi-hop, open-domain, and single-hop all improved. More specific facts help Claude find exact answers. Temporal dipped (within noise range). Adversarial held strong at 0.872.
- **Decision**: **Adopted.** F1=0.606.

---

## Exp 2-retry: Sliding window + adversarial prompt
- **Result**: F1=0.583. Single-hop +0.080 but temporal -0.148. Adversarial held at 0.830 (better than before but still costs). **Reverted.**

## Exp 22b: Fact extraction with date context
- **Hypothesis**: Adding session date to extraction prompt ("convert relative dates to absolute") should help temporal.
- **Result**: F1=0.597, EM=0.442 (new best EM). Temporal 0.595 (didn't recover), adversarial 0.915 (+0.043). Date context improved EM but not F1.
- **Decision**: **Reverted.** F1 is primary metric.

---

## Exp paper-1: Set-union merging instead of RRF (from Omni-SimpleMem paper)
- **Hypothesis**: Paper reports +44% from replacing score-based fusion with set-union (keep semantic ranking, append BM25-only results). Might improve our search.
- **Result**: F1=0.540. Single-hop collapsed to 0.363 (-0.206). Paper's finding doesn't transfer — their context was pre-retrieved context mode with FAISS, not tool-based search where Claude controls queries. RRF works better in our setup.
- **Decision**: **Reverted.**

---

## Exp 3b: Per-speaker entity profiles
- **Hypothesis**: Concatenate all extracted facts per speaker into a single "profile" memory. Should help broad questions like "What activities does Melanie do?" Only 2 extra memories (one per speaker).
- **Changes**: memory.ts: build profile memories from extracted facts, stored under `profile.{speaker}` tree.
- **Result**: F1=0.526 EM=0.322

| Cat | Name | F1 | vs prev |
|-----|------|------|---------|
| 1 | multi-hop | 0.362 | +0.064 |
| 2 | temporal | 0.655 | -0.043 |
| 3 | open-domain | 0.363 | +0.007 |
| 4 | single-hop | 0.545 | -0.024 |
| 5 | adversarial | **0.553** | **-0.128** |

- **Analysis**: Adversarial collapsed -0.128. The giant profile strings are highly retrievable for any query mentioning a speaker, so adversarial questions find loosely related content and Claude answers instead of rejecting. Same adversarial constraint pattern.
- **Decision**: **Reverted.**

---
