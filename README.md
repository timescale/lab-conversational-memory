# Lab: Conversational Memory

An experimental harness for improving long-term conversational memory in AI agents, evaluated against the [LoCoMo](https://arxiv.org/abs/2402.09146) benchmark.

Instead of designing a memory system upfront, this repo runs an **autoresearch loop**: an agent forms a hypothesis, changes the retrieval code, runs an eval, and compares results against baseline — one experiment at a time, all logged in `experimental_log.md`.

## What's here

- Agentic search over a single Postgres table (vector + BM25 + ltree + temporal ranges), exposed to the agent as MCP tools, instead of a fixed retrieval pipeline
- `src/memory.ts` and `src/mcp-server.ts` are the experiment surface — everything else is fixed infrastructure
- `blog_autoresearch.md` — full writeup of the method and how the harness was built

This is a research lab, not a finished product. Code and results change as experiments land; see `results/history.jsonl` for the run history.

## Quick Start

```bash
bun install
bun run setup          # download dataset + create DB schema (run once)
bun run eval:quick     # evaluate on 2 samples (fast iteration)
bun run eval           # evaluate on all 10 samples (full run)
```

Requires a `.env` with `DATABASE_URL` (Postgres) and `OPENAI_API_KEY` (embeddings). QA answering runs through `claude -p` (Claude Code CLI), so no separate LLM API key is needed for that part.

See `program.md` for research background and experiment ideas, and `CLAUDE.md` for the full workflow this repo is built around.
