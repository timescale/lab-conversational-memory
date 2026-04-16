# How We Built an Autoresearch Harness and Ran 41 Experiments in 6 Days

We wanted to improve long-term conversational memory for AI assistants. Instead of designing a system upfront, we built a harness that let us run experiments fast — and then let Claude iterate on the problem with us. Over 6 days we ran 41 experiments, 85 commits, and went from F1=0.392 to F1=0.666 on the LoCoMo benchmark. Here's how.

## What is Autoresearch?

Autoresearch is a pattern where an AI agent and a human collaborate on an empirical research loop. The agent proposes hypotheses, writes code, runs experiments, analyzes results, and updates its approach — while the human provides direction, catches flawed reasoning, and makes judgment calls.

The key insight: this works because the loop is tight. Each experiment takes 5-10 minutes. You can try something, see if it helped, and decide in real time whether to adopt, revert, or pivot. The agent handles the tedium (writing code, running evals, tabulating results) while the human handles the taste (is this the right question to ask?).

## The Harness

The entire system is ~1,400 lines of TypeScript across 7 files:

```
src/
  memory.ts      — Ingestion + retrieval + prompts (the experiment surface)
  mcp-server.ts  — MCP tool definitions (the agent's search interface)
  evaluate.ts    — Eval loop: ingest → answer → score
  scorer.py      — LoCoMo scoring (token F1 with Porter stemming)
  scoring.ts     — Python subprocess bridge
  prepare.ts     — DB schema + dataset setup
  types.ts       — Shared types
```

Two files are the "experiment surface" — what gets modified in each experiment:
- **`memory.ts`**: How conversations become memories, how search works, what the prompt says
- **`mcp-server.ts`**: What tools the agent has access to and how they behave

Everything else is fixed infrastructure. The evaluator ingests a conversation, has Claude answer ~200 questions using MCP tools, scores with the official LoCoMo scorer, and outputs per-category F1/EM. One eval run takes 5-7 minutes on a single conversation sample.

### The Experiment Loop

```
1. Form hypothesis (what should improve, why)
2. Make ONE change
3. Run eval:quick (1 sample, ~200 QA, ~5 min)
4. Compare F1 per-category against baseline
5. If improved: commit with scores
6. If regressed: git checkout (revert)
7. If ambiguous: run again (variance check)
8. Log everything
```

The critical discipline: **one change at a time**. When we batched two hypotheses into one run early on, the results were uninterpretable — one change helped and the other hurt, but we couldn't tell which was which. After that, we enforced single-hypothesis experiments and never regretted it.

### Dealing with Variance

With ~200 questions per sample, F1 varies by about +-0.04 between identical runs. This means:
- A +0.01 improvement is noise. Don't get excited.
- A +0.05 improvement is probably real. Worth adopting.
- A -0.10 regression is definitely real. Revert immediately.

We measured variance explicitly: 3 identical runs on the same code gave F1 range of 0.606-0.645 (mean 0.632). This calibrated our expectations for every subsequent experiment.

For ambiguous results (+0.01 to +0.03), we used two strategies:
1. Run again to see if the direction holds
2. Look at per-category changes — if one category improved a lot while others stayed flat, the change probably targets that category and the effect is real

### The Experiment Log

Every experiment gets a structured entry:

```markdown
## Exp N: Short description
- **Hypothesis**: What we expected and why
- **Changes**: What code was modified
- **Result**: F1=X.XXX (vs baseline, delta)
- Per-category table with deltas
- **Analysis**: Why it helped or hurt
- **Decision**: Adopted / Reverted / Combined
```

This log became invaluable. When hypothesis #30 failed, we could look back and see that experiment #20 failed for the same reason (exact-word constraints break adversarial rejection). Without the log, we would have wasted time rediscovering this.

## What We Learned About Running Experiments

### Constraints are features

