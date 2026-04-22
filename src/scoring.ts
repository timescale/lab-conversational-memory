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

// Prompt B: generous grading with JSON output.
// Used by Mem0 (2025) and APEX-MEM for LoCoMo evaluation.
function buildJudgePromptB(input: JudgeInput): string {
  return `Your task is to label an answer to a question as "CORRECT" or "WRONG". You will be given the following data: (1) a question (posed by one user to another user), (2) a 'gold' (ground truth) answer, (3) a generated answer which you will score as CORRECT/WRONG.
The point of the question is to ask about something one user should know about the other user based on their prior conversations. The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.
For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like 'last Tuesday' or 'next month'), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., 'May 7th' vs '7 May'), consider it CORRECT if it's the same date.
Now it's time for the real question:
Question: ${input.question}
Gold answer: ${input.answer}
Generated answer: ${input.prediction}
First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG. Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.
Just return the label CORRECT or WRONG in a json format with the key as "label".`;
}

export type JudgePrompt = "A" | "B";
export type JudgeModel = "haiku" | "gpt-4o-mini";

async function judgeViaClaude(
  prompt: string,
  useJson: boolean,
  jsonSchema: string,
): Promise<boolean> {
  const args = ["claude", "-p", prompt, "--model", "haiku", "--system-prompt", JUDGE_SYSTEM];
  if (useJson) {
    args.push("--output-format", "json", "--json-schema", jsonSchema);
  } else {
    args.push("--output-format", "text");
  }
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  if (useJson) {
    try {
      const parsed = JSON.parse(stdout);
      return (parsed.structured_output?.label ?? parsed.label ?? parsed.result ?? "").toUpperCase() === "CORRECT";
    } catch {
      return stdout.toUpperCase().includes("CORRECT") && !stdout.toUpperCase().includes("WRONG");
    }
  } else {
    const decisionMatch = stdout.match(/Decision:\s*<?(\w+)>?/i);
    return decisionMatch ? decisionMatch[1]!.toLowerCase() === "yes" : false;
  }
}

async function judgeViaOpenAI(
  prompt: string,
  useJson: boolean,
): Promise<boolean> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY required for gpt-4o-mini judge");

  const body: Record<string, unknown> = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: prompt },
    ],
    max_tokens: 300,
    temperature: 0,
  };
  if (useJson) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices[0]?.message?.content ?? "";

  if (useJson) {
    try {
      const parsed = JSON.parse(content);
      return (parsed.label ?? "").toUpperCase() === "CORRECT";
    } catch {
      return content.toUpperCase().includes("CORRECT") && !content.toUpperCase().includes("WRONG");
    }
  } else {
    const decisionMatch = content.match(/Decision:\s*<?(\w+)>?/i);
    return decisionMatch ? decisionMatch[1]!.toLowerCase() === "yes" : false;
  }
}

export async function judgeBatch(
  items: JudgeInput[],
  promptVariant: JudgePrompt = "A",
  judgeModel: JudgeModel = "gpt-4o-mini",
): Promise<Array<{ correct: boolean }>> {
  const CONCURRENCY = judgeModel === "gpt-4o-mini" ? 50 : 20;
  const results: Array<{ correct: boolean }> = new Array(items.length);

  const buildPrompt = promptVariant === "B" ? buildJudgePromptB : buildJudgePrompt;
  const useJson = promptVariant === "B";
  const JSON_SCHEMA = '{"type":"object","properties":{"label":{"type":"string","enum":["CORRECT","WRONG"]}},"required":["label"]}';

  for (let batch = 0; batch < items.length; batch += CONCURRENCY) {
    const end = Math.min(batch + CONCURRENCY, items.length);
    const promises: Promise<void>[] = [];

    for (let i = batch; i < end; i++) {
      const item = items[i]!;
      const prompt = buildPrompt(item);

      promises.push(
        (async () => {
          try {
            const correct = judgeModel === "gpt-4o-mini"
              ? await judgeViaOpenAI(prompt, useJson)
              : await judgeViaClaude(prompt, useJson, JSON_SCHEMA);
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
