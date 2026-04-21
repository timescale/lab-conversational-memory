// Scoring wrapper — calls LoCoMo's exact Python scoring via subprocess.
// This avoids any risk of divergence from the original evaluation.py.

import { resolve } from "node:path";

const PYTHON = resolve(import.meta.dir, "../.venv/bin/python3");
const SCORER = resolve(import.meta.dir, "scorer.py");

interface ScoreInput {
  prediction: string;
  answer: string;
  category: number;
}

interface ScoreOutput {
  f1: number;
  em: number;
}

export async function scoreBatch(
  items: ScoreInput[],
): Promise<ScoreOutput[]> {
  const proc = Bun.spawn([PYTHON, SCORER], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(JSON.stringify(items));
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Scorer failed (exit ${exitCode}): ${stderr}`);
  }

  return JSON.parse(stdout) as ScoreOutput[];
}

export async function scoreQA(
  prediction: string,
  answer: string,
  category: number,
): Promise<{ f1: number; em: number }> {
  const [result] = await scoreBatch([{ prediction, answer, category }]);
  return result!;
}

// ---------------------------------------------------------------------------
// LLM-as-judge accuracy — runs on non-exact-match results only
// ---------------------------------------------------------------------------

interface JudgeInput {
  question: string;
  prediction: string;
  answer: string;
}

const JUDGE_SYSTEM = "You are a helpful research assistant.";

function buildJudgePrompt(input: JudgeInput): string {
  return `Your task is to evaluate an LLM's answer against a ground-truth answer and decide whether the ground-truth content is present in the model's response.

Instructions:
1. Carefully compare the Predicted Answer with the Ground-Truth Answer.
2. Judge based on substance and equivalence of meaning; do not require identical wording unless wording is crucial to meaning.
3. Make a binary decision on whether the vital facts of the ground-truth are contained in the predicted answer.

Input Data:
Question: ${input.question}
Predicted Answer: ${input.prediction}
Ground-Truth Answer: ${input.answer}

Output Format:
Provide your final evaluation in the following format:
Explanation: <brief rationale for the decision>
Decision: <yes|no>

Output:`;
}

export async function judgeBatch(
  items: JudgeInput[],
): Promise<Array<{ correct: boolean }>> {
  const CONCURRENCY = 20;
  const results: Array<{ correct: boolean }> = new Array(items.length);

  for (let batch = 0; batch < items.length; batch += CONCURRENCY) {
    const end = Math.min(batch + CONCURRENCY, items.length);
    const promises: Promise<void>[] = [];

    for (let i = batch; i < end; i++) {
      const item = items[i]!;
      const prompt = buildJudgePrompt(item);

      promises.push(
        (async () => {
          try {
            const proc = Bun.spawn(
              ["claude", "-p", prompt, "--output-format", "text", "--model", "haiku", "--system-prompt", JUDGE_SYSTEM],
              { stdout: "pipe", stderr: "pipe" },
            );
            const stdout = await new Response(proc.stdout).text();
            await proc.exited;

            const decisionMatch = stdout.match(/Decision:\s*<?(\w+)>?/i);
            const correct = decisionMatch
              ? decisionMatch[1]!.toLowerCase() === "yes"
              : false;

            results[i] = { correct };
          } catch {
            results[i] = { correct: false };
          }
        })(),
      );
    }

    await Promise.all(promises);
  }

  return results;
}
