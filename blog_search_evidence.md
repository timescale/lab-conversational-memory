# Evidence for the "What We Learned" section of blog_search.md

This file documents how every number in the "What We Learned (45+ Experiments)" section was derived: which result files were compared, what changed between them, how intervals were computed, and what the numbers do not cover. All inputs are checked into this repository under `results/`, `data/`, and the two experiment logs.

## 1. Sources

### Result files

Every eval run writes `results/eval-<timestamp>.json` with one entry per question (`sampleId`, `question`, `prediction`, `category`, `f1`, `em`, `accuracy`, `recall`, `toolCalls`) plus a one-line summary in `results/history.jsonl`. The runs used in the section:

| File (results/eval-…) | Model | Samples | Raw F1 | Config at the time |
|---|---|---|---|---|
| 2026-04-10T10-14-30-794Z | Sonnet | conv-26 | 0.481 | Fixed pipeline (context mode), hybrid RRF top-10, session dates shown at retrieval (exp3) |
| 2026-04-10T14-20-15-042Z | Sonnet | conv-26 | 0.584 | First working agentic run: single `search_memories` tool, relaxed answer prompt |
| 2026-04-10T18-25-20-975Z | Sonnet | conv-26 | 0.493 | Production-matching 9-parameter `me_memory_*` tools, 3-call limit |
| 2026-04-11T22-18-00-398Z | Sonnet | all 10 | 0.615 | json-schema output, facts on, tool-call limit 6, category hint on |
| 2026-04-12T09-36-10-149Z | Sonnet | all 10 | 0.646 | + tool-call limit removed (exp25) |
| 2026-04-13T10-17-08-067Z | Sonnet | all 10 | 0.657 | + tree-awareness prompt (tree-C2), "do not correct" prompt (exp26), grep parameter (19k) |
| 2026-04-13T13-24-26-727Z | Sonnet | all 10 | 0.657 | Identical config to the previous row, rerun 3 hours later |
| 2026-04-13T21-21-19-234Z | Haiku | all 10 | 0.610 | Same config as the Sonnet Apr 13 runs, Haiku |
| 2026-04-15T14-07-55-915Z | Haiku | all 10 | 0.614 | + category hint removed (exp29), candidateLimit 60 / limit 15 (exp34), facts removed |
| 2026-04-16T10-49-32-709Z | Haiku | all 10 | 0.638 | + get window 2 (exp37), blip captions (exp38), grep-only error (exp39), speaker-first tree (exp40), lowercase note (exp41b) |
| 2026-04-21T21-40-00-572Z | Haiku | all 10 | 0.641 | + narrow inference prompt (exp42) |
| 2026-04-22T09-24-37-712Z | Sonnet | all 10 | 0.665 | Same config as previous row, Sonnet |
| 2026-04-22T15-17-00-246Z | Sonnet | all 10 | 0.665 | + image query field in ingestion (exp44), multi-hop iterative-search prompt (exp45). **Headline run.** |

"What changed" between consecutive full runs was read from `git log` between the two timestamps, keeping only commits that were adopted (reverted experiments are not in the code at the later checkpoint). Commits: exp25 `4564a7a`; tree-C2 `2fe7568`; exp26 `dbec66f`; grep `70576a6` → `2713617` → `6f40278` → `19029a2`; exp29 `41c7951`; exp34 `6e710ba`; facts removal `95085cc`; exp37 `8564d58`; exp38 `955c0a1`; exp39 `0957320`; exp40 `5b235b6`; exp41b `004d7b9`; exp42 `9517fea`; exp44 `6176b58`; exp45 `0517933`.

The model is the Claude Code CLI alias (`--model sonnet` or `haiku`) passed by `src/evaluate.ts`. The exact model version is not recorded anywhere. Runs before Apr 13 used `--model sonnet` hardcoded; from Apr 13 the model came from `EVAL_MODEL`.

### Logs