Our biggest constraint: **adversarial questions**. Every change that made the model more willing to answer (better retrieval, more context, "use exact words") also made it worse at rejecting unanswerable questions. This created a tension that shaped every experiment.

Rather than fighting this, we embraced it. The adversarial constraint forced us to find changes that improved recall and accuracy *without* making the model less discriminating. This led to better solutions than we would have found without the constraint — like speaker-aware tree filtering combined with a "do not correct or clarify" prompt that lets the model find the right evidence but still reject misattributions.

### The best improvements came from removing things

Some of our biggest wins:

- **Removing fact extraction**: We spent significant effort on LLM-based fact extraction — having Haiku summarize each session into atomic facts. Ablation showed zero F1 impact. Removing it sped up ingestion by 50% and improved retrieval recall by reducing search noise.

- **Removing the "do not filter by speaker" instruction**: We added this in experiment 25 to protect adversarial accuracy. It worked. But 16 experiments later, the model had gotten smarter about attribution, and removing the restriction unlocked a +0.023 F1 gain with no adversarial regression.

- **Removing category from the prompt**: The evaluation framework passed the question category to the prompt, giving temporal questions a "answer with a date" hint. This was benchmark leakage — in production you don't know the question type. Removing it cost a small amount of temporal accuracy but made the evaluation honest.

### Infrastructure changes compound

