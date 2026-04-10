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