`experimental_log_phase1.md` covers the Apr 10 context-mode and early tool-mode runs. `experimental_log.md` covers everything after the 0.493 "realistic baseline". Numbers taken directly from the logs rather than recomputed are marked "(log)" below.

### Data

`data/locomo10.json` is the LoCoMo benchmark: 10 conversations, 1,986 questions. Raw category counts: multi-hop 282, temporal 321, open-domain 96, single-hop 841, adversarial 446. `data/locomo-errors.json` (158 entries: 156 from the LoCoMo Audit plus 2 of ours) and `data/adversarial-errors.json` (5 of ours) define the error-corrected subset; together they exclude 164 questions (163 unique, plus one single-hop question that shares its text with an excluded adversarial question).

## 2. Methods

### Scoring

F1 is token-level with Porter stemming, computed by `src/scorer.py`, a port of the LoCoMo `evaluation.py`. "Raw" means all 1,986 questions. "Error-corrected" excludes the 164 questions above. Deltas in the section are computed on raw scores unless stated, because raw includes every question and matches the comparison tables elsewhere in the post. Where the section quotes an error-corrected figure, it says so.

### Paired comparison between two full runs

For two runs A and B on the same 1,986 questions, matched by position (verified by `sampleId` and `question` equality):

```python
import json, random, statistics as st
random.seed(0)
A = json.load(open('results/eval-A.json'))['results']
B = json.load(open('results/eval-B.json'))['results']
d = [b['f1'] - a['f1'] for a, b in zip(A, B)]          # per-question paired difference
mean = st.mean(d)
boots = sorted(st.mean(random.choices(d, k=len(d))) for _ in range(3000))
lo, hi = boots[75], boots[2924]                          # 2.5th and 97.5th percentiles
```

Per-category intervals use the same procedure on the subset of `d` for that category. Recall deltas use `recall` in place of `f1`, restricted to non-adversarial questions (recall is −1 for adversarial). The bootstrap resamples questions, so the interval covers question-sampling noise and per-question model randomness as it appeared in these two runs. It does not cover a shift that moves every question in one run together (see §4).

### Conversation-level check

As a robustness check that does not assume questions are independent, the ten per-conversation mean deltas are treated as ten observations: sign count, mean, and a t-interval with 9 degrees of freedom.

### Tool-call counts

`toolCalls` in each result lists every tool invocation. Counts include only tools whose names end in `me_memory_search`, `me_memory_get`, or `me_memory_tree`; the final `StructuredOutput` call is excluded. "Searches" are `me_memory_search` calls. A search is "grep-only" if `grep` is set and both `semantic` and `fulltext` are empty; it "uses a tree filter" if `tree` is set.

### Run-to-run variance

Identical-config repeats found in `results/history.jsonl`:

| Config | Model | Sample | Runs | F1 values | Spread |
|---|---|---|---|---|---|
| exp3 fixed pipeline | Sonnet | conv-26 | 2 | 0.481, 0.447 (raw) | 0.034 |
| exp19e grep parameter | Sonnet | conv-26 | 3 | 0.671, 0.630, 0.651 (raw) | 0.041 |
| exp19k + exp26 | Haiku | conv-26 | 3 | 0.645, 0.644, 0.606 (corrected) | 0.039 |
| exp38 blip captions | Haiku | conv-26 | 2 | 0.652, 0.672 (corrected) | 0.020 |
| exp19k + exp26 | Sonnet | all 10 | 2 | 0.6573, 0.6572 (raw) | 0.0002 |

The last row is the two Apr 13 Sonnet files. They are independent runs, not a rescoring: predictions differ on 997 of 1,986 questions. Its per-conversation deltas range from −0.039 (conv-44) to +0.064 (conv-30); 7 of 10 are positive. Its adversarial subset moved +0.022 (CI +0.000 to +0.047), which sets the scale for adversarial-only comparisons on 446 questions.

The per-question paired difference has a standard deviation of about 0.25 to 0.29 in every pair examined. That gives a 95% half-width of about 0.04 on ~200 questions and about 0.013 on 1,986, which is why single-conversation deltas and full-benchmark deltas have different noise floors.

