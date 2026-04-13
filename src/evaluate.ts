import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { ingest, retrieve, buildPrompt } from "./memory.ts";

// Mode: "tool" = Claude searches via MCP tools, "context" = pre-retrieved context in prompt
const EVAL_MODE = (process.env.EVAL_MODE ?? "tool") as "tool" | "context";
import { scoreBatch } from "./scoring.ts";
import type { LoCoMoSample, QAResult, EvalRun } from "./types.ts";
import { CATEGORY_NAMES } from "./types.ts";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  let samples = Infinity;
  let description = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--samples" && args[i + 1]) {
      samples = Number.parseInt(args[i + 1]!);
      i++;
    } else if (args[i] === "--desc" && args[i + 1]) {
      description = args[i + 1]!;
      i++;
    }
  }

  return { samples, description };
}

// ---------------------------------------------------------------------------
// LLM answering
// ---------------------------------------------------------------------------


const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    recall: {
      command: "bun",
      args: ["src/mcp-server.ts"],
    },
  },
});

const MCP_TOOLS = "mcp__recall__me_memory_search,mcp__recall__me_memory_get,mcp__recall__me_memory_tree";

const TIMEOUT_MS = 240_000; // 4 minutes per question
const MAX_RETRIES = 2;

interface ClaudeResult {
  answer: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
}

async function askClaudeOnce(prompt: string, useMcp: boolean): Promise<ClaudeResult> {
  const JSON_SCHEMA = '{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}';
  const args = ["claude", "-p", prompt, "--output-format", "json", "--verbose", "--model", "sonnet", "--json-schema", JSON_SCHEMA];
  if (useMcp) {
    args.push("--mcp-config", MCP_CONFIG, "--strict-mcp-config", "--tools", MCP_TOOLS, "--allowedTools", MCP_TOOLS);
  }
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

  const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(stderr.slice(0, 200) || `exit code ${exitCode}`);
  }

  try {
    const events = JSON.parse(stdout);
    // --verbose returns an array of stream events
    const toolCalls: ClaudeResult["toolCalls"] = [];
    let answer = "";
    for (const evt of events) {
      if (evt.type === "assistant") {
        for (const block of evt.message?.content ?? []) {
          if (block.type === "tool_use") {
            toolCalls.push({ tool: block.name, args: block.input ?? {} });
          }
        }
      }
      if (evt.type === "result") {
        // Prefer structured_output.answer (from --json-schema), fallback to result
        answer = (evt.structured_output?.answer ?? evt.result ?? "").trim();
      }
    }
    return { answer, toolCalls };
  } catch {
    return { answer: stdout.trim(), toolCalls: [] };
  }
}

async function askClaude(prompt: string, useMcp: boolean): Promise<ClaudeResult> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await askClaudeOnce(prompt, useMcp);
    } catch (e: any) {
      if (attempt < MAX_RETRIES) {
        process.stderr.write(`  retry(${attempt + 1}) `);
      } else {
        console.error(`  claude failed after ${MAX_RETRIES + 1} attempts: ${e.message?.slice(0, 100)}`);
        return { answer: "", toolCalls: [] };
      }
    }
  }
  return { answer: "", toolCalls: [] };
}

