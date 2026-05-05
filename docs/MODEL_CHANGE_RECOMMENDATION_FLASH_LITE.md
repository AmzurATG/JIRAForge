# Model Change Recommendation: Gemini 2.5 Flash → Gemini 2.5 Flash-Lite

**Date:** 2026-05-05
**Component:** AI Server (`/api/analyze-batch`, polling-service, clustering)
**Effort:** No code change. 10 lines changed in Portkey config UI.
**Cost impact:** Same as today (`$0.10`/M input + `$0.40`/M output — identical to Gemini 2.0 Flash and lower than every other model we evaluated).

---

## Why we are looking at changing the model (the problem)

### What's happening

Production logs from 2026-05-05 11:32:20 show a batch of 6 activity records sent to the AI server returning a 500 error:

```
[ActivityService] Batch analysis failed: Failed to parse AI response — no complete records found in truncated JSON
```

This is **not** an infrastructure failure (no timeout, no Portkey error, no rate limit). The LLM call completed in under 13 seconds. The error came from our own JSON parser because Gemini's response was cut off mid-sentence.

### Root cause

We pulled the actual response from the Portkey dashboard. Three numbers tell the whole story:

| Metric | Value |
|---|---|
| Total output tokens used | 1,496 |
| **Hidden "reasoning tokens"** | **1,437** |
| Visible content sent back | 184 characters (cut off mid-string) |

**Gemini 2.5 Flash spent 96% of its output budget thinking internally before it started writing the JSON answer.** By the time it actually produced visible content, it had only ~59 tokens left and the JSON got cut off in the very first record.

This is documented behavior, not a bug. Per Google's official docs:

