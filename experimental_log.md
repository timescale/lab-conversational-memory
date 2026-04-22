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

## Exp json-schema: Structured output via --json-schema
- **Hypothesis**: Using `--json-schema` forces Claude to output `{"answer": "..."}`. Eliminates format bloat.
- **Changes**: evaluate.ts: added `--json-schema`, extract from `structured_output.answer`.
- **Result**: **F1=0.620 EM=0.442** — new best on both.

| Cat | Name | F1 | vs exp22 |
|-----|------|------|---------|
| 1 | multi-hop | 0.387 | +0.052 |
| 2 | temporal | 0.667 | +0.044 |
| 3 | open-domain | 0.400 | -0.062 |
| 4 | single-hop | 0.574 | +0.005 |
| 5 | adversarial | 0.872 | 0.000 |

- **Decision**: **Adopted.** F1=0.620, EM=0.442.

---

## Full 10-sample eval
- **Result**: F1=0.615 EM=0.438 (1986 QA). Close to 1-sample estimate (0.620). Adversarial even stronger on full set (0.922).

---

## Exp 23+24: Stronger adversarial rejection + exact words
- **Result**: F1=0.485. "Exact words" instruction too restrictive — Claude can't synthesize. **Reverted.**

## Exp 23: Stronger adversarial rejection only
- **Result**: F1=0.591. "Never correct premise" too conservative — multi-hop dropped -0.127. **Reverted.**

## Exp 25: Remove tool call limit
- **Hypothesis**: Multi-hop list questions need more searches. Removing the limit lets Claude search as much as needed.
- **Changes**: memory.ts: "Use at most 6 tool calls" → "Use as many tool calls as needed."
- **Result**: **F1=0.641 EM=0.437** — new best F1.

| Cat | Name | F1 | vs prev |
|-----|------|------|---------|
| 1 | multi-hop | **0.417** | +0.030 |
| 2 | temporal | 0.684 | +0.017 |
| 3 | open-domain | 0.412 | +0.012 |
| 4 | single-hop | **0.595** | +0.021 |
| 5 | adversarial | 0.894 | +0.022 |

- **Analysis**: Avg 3.9 tool calls (up from 2.2). 209 me_memory_get calls (up from 89) — more context navigation. Every category improved. Adversarial held strong because get calls help verify speaker attribution.
- **Decision**: **Adopted.** F1=0.641.

---

## Full 10-sample eval (F1=0.641 checkpoint)
- **Result**: F1=0.646 EM=0.454 (1986 QA). Beats paper's 0.598.

---

## Exp 23+24: Stronger adversarial + exact words → F1=0.485. **Reverted.** Too restrictive.
## Exp 23: Stronger adversarial only → F1=0.591. **Reverted.** Multi-hop -0.127.
## Exp json-schema: Structured output → **F1=0.620. Adopted.**
## Exp 25: No tool call limit → **F1=0.641. Adopted.**

---

## Exp tree-C: Tell Claude about tree structure
- **Hypothesis**: Claude has tree tools but doesn't know the structure. Telling it enables tree-based filtering.
- **Result**: F1=0.634. Multi-hop 0.482 (+0.065), temporal 0.721 (+0.037). But adversarial 0.830 (-0.064) — speaker filtering helps find content but hurts rejection.

## Exp tree-C2: Tree prompt but no speaker filtering
- **Hypothesis**: Keep tree awareness for `facts.*` filtering but tell Claude NOT to filter by speaker to preserve adversarial attribution checks.
- **Changes**: Prompt says "Do NOT filter by speaker — always search across all speakers so you can verify attribution."
- **Result**: **F1=0.653 EM=0.442** — new best F1.

| Cat | Name | F1 | vs 0.641 baseline |
|-----|------|------|-------------------|
| 1 | multi-hop | **0.458** | +0.041 |
| 2 | temporal | 0.706 | +0.022 |
| 3 | open-domain | **0.466** | +0.054 |
| 4 | single-hop | 0.617 | +0.022 |
| 5 | adversarial | 0.851 | -0.043 |

- **Analysis**: `facts.*` filter lets Claude search extracted facts specifically, boosting multi-hop and open-domain. No speaker filtering preserves cross-speaker context for adversarial. Adversarial dip (-0.043) is within noise.
- **Decision**: **Adopted.** F1=0.653.

---

