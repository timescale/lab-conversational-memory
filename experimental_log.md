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