The first phase of experiments was mostly infrastructure:
- Making MCP tools non-deferred (so the agent doesn't waste a tool call on ToolSearch)
- Fixing date formatting in search results
- Adding `--json-schema` for structured output
- Tracking tool calls in verbose mode

None of these improved the core retrieval algorithm, but together they moved F1 from 0.392 to 0.523 — a +33% gain just from removing friction. The agent was always capable; it just needed tools that didn't fight it.

### The agent finds things you wouldn't

Several key improvements came from analyzing failure cases:

- **Image descriptions were invisible**: Many LoCoMo turns include shared images with `blip_caption` descriptions ("a painting of a sunset over a lake"). These were stored in metadata but not in the searchable content. We only noticed when investigating why "What has Melanie painted?" consistently failed despite the evidence existing in the database.

- **Grep-only searches were randomly ordered**: 13% of searches used grep without semantic or fulltext, falling into a "filter-only" code path that sorted by creation time. We discovered this by analyzing the search patterns of failing questions — they had reasonable grep patterns but nonsensical results.

- **Case sensitivity in tree paths**: The agent used `conv.Melanie.*` but the tree stored `conv.melanie.*`. Thirty searches per eval were silently returning nothing. We found this by logging the actual tree values used.

These bugs were invisible from the scores alone. Each one required looking at individual failing questions, examining the tool calls, and tracing the search through to the database. The agent excels at this analysis because it can process hundreds of failure cases and spot patterns.

### The human steers, the agent rows

Fully autonomous research sounds appealing, but human direction made a measurable difference in hypothesis quality and experiment velocity. A few examples:

- **Catching benchmark leakage**: The agent happily used the question category in the prompt ("answer with a date" for temporal questions) without flagging it as cheating. A human noticed this was information the system wouldn't have in production and insisted on removing it. Without this check, we'd be reporting inflated numbers.

- **Directing hypothesis priority**: After a round of experiments, the agent proposed four hypotheses ranked by expected impact. The human reordered them — and the one the human prioritized (forcing grep to combine with semantic search) ended up being the biggest win of that round. Domain intuition about what *should* matter isn't something the agent has.

- **Asking the right diagnostic question**: When the recall metric showed gains from interleaving facts and turns, the human pointed out that the metric only counted dialogue turn IDs — facts don't have them. The apparent recall improvement was a measurement artifact, not a real gain. The agent would have adopted the change based on the misleading metric.

- **Challenging assumptions**: The agent assumed fact extraction was valuable because it was a complex, expensive step. The human asked "but does it actually help?" — prompting the ablation that proved facts contributed zero F1.

The pattern that emerged: the agent is better at executing experiments and analyzing large result sets. The human is better at asking "wait, is this actually measuring what we think it's measuring?" and "what's the simplest thing that could explain this?" Together, they're faster than either alone — not because the human writes code, but because they prevent the agent from optimizing the wrong objective.

### Prompt engineering has a ceiling

Early experiments showed big gains from prompt changes: +0.10 from speaker attribution checks, +0.05 from "do not correct or clarify." But later prompt experiments consistently landed within noise (+/- 0.01). The prompt was already doing its job; further gains required changing what the model could *see*, not what it was *told*.

The breakthrough came from tool and data improvements:
- Making image descriptions searchable (+0.012 F1)
- Forcing grep to combine with ranked search (+0.010)
- Speaker-first tree paths for filtering (+0.023)
- Wider context windows on get-by-id (+0.013)

These are all changes to the tool interface and data representation, not the prompt.

## The Trajectory

Here's how F1 evolved across the 41 experiments:

| Phase | Experiments | F1 | Key changes |
|-------|------------|------|-------------|
| Infrastructure | 1-6 | 0.392 → 0.523 | Non-deferred tools, date formatting, structured output |
| Ingestion | 7-11 | 0.523 → 0.562 | Fact extraction, speaker trees, prev/next linking |
| Prompt tuning | 12-19 | 0.562 → 0.659 | Speaker attribution, grep regex, unlimited tool calls |
| Tool refinement | 20-35 | 0.659 → 0.642 | Error correction, metric infrastructure, ablation |
| Data + tools | 36-41 | 0.642 → 0.666 | Drop facts, blip captions, tree filtering, grep errors |

Note the dip in phase 4: we removed category hints from the prompt (honest evaluation) and added error-corrected metrics, which recalibrated our baseline downward. The actual capability kept improving.

The final system is simpler than the intermediate versions — we removed fact extraction, removed the tree browsing tool, removed category-aware prompting. Complexity went down while accuracy went up.

## How to Build Your Own

If you want to run autoresearch on a different problem:

**1. Define the eval clearly.** You need a scoring function that runs in minutes, not hours. If your eval takes 30 minutes, you'll run 4 experiments per day instead of 40. Speed is everything.

**2. Separate infrastructure from experiment surface.** Mark which files the agent can modify and which are fixed. In our case, `memory.ts` and `mcp-server.ts` are fair game; `evaluate.ts` is infrastructure. This prevents the agent from "improving" results by modifying the evaluation.

**3. Enforce one-experiment-at-a-time.** Put it in the CLAUDE.md. The temptation to batch is strong, but the signal loss isn't worth it.

**4. Measure variance first.** Run the same code 3 times before starting experiments. If variance is +-0.04, you know any change under 0.04 is noise. This saves hours of chasing phantoms.

**5. Log obsessively.** Every experiment gets a hypothesis, result, and decision. The log is not overhead — it's the research artifact. It prevents you from repeating failed experiments and reveals patterns across experiments.

**6. Analyze failures, not averages.** The overall F1 tells you *whether* something worked. Looking at individual failing questions tells you *why* and *what to try next*. Every breakthrough in our research came from failure analysis, not from staring at aggregate numbers.

**7. Let the agent challenge your assumptions.** We assumed fact extraction was valuable because it improved multi-hop recall in early experiments. The agent ran an ablation and proved it contributed zero F1 on the full benchmark. We assumed speaker filtering would break adversarial. The agent tested it and proved the prompt was sufficient. The best research tool is one that can tell you when you're wrong.

## The Numbers

- **6 days** of experimentation
- **41 experiments** (17 adopted, 24 reverted)
- **108 eval runs** logged in history
- **85 git commits**
- **~1,400 lines of code** total
- **F1: 0.392 → 0.666** (+70% improvement)
- **Raw F1: 0.638** (vs previous SOTA of 0.598)