## 3. Derivation of each number

### Intro paragraph

- **45+ experiments.** 66 `## Exp` headers across the two logs, several of which are sub-variants (19b–19k); 119 eval runs in `history.jsonl`.
- **conv-26, ~200 questions.** `bun run eval:quick` is `--samples 1`, which takes `dataset.slice(0, 1)` = conv-26: 199 questions raw, 169 error-corrected.
- **±0.04 on identical reruns.** The conv-26 rows of the variance table above.
- **Identical-config repeat differed by 0.0002; conversations swung by up to 0.06.** Apr 13 pair: overall −0.0002 (CI −0.011 to +0.011); conv-30 +0.064.

### Finding 1: agentic vs fixed

All figures are conv-26, raw, Sonnet, from `history.jsonl` and the corresponding files. Not paired: the two eval modes produce different prompts.

- **0.481** fixed pipeline, `2026-04-10T10-14-30-794Z` (exp3). Naive baseline before dates was 0.392 (`2026-04-10T09-52-52-284Z`).
- **0.584** first working agentic run, `2026-04-10T14-20-15-042Z`.
- **gap of 0.10** = 0.584 − 0.481. Single-run standard deviation on conv-26 is about 0.02, so a difference of two runs has a standard deviation near 0.03; 0.10 is over three of those.
- **0.627** conv-26 slice of the headline run (n=199).
- **dropped by 0.09** = 0.584 → 0.493, `2026-04-10T18-25-20-975Z`; also stated in `experimental_log_phase1.md` ("~0.09 F1 cost").
- Caveat: the fixed-pipeline runs used a category hint in the prompt that was later removed as benchmark leakage (exp29); it would have helped the fixed pipeline, if anything.

### Finding 2: tool-call cap

Pair: `2026-04-11T22-18-00-398Z` → `2026-04-12T09-36-10-149Z`. Only adopted change between them: exp25 (limit "at most 6 tool calls" → "as many as needed").

- **0.615 → 0.646**, **+0.031 (CI +0.018 to +0.044)**: paired bootstrap, exact +0.0309 [+0.0182, +0.0438].
- **All ten conversations positive, +0.010 to +0.067**: per-conversation means. Conversation-level t-interval +0.017 to +0.042; sign test 10/10.
- **Multi-hop +0.048** [+0.014, +0.081]; **single-hop +0.042** [+0.021, +0.063]; adversarial +0.004 [−0.016, +0.025]; temporal +0.029 and open-domain +0.011, both spanning zero.
- **2.7 → 3.2 tool calls per question**: 2.66 → 3.24. **Final system 3.9, median 3**: headline run mean 3.91 (3.70 searches, 0.20 gets, 0.01 tree), median 3, p90 7, max 34.
- **previously six**: exp11c in the log set the limit to 6.

### Finding 3: grep

Pair: `2026-04-12T09-36-10-149Z` → `2026-04-13T10-17-08-067Z`. Adopted changes between them: grep as a search parameter with synonym-expansion guidance (19c → 19e → 19k), the tree-awareness prompt allowing `facts.*` filtering (tree-C2), and the "do not correct or clarify" adversarial prompt (exp26).

- **Multi-hop +0.046** [+0.015, +0.079]; **single-hop +0.022** [+0.003, +0.041]; **adversarial −0.036** [−0.058, −0.014]; **overall +0.012** [−0.001, +0.023]; temporal +0.019 and open-domain +0.016 spanning zero. Note the adversarial interval is only about 1.5× the identical-rerun adversarial swing (+0.022), so it is real but not large.
- **About half of searches use grep**: 4,061 of 7,955 searches in the Apr 13 run.
- **13% grep-only → below 1%** (log): exp39 entry, measured on conv-26 tool calls. On the full benchmark the grep-only share was 9.1% in the Haiku Apr 15 run (701 of 7,744 searches), 0.3% in Haiku Apr 16 (14 of 4,246), and 0 in the Sonnet headline run.