## Exp tree-A: Topic-based fact subtrees
- **Hypothesis**: Organize facts by topic (art, outdoor, family, identity, career, hobbies, pets) instead of session. Claude can filter by topic for precision.
- **Changes**: Keyword-based topic classification, tree `facts.{topic}.{speaker}`, prompt updated.
- **Result**: F1=0.629. Open-domain 0.478 (+0.012 vs C2) but adversarial 0.809 (-0.042). Topic keywords imperfect — some facts miscategorized. More complex tree harder to navigate.
- **Decision**: **Reverted.** Tree-C2 (session-based facts) is simpler and better.

---

## Exp 26: No adversarial corrections — just reject
- **Hypothesis**: 7 adversarial failures where Claude corrects the premise ("No, Oscar is Caroline's"). Adding "do not correct or clarify" should force rejection.
- **Changes**: memory.ts: added "do not correct or clarify who it actually belongs to" to speaker attribution prompt.
- **Result**: **F1=0.659 EM=0.462** — new best on both.

| Cat | Name | F1 | vs prev |
|-----|------|------|---------|
| 1 | multi-hop | 0.447 | -0.011 |
| 2 | temporal | 0.689 | -0.017 |
| 3 | open-domain | 0.488 | +0.022 |
| 4 | single-hop | 0.627 | +0.010 |
| 5 | adversarial | 0.872 | +0.021 |

- **Analysis**: Adversarial failures reduced from 7 to 6. One "Oscar" correction still slips through. Overall +0.006 F1, +0.020 EM.
- **Decision**: **Adopted.** F1=0.659, EM=0.462.

---

## Exp 2b: Cross-session aggregation facts
- **Hypothesis**: Multi-hop list questions fail because facts are scattered. Aggregate facts per speaker by category (creative activities, outdoor, books, family, pets) into single list memories.
- **Result**: F1=0.638. Multi-hop 0.427 (vs 0.447), open-domain 0.420 (vs 0.488). Aggregated strings too broad, compete with specific results. Same pattern as entity profiles.
- **Decision**: **Reverted.**

---

## Exp meta: Speaker in fact meta + meta filter prompting
- **Hypothesis**: Add speaker to fact metadata, tell Claude to use `meta: {speaker: "X"}` for follow-up searches.
- **Result**: F1=0.621. Meta used 37/494 searches. Adversarial 0.830 (-0.042), open-domain 0.358 (-0.130). Speaker filtering narrows too aggressively.
- **Decision**: **Reverted.**

---

## Exp 19c: Grep standalone tool with regex OR → **F1=0.675. Adopted.**
## Exp 19d: Grep as search param (first attempt) → F1=0.639. Claude still called standalone grep + no synonym expansion.
## Exp 19e: Grep param with synonym examples + standalone tool removed → F1=0.671. Close to standalone (0.675). Param patterns use broader synonyms but miss speaker anchoring. Architecturally cleaner (3 tools). **Adopted over 19c.**

---

## Grep prompt placement experiments (19f/19g/19h)

| Exp | Examples location | Anchored? | F1 | Multi-hop | Adversarial |
|-----|------------------|-----------|------|-----------|-------------|
| **19e** | **Prompt** | **No** | **0.671** | 0.545 | **0.894** |
| 19h | MCP desc | No | 0.658 | 0.520 | 0.851 |
| 19f | MCP desc | Yes | 0.650 | 0.454 | 0.894 |
| 19g | Prompt | Yes | 0.614 | 0.476 | 0.766 |

**Findings**: Prompt examples beat MCP desc examples (+0.013-0.036). Unanchored beats anchored. Speaker anchoring hurts adversarial.

## 19e variance test: 3 runs → mean F1=0.651 (range 0.630-0.671)
19k (concise MCP desc) at 0.653 is within this range — prompt vs MCP desc gap is noise.

**Adopted 19k** — grep guidance in MCP tool description. Architecturally cleaner for production (no QA-specific prompt needed).

---

## Exp 19b: Grep tool with better prompting
- **Hypothesis**: Re-enable grep with specific guidance: "use for list questions like what has X done/painted/attended". Grep finds ALL mentions vs search's ranked top-10.
- **Result**: F1=0.637. 115 grep calls (vs 24 in exp19). Some list questions improved dramatically ("Where has Melanie camped?" +0.56) but others regressed. Net F1 -0.022 from 4th tool complexity.
- **Decision**: **Reverted.** Grep helps specific list queries but the 4th tool cost offsets gains.

---