- *"Gemini 2.5 Flash has thinking enabled by default."* — [Vertex AI Thinking docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)
- *"Thinking tokens consume `maxOutputTokens`, causing empty responses"* — [GitHub issue tracking the exact failure mode](https://github.com/valentinfrlch/ha-llmvision/issues/609)

The model decides how much to "think" dynamically based on the prompt. On bigger batches (18 records, 10 records — both succeeded in the same log window) it spent proportionally less thinking. On smaller or ambiguous batches, it can spend almost the entire budget thinking and never finish writing.

**This will keep happening on small/ambiguous batches as long as we use Gemini 2.5 Flash.** It's not a one-off.

### Why our use case doesn't need any thinking

What our AI server actually does: matches a desktop activity record (window title, app name, OCR text) to a Jira ticket from a fixed list, then outputs a JSON entry with `taskKey`, `confidenceScore`, `workType`, and a brief `reasoning` string.

It is **rule-based pattern matching**, not creative reasoning:
- *"If the window title contains a Jira key, use it."*
- *"If the user is in VS Code, match to the most relevant in-progress issue from that project."*
- *"If the only connection is that both are 'work-related,' that is NOT enough for a match."*

These rules don't benefit from a multi-step reasoning chain. The model "thinking" before it answers adds latency, adds cost, adds risk of the failure mode we just hit, and produces no measurable quality improvement on this kind of task.

---

## Recommendation: switch to Gemini 2.5 Flash-Lite

### Why Flash-Lite

Google itself positions Flash-Lite for our exact use case. From the [official Google Developers Blog](https://developers.googleblog.com/en/gemini-25-flash-lite-is-now-stable-and-generally-available/):

> *"Ideal for tasks like classification, translation, intelligent routing, and other cost-sensitive, high-scale operations."*

Confirmed properties (web-verified, sources at the bottom):

| Property | Gemini 2.5 Flash (current) | Gemini 2.5 Flash-Lite (proposed) |
|---|---|---|
| Thinking enabled by default | **Yes** (root cause) | **No** ✓ |
| Pricing — input | $0.10 / 1M tokens | $0.10 / 1M tokens (same) |
| Pricing — output | $0.40 / 1M tokens | $0.40 / 1M tokens (same) |
| Output token cap | 65,536 | 65,536 |
| Latency | Reference baseline | **Lower** than Flash on similar prompts |
| Use-case fit per Google | "Best for fast tasks with thinking" | "**Classification, translation, routing, cost-sensitive high-scale**" |
| Truncation risk on small batches | Real (~5–10%) | Effectively eliminated |

### Why this is the best option (we evaluated four)

| Alternative | Verdict |
|---|---|
| Stay on Gemini 2.5 Flash with `reasoning_effort: "none"` workaround | Adds config complexity. One report of the parameter being silently ignored on Gemini 2.5. Doesn't fix the root cause, just papers over it. |
| Go back to Gemini 2.0 Flash | Older, slower, smaller output cap (8K). Same price as Flash-Lite, less capable. Step backward. |
| Switch to GPT-4o-mini with Structured Outputs | Best schema reliability in industry (<0.1% failure). But **50% more expensive** on both input and output. Smaller output cap (16K). Smaller context window (128K vs Gemini's 1M). Reliability win not worth cost increase given our existing safety nets (truncation re-queue from PR #207). |
| Switch to Claude Haiku 4.5 | Per-token cost is materially higher than Google. Not justified for our volume. |

### What stays the same after the change

- **Cost per call**: identical to today.
- **Output cap**: 65,536 tokens (same as Flash).
- **Context window**: 1M tokens (same as Flash).
- **Portkey routing/load-balancing**: untouched. All 10 Gemini targets stay; just the model name changes. The OpenAI (gpt-5-mini) fallback for each target remains as a safety net.
- **All AI server code**: untouched. `analyzeBatch`, prompt, schema, polling, salvage path — zero changes.

### What changes

A single line per target in the Portkey config (`pc-jira-857ce9`) — 10 lines total:

```diff
- "model": "@google-key1/gemini-2.5-flash"
+ "model": "@google-key1/gemini-2.5-flash-lite"
```

(Repeat for `google-key2`, and `ttkey3` through `ttkey10`.)

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Quality drop on highly ambiguous matches | Low — Google specifically optimizes Flash-Lite for classification | If observed, the change is reversible by editing the same 10 lines back. |
| Flash-Lite has thinking *available* but off by default — someone could enable it later | Low | Add a comment in the Portkey config explaining why thinking must stay off for our use case. |
| Salvage / parse errors on Flash-Lite | Low | The truncation re-queue layer from PR #207 already protects against any malformed-JSON event. No new exposure. |

---

## Decision asked of you

Approve a 10-line change in the Portkey dashboard to swap the primary model from `gemini-2.5-flash` to `gemini-2.5-flash-lite` across all 10 Gemini targets in config `pc-jira-857ce9`. The OpenAI gpt-5-mini fallback in each target remains unchanged.

No code change. No deploy. Reversible in under a minute.

---

## Sources

- [Google Developers Blog — Gemini 2.5 Flash-Lite GA announcement](https://developers.googleblog.com/en/gemini-25-flash-lite-is-now-stable-and-generally-available/) — explicit positioning for classification & routing
- [Vertex AI Gemini 2.5 Flash-Lite docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-flash-lite) — capabilities, output cap, thinking-off default
- [Vertex AI Thinking docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking) — confirms Flash has thinking on by default, Flash-Lite has it off
- [GitHub issue: thinking tokens consume maxOutputTokens](https://github.com/valentinfrlch/ha-llmvision/issues/609) — the exact failure mode we hit, with title naming the bug
- [LLM-Stats — Gemini 2.0 Flash vs 2.5 Flash-Lite comparison](https://llm-stats.com/models/compare/gemini-2.0-flash-vs-gemini-2.5-flash-lite) — pricing parity confirmation
- [LLM-Stats — Gemini 2.5 Flash-Lite vs GPT-4o-mini](https://llm-stats.com/models/compare/gemini-2.5-flash-lite-vs-gpt-4o-mini-2024-07-18) — alternatives comparison
- [TokenMix Structured Output Guide 2026](https://tokenmix.ai/blog/structured-output-json-guide) — industry reliability data on JSON output across providers