### Finding 4: tree paths, captions, context windows

Pair: `2026-04-15T14-07-55-915Z` → `2026-04-16T10-49-32-709Z`, both Haiku. Adopted changes between them: exp37 (window 2), exp38 (blip captions), exp39 (grep-only error), exp40 (speaker-first tree, filtering allowed), exp41b (lowercase note). Five changes; the section calls them four plus the grep-only fix.

- **+0.024 (CI +0.010 to +0.039)**: paired bootstrap, exact +0.0240 [+0.0096, +0.0388] (a second seed gave [+0.0090, +0.0391]).
- **Adversarial held at 0.887 → 0.893 on 441 questions** (log): error-corrected adversarial F1 from the ablation entry (0.887) and the exp41b full-run table (0.893). Raw paired: 0.881 → 0.883, +0.002 [−0.027, +0.034].
- **30 of 42 filters uppercase** (log): exp41 entry, conv-26 tool calls in the run without the lowercase note.
- **Filter used in 10% of searches**: 446 of 4,246 searches in the Haiku Apr 16 run, 445 lowercase. In the Sonnet headline run the share is 27.4% (2,012 of 7,349). The section's "10%" is the Haiku figure and should say so.
- **1,226 turns with captions**: counted directly in `data/locomo10.json` (1,226 of 5,882 turns have `blip_caption`); matches the exp38 log entry.
- **Windows 1, 2, 3 inside the noise floor**: conv-26 Haiku corrected F1 0.627 / 0.640 / 0.633 (`history.jsonl`, exp37 rerun, exp37b, exp37c), spread 0.013 against ±0.04.
- **Looked like +0.061 on the tuning conversation**: conv-26 raw F1 in `history.jsonl` from the ablation run (0.599) to exp41b (0.659). Inside the 10-sample pair the conv-26 slice moved +0.068 and the other nine conversations +0.019. "Roughly 3×" is 0.061 to 0.068 over 0.024, i.e. 2.5× to 2.8×.

### Finding 5: facts

- **Clean single-conversation ablation showed no difference** (log): conv-26 Haiku corrected 0.636 with facts (exp34, `2026-04-14T21-54-42-115Z`) vs 0.628 without (`2026-04-15T12-26-55-393Z`).
- **0.642 without vs 0.641 with** (log): error-corrected overall F1 from `2026-04-15T14-07-55-915Z` (0.6424) and `2026-04-13T21-21-19-234Z` (0.6412).
- **Paired interval spans zero**: raw paired +0.004 [−0.012, +0.019].
- **Two other changes in the comparison**: exp29 (category hint removed; conv-26 effect −0.017) and exp34 (candidateLimit 30→60, limit 10→15). Both shipped between the two Haiku runs.
- **~50% ingestion time** (log): ablation entry; exp8 recorded 142 s of extraction on one conversation.

### Finding 6: multi-hop

Pair: `2026-04-22T09-24-37-712Z` → `2026-04-22T15-17-00-246Z`, both Sonnet. Changes: exp44 (image `query` field appended to content), exp45 (iterative-search prompt).

