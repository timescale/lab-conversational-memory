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
