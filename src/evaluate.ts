import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { ingest, retrieve, buildPrompt } from "./memory.ts";
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


// MCP config for memory tool — enable by adding to askClaude args:
//   "--mcp-config", MCP_CONFIG, "--allowedTools", "mcp__memory__get_memory_by_id"
const MCP_CONFIG = JSON.stringify({
  mcpServers: {
    memory: {
      command: "bun",
      args: ["src/mcp-server.ts"],
    },
  },
});

async function askClaude(prompt: string): Promise<string> {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--output-format", "text", "--model", "sonnet"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`  claude error: ${stderr.slice(0, 200)}`);
    return "";
  }
  return stdout.trim();
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

    // Retrieve contexts in parallel
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
              process.stdout.write(`\r  Retrieve: ${retrieveCompleted}/${conv.qa.length}`);
            }
          }),
        );
      }
      await Promise.all(promises);
    }
    console.log(` (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

    // Ask Claude in parallel (CONCURRENCY concurrent processes)
    t0 = performance.now();
    const CONCURRENCY = 50;
    const predictions: Array<{ prediction: string; context: string }> = new Array(conv.qa.length);
    let completed = 0;
    for (let batch = 0; batch < conv.qa.length; batch += CONCURRENCY) {
      const end = Math.min(batch + CONCURRENCY, conv.qa.length);
      const promises = [];
      for (let qi = batch; qi < end; qi++) {
        const qa = conv.qa[qi]!;
        const context = qaContexts[qi]!;
        const prompt = buildPrompt(qa.question, context, qa.category);
        promises.push(
          askClaude(prompt).then((prediction) => {
            predictions[qi] = { prediction, context };
            completed++;
            process.stdout.write(`\r  Answer: ${completed}/${conv.qa.length}`);
          }),
        );
      }
      await Promise.all(promises);
    }
    console.log(` (${((performance.now() - t0) / 1000).toFixed(1)}s)`);

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
      });
    }

    // Per-sample summary
    const sampleResults = allResults.filter(
      (r) => r.sampleId === conv.sample_id,
    );
    console.log(
      `  F1=${mean(sampleResults.map((r) => r.f1)).toFixed(3)} EM=${mean(sampleResults.map((r) => r.em)).toFixed(3)} (${sampleResults.length} QA)\n`,
    );
  }

  // Overall aggregates
  const overallF1 = mean(allResults.map((r) => r.f1));
  const overallEM = mean(allResults.map((r) => r.em));
  const byCategory = aggregateByKey(allResults, (r) => String(r.category));
  const bySample = aggregateByKey(allResults, (r) => r.sampleId);

  // Print summary
  console.log("By Category:");
  for (const [cat, stats] of Object.entries(byCategory)) {
    const name = CATEGORY_NAMES[Number(cat)] ?? cat;
    console.log(
      `  ${name} (${cat}): F1=${stats.f1.toFixed(3)} EM=${stats.em.toFixed(3)} (n=${stats.count})`,
    );
  }
  console.log(
    `\nOverall: F1=${overallF1.toFixed(3)} EM=${overallEM.toFixed(3)} (${allResults.length} QA)\n`,
  );

  // Build eval run
  const timestamp = new Date().toISOString();
  const memoryTsSource = readFileSync("src/memory.ts", "utf-8");

  const evalRun: EvalRun = {
    timestamp,
    samples: conversations.length,
    totalQA: allResults.length,
    overallF1,
    overallEM,
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
    samples: conversations.length,
    qa: allResults.length,
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