- **15 of 38 zero-recall failures stopped after one or two searches**: in the pre-fix run, 38 raw multi-hop questions have `recall == 0`; 15 of them have ≤2 `me_memory_search` calls. (The earlier draft's "23 of 26 repeated the same query" did not reproduce: only 1 of the 38 repeated an identical search, matching on semantic, fulltext, grep, and tree.)
- **Recall 0.592 → 0.651, error-corrected** (log): exp45 full-run table, n=229. Raw paired: 0.557 → 0.617, **+0.059 [+0.028, +0.092]**. Temporal recall raw 0.848 → 0.896, +0.048 [+0.020, +0.078]. Open-domain and single-hop recall spanning zero.
- **F1 did not move**: overall +0.0002 [−0.010, +0.011]; multi-hop F1 +0.023 [−0.005, +0.052].
- **Zero-recall multi-hop 38 → 26 of 282**: raw counts in the two files.
- **Tool calls on multi-hop 4.0 → 4.2**: 4.02 → 4.22 mean `me_memory_*` calls on category-1 questions.

### Finding 7: adversarial

Examples in the first paragraph are conv-26, Sonnet unless noted, from `history.jsonl` and the log; each is a large single-run drop, well outside ±0.04:

- Blanket inference prompt (exp9): adversarial 0.681 → 0.362.
- 3-turn sliding windows (exp2): 0.681 → 0.468.
- Per-speaker profiles (exp3b): 0.681 → 0.553.
- "Use exact words" (exp30, Haiku): adversarial → 0.000.
- Narrow inference prompt (exp42) on the full benchmark, Haiku Apr 16 → Apr 21: raw adversarial F1 0.883 → 0.861, −0.022 [−0.049, +0.002]; Acc(B) 0.900 → 0.878 (log). The interval includes zero but only just, and the identical-rerun adversarial swing was +0.022, so "held" means "did not measurably drop", not "unchanged".

Trajectory: `2026-04-11T22-18-00-398Z` → `2026-04-22T15-17-00-246Z`, Sonnet, raw paired.

- **Overall 0.615 → 0.665, +0.050** [+0.035, +0.065].
- **Multi-hop 0.347 → 0.453, +0.105** [+0.067, +0.143]; **single-hop 0.594 → 0.673, +0.079** [+0.056, +0.102]; **temporal 0.563 → 0.625, +0.062** [+0.021, +0.103]; open-domain 0.331 → 0.400, +0.068 [−0.002, +0.142].
- **Adversarial 0.922 → 0.870, −0.052** [−0.076, −0.027].

### Finding 8: what didn't help

All from the logs and `history.jsonl`, conv-26 single runs, reverted: exp10 (RRF weights), exp15/15b (score truncation), exp14 (relevance scores), exp-paper1 (set-union merging), exp5 (category-aware prompting), exp43 (semantic-only for inferential), exp31 (relative-to-absolute dates), exp12/13/35 (depth 50, limit 15, 100/20; exp34's 60/15 was adopted for recall), exp19/19b (grep tool; 19c standalone regex tool scored 0.675 vs 0.671 for the parameter and was replaced by 19e/19k), exp8b/2b/3b/22b (fact-extraction variants; exp22 was adopted before facts were removed altogether).

### Finding 9: open-domain

- **Two benchmark errors**: `locomo_5_qa43` (Minnesota) and `locomo_5_qa44` (Voyageurs National Park) in `data/locomo-errors.json`, commit `f2f0295`.
- Bird-feeder example and photo-dependent answers: exp43 analysis in the log.

## 4. What the numbers do not cover

- **Same-day model drift.** Each full-run config was run once, and consecutive checkpoints are on different days. A shift in the model behind the API that moved every question together would not appear in any per-question interval. The only identical-config repeat (3 hours apart) showed none; across days it is untested.
- **Attribution inside bundles.** Findings 3, 4, and 5 report the effect of everything that shipped between two checkpoints. Nothing isolates one change on the full benchmark.
- **Selection.** Every change was chosen on conv-26 and then measured on all ten conversations. The full-benchmark figures are therefore not held-out in the strict sense, but the other nine conversations were seen only at the ten checkpoints listed in §1, not during selection. Where the tuning conversation and the other nine disagree, the section reports the full-benchmark figure and notes the gap (finding 4).
- **Adversarial-only comparisons** on 446 questions have a wider floor (about ±0.024, from the identical rerun) than overall comparisons on 1,986.
- **Model versions.** Only the CLI alias is recorded. Comparisons across dates assume the alias resolved to the same model.
- **Error-corrected vs raw.** The corrected subset drops 164 questions, 5 of them our own adversarial corrections. On the headline run those 5 move adversarial F1 by +0.010 and overall by +0.002; the section's paired deltas are computed on raw scores and are unaffected.