## Exp 19c: Grep with regex OR + synonym expansion
- **Hypothesis**: Upgrade grep from ILIKE to Postgres regex (~*), enabling OR patterns. Prompt Claude to expand search terms: "painted|drawing|sketch". This addresses the key weakness of exp19b where grep used single exact terms.
- **Changes**: mcp-server.ts: ILIKE → ~* regex, default limit 20. Prompt: explicit example of OR patterns.
- **Result**: **F1=0.675 EM=0.472** — new best on both.

| Cat | Name | F1 | vs prev |
|-----|------|------|---------|
| 1 | multi-hop | **0.601** | **+0.154** |
| 2 | temporal | 0.628 | -0.061 |
| 3 | open-domain | 0.490 | +0.002 |
| 4 | single-hop | 0.635 | +0.008 |
| 5 | adversarial | 0.872 | 0.000 |

- **Analysis**: Multi-hop exploded from 0.447 to 0.601. Claude now generates sophisticated regex patterns: `"Caroline.*(married|single|dating|boyfriend|girlfriend|partner)"` → F1=1.00. `"Caroline.*country|Caroline.*moved.*from"` → F1=1.00 (previously couldn't find "Sweden"). 141 grep calls with synonym expansion. Adversarial perfectly stable.
- **Decision**: **Adopted.** F1=0.675, EM=0.472.

---

## Exp41: Stronger tree prompt + lowercase fix
- **Hypothesis**: Exp40 enabled speaker tree filtering but the model barely used it (8/423). Better prompt guidance should increase usage. Also fix case mismatch — model used `conv.Melanie.*` but tree stores `conv.melanie.*`.
- **Exp41 (no lowercase note)**: F1=0.666. Tree usage jumped to 42/373 but 30/42 used uppercase → matched nothing.
- **Exp41b (lowercase note)**: **F1=0.698 EM=0.509** — new best.

| Cat | Exp40 | Exp41b | Delta |
|-----|-------|--------|-------|
| multi-hop | 0.451 | **0.573** | **+0.122** |
| temporal | 0.617 | 0.623 | +0.006 |
| open-domain | 0.365 | 0.373 | +0.008 |
| single-hop | 0.673 | **0.706** | **+0.033** |
| adversarial | 0.909 | 0.886 | −0.023 |

- **Analysis**: Proper tree filtering (36/352, all lowercase) dramatically improved multi-hop (+0.122) and single-hop (+0.033). Adversarial dip within noise. Prompt: "Each memory is a turn spoken by a specific person, organized as conv.{speaker}.s{N} (speaker is lowercase). Filter to a speaker's turns with tree conv.{speaker}.* when searching for what they said, did, or shared."
- **Decision**: **Adopted.**

---

## Exp40: Speaker-first tree + allow speaker filtering
- **Hypothesis**: Tree restructured from `conv.s{N}.{speaker}` to `conv.{speaker}.s{N}` enabling `conv.melanie.*` speaker filtering. Removed "do NOT filter by speaker" instruction that was protecting adversarial. Test if the model is now smart enough to handle speaker filtering without adversarial regression.
- **Result**: **F1=0.675 EM=0.485** (new best). Adversarial **0.909** (held perfectly).

| Cat | Before (exp39) | Exp40 | Delta |
|-----|---------------|-------|-------|
| multi-hop | 0.465 | 0.451 | −0.014 |
| temporal | 0.588 | **0.617** | +0.029 |
| open-domain | 0.435 | 0.365 | −0.070 |
| single-hop | 0.644 | **0.673** | +0.029 |
| adversarial | 0.909 | 0.909 | 0.000 |

- **Analysis**: Speaker filtering helps narrow results for single-hop and temporal. Adversarial held because "do not correct or clarify" prompt is sufficient — the model still sees cross-speaker results and rejects mismatches. Tree usage still low (8/423 searches) but the option helps when used.
- **Decision**: **Adopted.**

---

## Exp39: Error on grep-only searches
- **Hypothesis**: 13% of searches were grep-only (no semantic/fulltext), falling into filter-only mode with random ordering by created_at. Forcing grep to combine with semantic/fulltext ensures relevance ranking.
- **Changes**: Return error on grep-only. Updated tool desc: "grep MUST be combined with semantic and/or fulltext (never alone)".
- **Result**: F1=0.665 (new best). Open-domain +0.091. Grep-only dropped from 13% to <1%.
- **Decision**: **Adopted.**

---

## Exp38: Include blip_caption in memory content
- **Hypothesis**: Shared images have descriptions in `blip_caption` metadata (e.g., "a painting of a sunset") but this is invisible to search — the content only has the speaker's text ("take a look at this"). 1226 turns have captions. Appending `[shared image: caption]` to content makes image descriptions searchable.
- **Result**: F1=0.652 (vs 0.640, +0.012). Temporal recall 0.970 (+0.091), open-domain recall 0.682 (+0.137).
- **Analysis**: Key multi-hop evidence (paintings, objects, locations) was hidden in image captions. Now searchable. Adversarial stable (0.932).
- **Decision**: **Adopted.**

---

## Exp37: me_memory_get with IDs on prev/next + window param
- **Hypothesis**: Adding IDs to prev/next lines enables follow-up navigation. Larger window gives more conversation context per get call.
- **Changes**: prev/next lines include `(id: ...)`. New `window` param (default 1) controls how many prev/next turns to return.

| Metric | Window=1 | Window=2 | Window=3 |
|--------|---------|---------|---------|
| Overall F1 | 0.627 | **0.640** | 0.633 |
| Overall EM | 0.450 | **0.479** | 0.450 |
| Adversarial | 0.909 | **0.932** | 0.932 |
| temporal F1 | 0.508 | **0.604** | 0.523 |

- **Analysis**: Window=2 is the sweet spot — more context helps the model verify answers without noise overload. Window=3 regresses on F1/EM.
- **Decision**: **Adopted window=2.**

---

## Ablation: Remove facts entirely
- **Hypothesis**: Facts may not contribute to F1 — they crowd out dialogue turns in search and add ingestion cost (haiku extraction calls).
- **1-sample result**: F1=0.628 (vs 0.636 with facts, −0.008 within noise). Recall 0.761 (vs 0.492).
- **Full 10-sample result**: **F1=0.642** (vs 0.641 with facts, **+0.001**)

| Cat | With facts | Without facts | Delta |
|-----|-----------|--------------|-------|
| multi-hop | 0.414 | 0.396 | −0.018 |
| temporal | 0.545 | 0.557 | +0.012 |
| open-domain | 0.380 | 0.365 | −0.015 |
| single-hop | 0.623 | 0.639 | +0.016 |
| adversarial | 0.905 | 0.887 | −0.018 |

- **Analysis**: Zero F1 impact across 1824 QA. No category moved more than ±0.018 (all noise). Facts add ~50% ingestion time (haiku calls) and dilute search results for zero benefit.
- **Decision**: **Drop facts.** Turns only from now on.

---

## Exp36: Interleave facts and turns in search results
- **Hypothesis**: Facts crowd out dialogue turns in RRF ranking. Reserving 1/3 slots for turns and 1/3 for facts ensures both types appear.
- **Result**: F1=0.645, **Recall=0.618** (vs 0.492, **+0.126**)

| Cat | Recall (exp34) | Recall (exp36) | Delta |
|-----|---------------|----------------|-------|
| multi-hop | 0.205 | 0.284 | +0.079 |
| temporal | 0.515 | **0.818** | **+0.303** |
| open-domain | 0.545 | 0.636 | +0.091 |
| single-hop | 0.576 | 0.627 | +0.051 |

- **Analysis**: Recall jumped but F1 barely moved (+0.009). The recall metric only counts dialogue turn dia_ids — facts don't have them. By reserving slots for turns, we mechanically inflate recall without improving retrieval quality. The flat F1 confirms this: the recall gain was an artifact of the measurement, not a real improvement.
- **Decision**: **Reverted.** Recall metric is biased towards turns; interleave gamed the metric.

---

## Recall metric + retrieval depth experiments

Added recall metric: tracks which evidence dia_ids the model retrieves via tool calls. Uses structured `<!--evidence:-->` tags in MCP output. Excludes adversarial (cat 5).

### Exp34: Increase retrieval depth (candidateLimit 30→60, limit 10→15)
- **Hypothesis**: 70% of failures are retrieval failures (recall=0). Deeper candidate pool + more results per search should surface more evidence.
- **Result**: F1=0.636, Recall=0.492 (vs baseline Recall=0.380, **+0.112**)

| Cat | Recall (before) | Recall (exp34) |
|-----|----------------|----------------|
| multi-hop | 0.182 | 0.205 |
| temporal | 0.455 | 0.515 |
| open-domain | 0.227 | **0.545** |
| single-hop | 0.441 | **0.576** |

- **Analysis**: Recall improved significantly across all categories. Open-domain more than doubled. F1 within noise but recall is a leading indicator.
- **Decision**: **Adopted.** candidateLimit=60, limit=15.

### Exp35: Even deeper retrieval (candidateLimit 60→100, limit 15→20)
- **Result**: Recall=0.537 (+0.045 more), but adversarial F1 dropped 0.886→0.841. More results = more noise for adversarial rejection.
- **Decision**: **Reverted.** 60/15 is the sweet spot.

### Failure analysis with recall data
- **Retrieval failures (recall=0)**: 62% of non-adversarial failures. Model searches well but evidence ranks below top-K.
- **Reasoning failures (recall=1, F1<0.5)**: 32% of failures. Breakdown:
  - 7 SAID_NO_INFO: Found evidence but said "no information available"
  - 3 WRONG: Found evidence, extracted wrong content
  - 10 PARTIAL: Found evidence but answer too terse ("a cup" vs "a cup with a dog face on it")

---

## Exp30: "Use exact words from memories" in tool prompt
- **Hypothesis**: Haiku paraphrases heavily ("sunset-inspired painting" vs "sunset"), costing F1 on token matches. Adding "Use exact words from the memories — do not paraphrase" should help.
- **Result**: **F1=0.234** — catastrophic. Adversarial went to 0.000. "Use exact words" overrides "say no information available" — haiku quotes memory text for unanswerable questions instead of rejecting.
- **Decision**: **Reverted.** Exact-words instruction conflicts fatally with adversarial rejection.

---

## Exp31: Convert relative dates to absolute using timestamps
- **Hypothesis**: Haiku answers "last year" or "seven years" instead of computing absolute dates from memory timestamps. Adding "use the memory's date to compute the actual year" should help temporal questions.
- **Result**: F1=0.616 (vs baseline 0.632, −0.016). Temporal 0.564 (vs 0.620, −0.056) — actually worse, may confuse haiku on non-date temporal questions. Within noise overall.
- **Decision**: **Reverted.** No signal, possibly harmful.

---

## Exp32: Disable built-in tools (--tools "")
- **Hypothesis**: Haiku wastes tool calls on LSP (7 calls in baseline). Setting `--tools ""` should disable built-in tools and leave only MCP tools.
- **Result**: F1=0.626 (vs baseline 0.632, −0.006). LSP calls still present (10) — LSP is a system integration, not blocked by `--tools`. Within noise.
- **Decision**: **Reverted.** LSP can't be blocked this way.

---

## Exp33: Grep array with AND logic
- **Hypothesis**: Change grep from single string to array where ALL patterns must match. Enables `["Melanie", "paint|art|canvas"]` to find Melanie's art specifically, instead of trying to cram it into one regex.
- **Result**: F1=0.589 (vs baseline 0.632, **−0.043**). Temporal collapsed −0.142. AND logic over-filters — intersecting patterns returns too few results.
- **Decision**: **Reverted.** Over-filtering hurts more than precision helps.

---

## Exp29: Remove category from prompt (no cheating)
- **Hypothesis**: buildPrompt was receiving the QA category and adding "Answer with a specific date or time period" for temporal questions. This leaks benchmark metadata — in production we wouldn't know the category. Remove it.
- **Changes**: buildPrompt no longer takes category param. All questions get the same generic prompt.
- **Result**: F1=0.615 EM=0.432 (vs baseline mean 0.632, −0.017 — within variance)

| Cat | Baseline mean | No category | Delta |
|-----|--------------|-------------|-------|
| 1 | multi-hop | 0.485 | 0.469 | −0.016 |
| 2 | temporal | 0.620 | 0.546 | −0.074 |
| 3 | open-domain | 0.357 | 0.302 | −0.055 |
| 4 | single-hop | 0.554 | 0.564 | +0.010 |
| 5 | adversarial | 0.886 | 0.886 | 0.000 |

- **Analysis**: Temporal took the biggest hit (−0.074) since it lost the date hint. Overall within variance range (0.606–0.645). The honest measurement is what matters.
- **Decision**: **Adopted.** No category leakage in production.

---

## Exp28: grep case-sensitive (`~`) vs case-insensitive (`~*`)
- **Hypothesis**: Test whether case-insensitive grep (`~*`) is better than case-sensitive (`~`). Tool description updated to match operator.
- **Result**: F1=0.570 EM=0.414 (case-sensitive) vs mean 0.632 (baseline) — **−0.062 overall**

| Cat | Baseline (mean) | Case-sensitive | Delta |
|-----|----------------|---------------|-------|
| 1 | multi-hop | 0.485 | 0.288 | **−0.197** |
| 2 | temporal | 0.620 | 0.417 | **−0.203** |
| 3 | open-domain | 0.357 | 0.346 | −0.011 |
| 4 | single-hop | 0.554 | 0.566 | +0.012 |
| 5 | adversarial | 0.886 | 0.886 | 0.000 |

- **Analysis**: Multi-hop and temporal collapsed. These categories require grep to find names and concepts with varied capitalizations (e.g. speaker names at start of turns are capitalized). Case-insensitive `~*` is clearly correct.
- **Decision**: **Reverted.** `~*` confirmed as the right operator.

---

## Haiku baseline (1-sample)
- **Model**: haiku (switched from sonnet due to credit exhaustion until Apr 17)
- **Result**: F1=0.645 EM=0.462 (169 QA, error-corrected; raw F1=0.618, 199 QA, 30 errors excluded)
- **Context**: Same memory.ts/mcp-server.ts as sonnet best (exp19k + exp26 adopted). Haiku used for both fact extraction and QA answering.

| Cat | Name | F1 | EM | n |
|-----|------|------|------|---|
| 1 | multi-hop | 0.521 | 0.273 | 22 |
| 2 | temporal | 0.665 | 0.333 | 33 |
| 3 | open-domain | 0.278 | 0.091 | 11 |
| 4 | single-hop | 0.550 | 0.339 | 59 |
| 5 | adversarial | 0.909 | 0.909 | 44 |

- **vs sonnet best on 1-sample (~0.664)**: -0.019 overall. Open-domain particularly weak (0.278 vs ~0.488). Multi-hop also down (0.521 vs ~0.545). Adversarial is stronger with haiku (0.909 vs ~0.872) — likely less verbose/creative refusals.
- **Note**: Haiku is faster and cheaper; experiments will continue with haiku until sonnet credits restore.

### Haiku variance (1-sample, 3 runs)
| Run | Overall F1 | multi-hop | temporal | open-domain | single-hop | adversarial |
|-----|-----------|-----------|----------|-------------|------------|-------------|
| 1 | 0.645 | 0.521 | 0.665 | 0.278 | 0.550 | 0.909 |
| 2 | 0.644 | 0.502 | 0.639 | 0.393 | 0.583 | 0.864 |
| 3 | 0.606 | 0.431 | 0.555 | 0.401 | 0.530 | 0.886 |
| **Mean** | **0.632** | 0.485 | 0.620 | 0.357 | 0.554 | 0.886 |
| Range | ±0.039 | ±0.090 | ±0.110 | ±0.123 | ±0.053 | ±0.045 |

Variance similar to sonnet (~0.04 overall). Per-category swings large due to small n.

### Haiku full 10-sample
- **Result**: F1=0.641 EM=0.465 (1824 QA, error-corrected; raw F1=0.610, 1986 QA, 162 errors excluded)

| Cat | Name | F1 | EM | n |
|-----|------|------|------|---|
| 1 | multi-hop | 0.414 | 0.205 | 229 |
| 2 | temporal | 0.545 | 0.274 | 285 |
| 3 | open-domain | 0.380 | 0.279 | 86 |
| 4 | single-hop | 0.623 | 0.384 | 783 |
| 5 | adversarial | 0.905 | 0.905 | 441 |

- **vs sonnet full 10-sample (F1=0.688)**: −0.047 overall. Biggest gaps in multi-hop and temporal where cross-session reasoning is critical.

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

## LLM-as-Judge Accuracy (retroactive scoring of full 10-sample run)

Re-scored the blog post run (`eval-2026-04-16T10-49-32-709Z.json`, exp41b full 10-sample) with LLM-as-judge accuracy. For questions where EM=1, accuracy=1 automatically. For the remaining 1,074 non-exact-match questions, Claude Haiku judged whether the prediction contained the vital facts of the ground truth.

| Cat | Name | F1 | EM | Acc | n |
|-----|------|------|------|------|---|
| 1 | multi-hop | 0.445 | 0.201 | 0.371 | 229 |
| 2 | temporal | 0.581 | 0.319 | 0.667 | 285 |
| 3 | open-domain | 0.328 | 0.209 | 0.337 | 86 |
| 4 | single-hop | 0.670 | 0.433 | 0.701 | 783 |
| 5 | adversarial | 0.893 | 0.893 | 0.898 | 441 |
| **Overall** | | **0.666** | **0.487** | **0.685** | 1824 |

- All numbers are error-corrected (excluding 162 known benchmark errors).
- Accuracy (0.685) > F1 (0.666) > EM (0.487) — the judge catches correct answers that don't string-match exactly.
- Biggest Acc vs EM gap is temporal (+0.348) — date format differences ("May 7th" vs "7 May 2023") fail EM but pass the judge.
- Saved to `results/eval-2026-04-16T10-49-32-709Z-accuracy.json`.

### Prompt B comparison (Mem0/APEX-MEM generous grading prompt)

Re-ran with prompt B — the generous grading prompt used by Mem0 (2025) and APEX-MEM for LoCoMo evaluation. Uses JSON structured output (`{"label": "CORRECT"|"WRONG"}`).

| Cat | Name | F1 | EM | Acc (A) | Acc (B) | n |
|-----|------|------|------|------|------|---|
| 1 | multi-hop | 0.445 | 0.201 | 0.371 | 0.472 | 229 |
| 2 | temporal | 0.581 | 0.319 | 0.667 | 0.737 | 285 |
| 3 | open-domain | 0.328 | 0.209 | 0.337 | 0.442 | 86 |
| 4 | single-hop | 0.670 | 0.433 | 0.701 | 0.810 | 783 |
| 5 | adversarial | 0.893 | 0.893 | 0.898 | 0.900 | 441 |
| **Overall** | | **0.666** | **0.487** | **0.685** | **0.760** | 1824 |

- Prompt B is more generous than A (+0.075 overall): 0.760 vs 0.685.
- Biggest gaps: single-hop (+0.109), temporal (+0.070), open-domain (+0.105).
- Prompt B's domain-specific guidance (date format tolerance, "touches on the same topic") drives the leniency.
- Saved to `results/eval-2026-04-16T10-49-32-709Z-accuracy-promptb.json`.

---

## Exp42: Encourage inference on might/would/could questions

- **Hypothesis**: Open-domain has 40 "no information" refusals (40%+ of questions). These are inferential questions ("What might John's degree be in?") where evidence exists but the model is too conservative. Adding "For questions that ask what someone 'might' do, 'would likely' be, or 'could' enjoy — make your best inference from the available evidence" should reduce false refusals.
- **Change**: Added inference encouragement line to tool-mode prompt in memory.ts.
- **Eval**: 1 sample (conv-26), Haiku, Acc(B) judge.

Baseline is conv-26 from the 10-sample run (same sample, same model):

| Cat | Name | Baseline Acc(B) | Exp42 Acc(B) | Delta | n |
|-----|------|---------|-------|-------|---|
| 1 | multi-hop | 0.406 | 0.318 | -0.088 | 22 |
| 2 | temporal | 0.757 | 0.879 | +0.122 | 33 |
| 3 | open-domain | 0.615 | 0.636 | +0.021 | 11 |
| 4 | single-hop | 0.814 | 0.864 | +0.050 | 59 |
| 5 | adversarial | 0.894 | 0.909 | +0.015 | 44 |
| **Overall** | | **0.744** | **0.793** | **+0.049** | 169 |

F1 held steady (0.662 vs baseline 0.666 overall).

- **Analysis**: Overall +0.049 Acc(B). Temporal (+0.122) and single-hop (+0.050) improved most. Open-domain only +0.021 — smaller than expected given 40 "no info" refusals in the full run. Multi-hop dipped -0.088, possibly the model is now guessing on questions where "no info" was correct. Adversarial held (+0.015), so inference encouragement didn't cause false positives.
- **Decision**: **Adopted.** Modest overall improvement, no adversarial regression. Needs full 10-sample to confirm.

### Full 10-sample results (Haiku and Sonnet)

| Cat | Name | Haiku Base Acc(B) | Haiku Exp42 Acc(B) | Sonnet Exp42 Acc(B) | Haiku Base Recall | Haiku Exp42 Recall | Sonnet Exp42 Recall | n |
|-----|------|---------|-------|-------|---------|-------|-------|---|
| 1 | multi-hop | 0.472 | 0.472 | 0.537 | 0.594 | 0.601 | 0.592 | 229 |
| 2 | temporal | 0.737 | 0.740 | 0.811 | 0.880 | 0.910 | 0.862 | 285 |
| 3 | open-domain | 0.442 | 0.581 | 0.640 | 0.582 | 0.585 | 0.554 | 86 |
| 4 | single-hop | 0.810 | 0.849 | 0.900 | 0.864 | 0.870 | 0.871 | 783 |
| 5 | adversarial | 0.900 | 0.878 | 0.907 | — | — | — | 441 |
| | **Overall** | **0.760** | **0.779** | **0.830** | **0.805** | **0.816** | **0.803** | 1824 |

Summary metrics (error-corrected):

| Metric | Haiku Baseline | Haiku Exp42 | Sonnet Exp42 |
|--------|---------|-------|-------|
| F1 | 0.666 | 0.669 | 0.693 |
| EM | 0.487 | 0.490 | 0.484 |
| Acc(B) | 0.760 | 0.779 | 0.830 |
| Recall | 0.805 | 0.816 | 0.803 |
| Raw F1 | 0.638 | 0.641 | 0.665 |

- Haiku exp42 confirms 1-sample finding: overall Acc(B) +0.019, open-domain +0.139, F1 +0.003.
- Sonnet exp42: Acc(B) 0.830 (+0.051 over Haiku exp42), F1 0.693 (+0.024). Sonnet retrieves slightly less (recall 0.803 vs 0.816) but reasons better over what it finds.
- Adversarial stable across all three runs (0.878–0.907).

### gpt-4o-mini as judge (prompt B)

Re-scored the same runs with gpt-4o-mini instead of Claude Haiku as the judge. 25x faster (~60s vs ~23min for 1074 questions) and more generous, especially on multi-hop.

| Cat | Name | Haiku Base (haiku judge) | Haiku Base (gpt-4o-mini) | Sonnet Exp42 (gpt-4o-mini) | n |
|-----|------|---------|-------|-------|---|
| 1 | multi-hop | 0.472 | 0.725 | 0.808 | 229 |
| 2 | temporal | 0.737 | 0.765 | 0.849 | 285 |
| 3 | open-domain | 0.442 | 0.464 | 0.690 | 84 |
| 4 | single-hop | 0.810 | 0.843 | 0.932 | 783 |
| 5 | adversarial | 0.900 | 0.907 | 0.916 | 441 |
| | **Overall** | **0.760** | **0.814** | **0.889** | ~1822 |

- gpt-4o-mini is more generous than Haiku as judge (+0.054 on same Haiku baseline run).
- Biggest judge gap is multi-hop: 0.472 (haiku) vs 0.725 (gpt-4o-mini) on same predictions.
- Sonnet exp42 with gpt-4o-mini judge: **Acc(B) = 0.889**, single-hop 0.932, temporal 0.849.
- Open-domain remains weakest (0.690) — many questions have subjective/image-dependent gold answers.

---

## Exp43: Semantic-only search for inferential questions

- **Hypothesis**: Hybrid search (BM25 + semantic) hurts inferential questions because BM25 returns noise for abstract queries like "political views" (nobody says those words in conversation). Manual testing confirmed semantic-only surfaces better passages. Adding prompt guidance to use semantic-only for inferential questions should improve open-domain and multi-hop.
- **Change**: Added search strategy guidance to prompt: "For inferential questions (personality traits, opinions, preferences, 'might/would/could'): use semantic ONLY."
- **Eval**: Sonnet 1-sample (conv-26) vs exp42 conv-26 from 10-sample run.

| Cat | Name | exp42 F1 | exp43 F1 | Δ F1 | exp42 Recall | exp43 Recall | Δ Recall |
|-----|------|---------|-------|------|---------|-------|------|
| 1 | multi-hop | 0.412 | 0.453 | +0.041 | 0.508 | 0.508 | +0.000 |
| 2 | temporal | 0.619 | 0.622 | +0.003 | 1.000 | 1.000 | +0.000 |
| 3 | open-domain | 0.261 | 0.286 | +0.026 | 0.577 | 0.577 | +0.000 |
| 4 | single-hop | 0.646 | 0.661 | +0.016 | 0.743 | 0.829 | +0.086 |
| 5 | adversarial | 0.809 | 0.787 | -0.021 | — | — | — |
| | **Overall** | **0.616** | **0.626** | **+0.009** | **0.742** | **0.781** | **+0.039** |

Also tested on conv-44 open-domain (worst sample, n=7): Acc(B) 0.286 → 0.286 (flat).

- **Analysis**: Recall unchanged for multi-hop, temporal, open-domain — the model was already relying on semantic search for these. Multi-hop F1 +0.041 came from better reasoning, not retrieval, but n=32 is too noisy to be conclusive. Open-domain failures are fundamentally subjective gold answers or image-dependent evidence (2 new benchmark errors added for Voyageurs National Park and Minnesota). Deep analysis of conv-44 open-domain showed 3/5 clean questions have gold answers that are creative suggestions never stated in the conversation.
- **Decision**: **Reverted.** No reliable improvement. The bottleneck for open-domain is benchmark subjectivity, not search strategy.

---