// ---------------------------------------------------------------------------
// Aggregate helpers
// ---------------------------------------------------------------------------

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function aggregateByKey(
  results: QAResult[],
  keyFn: (r: QAResult) => string,
): Record<string, { count: number; f1: number; em: number }> {
  const groups = new Map<string, QAResult[]>();
  for (const r of results) {
    const key = keyFn(r);
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const out: Record<string, { count: number; f1: number; em: number }> = {};
  for (const [key, group] of groups) {
    out[key] = {
      count: group.length,
      f1: mean(group.map((r) => r.f1)),
      em: mean(group.map((r) => r.em)),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { samples: maxSamples, description } = parseArgs();

  // Load dataset
  const dataset: LoCoMoSample[] = JSON.parse(
    readFileSync("data/locomo10.json", "utf-8"),
  );
  const conversations = dataset.slice(0, maxSamples);

  // Load known benchmark errors for error-corrected metrics
  const locomoIdMap: Record<string, string> = {
    "conv-26": "locomo_0", "conv-30": "locomo_1", "conv-41": "locomo_2",
    "conv-42": "locomo_3", "conv-43": "locomo_4", "conv-44": "locomo_5",
    "conv-47": "locomo_6", "conv-48": "locomo_7", "conv-49": "locomo_8",
    "conv-50": "locomo_9",
  };
  let errorQuestions: Set<string> | null = null;
  const errorFiles = ["data/locomo-errors.json", "data/adversarial-errors.json"];
  try {
    errorQuestions = new Set<string>();
    for (const file of errorFiles) {
      try {
        const errors: Array<{ question_id: string; question: string }> = JSON.parse(
          readFileSync(file, "utf-8"),
        );
        for (const e of errors) {
          const m = e.question_id.match(/locomo_(\d+)/);
          if (m) {
            const sampleId = Object.entries(locomoIdMap).find(([, v]) => v === `locomo_${m[1]}`)?.[0];
            if (sampleId) {
              errorQuestions.add(`${sampleId}::${e.question}`);
            }
          }
        }
      } catch {}
    }
    console.log(`Loaded ${errorQuestions.size} known benchmark errors`);
  } catch {
    console.log("No benchmark error files found, skipping error correction");
  }

  console.log(
    `=== LoCoMo Memory Evaluation ===\nSamples: ${conversations.length}/${dataset.length}\n`,
  );

  // Connect (suppress NOTICE messages from BM25 index rebuilds)
  const sql = postgres(process.env.DATABASE_URL!, {
    onnotice: () => {},
  });

  const allResults: QAResult[] = [];

  for (const conv of conversations) {
    console.log(`--- ${conv.sample_id} ---`);

    // Clean slate
    let t0 = performance.now();
    await sql`TRUNCATE memory`;

    // Ingest
    await ingest(conv, sql);
    const [row] = await sql`SELECT count(*)::int as count FROM memory`;
    console.log(`  ${row!.count} memories stored (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

    const CONCURRENCY = 50;
    const predictions: Array<{ prediction: string; context: string; toolCalls: ClaudeResult["toolCalls"] }> = new Array(conv.qa.length);

    if (EVAL_MODE === "context") {
      // Pre-retrieve contexts, then answer with context in prompt
      t0 = performance.now();
      const RETRIEVE_CONCURRENCY = 10;
      const qaContexts: string[] = new Array(conv.qa.length);
      let retrieveCompleted = 0;
      for (let batch = 0; batch < conv.qa.length; batch += RETRIEVE_CONCURRENCY) {
        const end = Math.min(batch + RETRIEVE_CONCURRENCY, conv.qa.length);
        const promises = [];
        for (let qi = batch; qi < end; qi++) {
          const qa = conv.qa[qi]!;
          promises.push(
            retrieve(qa.question, sql).then((ctx) => {
              qaContexts[qi] = ctx;
              retrieveCompleted++;
              if (retrieveCompleted % 10 === 0 || retrieveCompleted === conv.qa.length) {
                process.stdout.write(`  Retrieve: ${retrieveCompleted}/${conv.qa.length}\n`);
              }
            }),
          );
        }
        await Promise.all(promises);
      }
      console.log(` (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

      t0 = performance.now();
      let completed = 0;
      for (let batch = 0; batch < conv.qa.length; batch += CONCURRENCY) {
        const end = Math.min(batch + CONCURRENCY, conv.qa.length);
        const promises = [];
        for (let qi = batch; qi < end; qi++) {
          const qa = conv.qa[qi]!;
          const context = qaContexts[qi]!;
          const prompt = buildPrompt(qa.question, context, qa.category);
          promises.push(
            askClaude(prompt, false).then((result) => {
              predictions[qi] = { prediction: result.answer, context, toolCalls: result.toolCalls };
              completed++;
              process.stdout.write(`  Answer: ${completed}/${conv.qa.length}\n`);
            }),
          );
        }
        await Promise.all(promises);
      }
      console.log(` (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
    } else {
      // Tool mode: Claude searches via MCP tools
      console.log(`  Mode: tool (Claude searches via MCP)`);
      t0 = performance.now();
      let completed = 0;
      for (let batch = 0; batch < conv.qa.length; batch += CONCURRENCY) {
        const end = Math.min(batch + CONCURRENCY, conv.qa.length);
        const promises = [];
        for (let qi = batch; qi < end; qi++) {
          const qa = conv.qa[qi]!;
          const prompt = buildPrompt(qa.question, "", qa.category);
          promises.push(
            askClaude(prompt, true).then((result) => {
              predictions[qi] = { prediction: result.answer, context: "(tool mode)", toolCalls: result.toolCalls };
              completed++;
              process.stdout.write(`  Answer: ${completed}/${conv.qa.length}\n`);
            }),
          );
        }
        await Promise.all(promises);
      }
      console.log(` (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
    }

    // Batch score with Python scorer (exact LoCoMo evaluation.py)
    t0 = performance.now();
    const scoreInputs = conv.qa.map((qa, i) => ({
      prediction: predictions[i]?.prediction ?? "",
      answer: String(qa.answer),
      category: qa.category,
    }));
    const scores = await scoreBatch(scoreInputs);
    console.log(`  Score: (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

    for (let i = 0; i < conv.qa.length; i++) {
      const qa = conv.qa[i]!;
      allResults.push({
        sampleId: conv.sample_id,
        question: qa.question,
        answer: qa.answer,
        prediction: predictions[i]!.prediction,
        category: qa.category,
        f1: scores[i]!.f1,
        em: scores[i]!.em,
        context: predictions[i]!.context,
        toolCalls: predictions[i]!.toolCalls,
      } as any);
    }

    // Per-sample summary
    const sampleResults = allResults.filter(
      (r) => r.sampleId === conv.sample_id,
    );
    console.log(
      `  F1=${mean(sampleResults.map((r) => r.f1)).toFixed(3)} EM=${mean(sampleResults.map((r) => r.em)).toFixed(3)} (${sampleResults.length} QA)\n`,
    );
  }

  // Error-corrected aggregates (primary — excludes known benchmark errors)
  const cleanResults = errorQuestions
    ? allResults.filter((r) => !errorQuestions.has(`${r.sampleId}::${r.question}`))
    : allResults;
  const errorExcluded = allResults.length - cleanResults.length;
  const overallF1 = mean(cleanResults.map((r) => r.f1));
  const overallEM = mean(cleanResults.map((r) => r.em));
  const byCategory = aggregateByKey(cleanResults, (r) => String(r.category));
  const bySample = aggregateByKey(cleanResults, (r) => r.sampleId);

  // Raw aggregates (supplementary — includes benchmark errors)
  const rawF1 = mean(allResults.map((r) => r.f1));
  const rawEM = mean(allResults.map((r) => r.em));
  const rawByCategory = aggregateByKey(allResults, (r) => String(r.category));

  // Print summary
  console.log("By Category:");
  for (const [cat, stats] of Object.entries(byCategory)) {
    const name = CATEGORY_NAMES[Number(cat)] ?? cat;
    const raw = rawByCategory[cat];
    const rawSuffix = raw && errorExcluded > 0 ? ` (raw: F1=${raw.f1.toFixed(3)} n=${raw.count})` : "";
    console.log(
      `  ${name} (${cat}): F1=${stats.f1.toFixed(3)} EM=${stats.em.toFixed(3)} (n=${stats.count})${rawSuffix}`,
    );
  }
  console.log(
    `\nOverall: F1=${overallF1.toFixed(3)} EM=${overallEM.toFixed(3)} (${cleanResults.length} QA)`,
  );
  if (errorExcluded > 0) {
    console.log(
      `Raw (incl. benchmark errors): F1=${rawF1.toFixed(3)} EM=${rawEM.toFixed(3)} (${allResults.length} QA, ${errorExcluded} errors excluded)\n`,
    );
  } else {
    console.log();
  }

  // Build eval run
  const timestamp = new Date().toISOString();
  const memoryTsSource = readFileSync("src/memory.ts", "utf-8");

  const evalRun = {
    timestamp,
    samples: conversations.length,
    totalQA: cleanResults.length,
    overallF1,
    overallEM,
    raw: errorExcluded > 0 ? {
      f1: rawF1,
      em: rawEM,
      totalQA: allResults.length,
      errorsExcluded: errorExcluded,
    } : undefined,
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [Number(k), v]),
    ),
    bySample,
    description,
    results: allResults,
  };

  // Save detailed results
  mkdirSync("results", { recursive: true });
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const resultPath = `results/eval-${safeTimestamp}.json`;
  writeFileSync(resultPath, JSON.stringify(evalRun, null, 2));

  // Append to history log
  const memoryHash = createHash("sha256")
    .update(memoryTsSource)
    .digest("hex")
    .slice(0, 12);
  const historyLine = JSON.stringify({
    timestamp,
    f1: Number(overallF1.toFixed(4)),
    em: Number(overallEM.toFixed(4)),
    raw_f1: Number(rawF1.toFixed(4)),
    raw_em: Number(rawEM.toFixed(4)),
    samples: conversations.length,
    qa: cleanResults.length,
    qa_total: allResults.length,
    errors_excluded: errorExcluded,
    description,
    memory_ts_hash: memoryHash,
  });
  appendFileSync("results/history.jsonl", historyLine + "\n");

  console.log(`Results saved to ${resultPath}`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
