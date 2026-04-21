// Re-score an existing eval run with LLM-as-judge accuracy.
// Usage: bun src/rescore-accuracy.ts results/eval-2026-04-16T10-49-32-709Z.json

import { readFileSync, writeFileSync } from "node:fs";
import { judgeBatch } from "./scoring.ts";
import { CATEGORY_NAMES } from "./types.ts";

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: bun src/rescore-accuracy.ts <eval-result.json>");
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(filePath, "utf-8"));
  const results: Array<{
    question: string;
    answer: string;
    prediction: string;
    category: number;
    f1: number;
    em: number;
    sampleId: string;
  }> = data.results;

  console.log(`Loaded ${results.length} results from ${filePath}`);

  // Identify non-exact-match results that need judging
  const judgeIndices: number[] = [];
  const judgeInputs: Array<{ question: string; prediction: string; answer: string }> = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.em === 0 && r.prediction.length > 0) {
      judgeIndices.push(i);
      judgeInputs.push({
        question: r.question,
        prediction: r.prediction,
        answer: String(r.answer),
      });
    }
  }

  console.log(`EM=1: ${results.length - judgeIndices.length} (auto-correct)`);
  console.log(`EM=0 to judge: ${judgeInputs.length}`);
  console.log(`\nRunning judge on ${judgeInputs.length} questions...`);

  const t0 = performance.now();
  const judgeResults = await judgeBatch(judgeInputs);
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`Judge complete (${elapsed}s)\n`);

  // Build accuracy array
  const accuracy: number[] = new Array(results.length);
  const judgeMap = new Map<number, boolean>();
  for (let j = 0; j < judgeIndices.length; j++) {
    judgeMap.set(judgeIndices[j]!, judgeResults[j]!.correct);
  }
  for (let i = 0; i < results.length; i++) {
    accuracy[i] = results[i]!.em === 1 ? 1 : (judgeMap.get(i) ? 1 : 0);
  }

  // Load error questions for error-corrected metrics
  const locomoIdMap: Record<string, string> = {
    "conv-26": "locomo_0", "conv-30": "locomo_1", "conv-41": "locomo_2",
    "conv-42": "locomo_3", "conv-43": "locomo_4", "conv-44": "locomo_5",
    "conv-47": "locomo_6", "conv-48": "locomo_7", "conv-49": "locomo_8",
    "conv-50": "locomo_9",
  };
  const errorQuestions = new Set<string>();
  for (const file of ["data/locomo-errors.json", "data/adversarial-errors.json"]) {
    try {
      const errors: Array<{ question_id: string; question: string }> = JSON.parse(
        readFileSync(file, "utf-8"),
      );
      for (const e of errors) {
        const m = e.question_id.match(/locomo_(\d+)/);
        if (m) {
          const sampleId = Object.entries(locomoIdMap).find(([, v]) => v === `locomo_${m[1]}`)?.[0];
          if (sampleId) errorQuestions.add(`${sampleId}::${e.question}`);
        }
      }
    } catch {}
  }

  // Aggregate
  const cleanIndices = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !errorQuestions.has(`${r.sampleId}::${r.question}`));

  const overallAcc = mean(cleanIndices.map(({ i }) => accuracy[i]!));
  const rawAcc = mean(accuracy);

  // By category (error-corrected)
  const byCat = new Map<number, number[]>();
  for (const { r, i } of cleanIndices) {
    const arr = byCat.get(r.category) ?? [];
    arr.push(accuracy[i]!);
    byCat.set(r.category, arr);
  }

  console.log("By Category (error-corrected):");
  for (const [cat, accs] of [...byCat.entries()].sort((a, b) => a[0] - b[0])) {
    const name = CATEGORY_NAMES[cat] ?? String(cat);
    console.log(`  ${name} (${cat}): Acc=${mean(accs).toFixed(3)} (n=${accs.length})`);
  }
  console.log(`\nOverall (error-corrected): Acc=${overallAcc.toFixed(3)} (${cleanIndices.length} QA)`);
  console.log(`Raw (all): Acc=${rawAcc.toFixed(3)} (${results.length} QA)`);

  // Save accuracy-augmented results
  const outPath = filePath.replace(".json", "-accuracy.json");
  const augmented = results.map((r, i) => ({ ...r, accuracy: accuracy[i] }));
  data.results = augmented;
  data.overallAccuracy = overallAcc;
  data.rawAccuracy = rawAcc;
  writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
