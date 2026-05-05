#!/usr/bin/env node
/**
 * Portkey Config Test Script
 *
 * Tests the full Portkey Config setup:
 *   1. Environment variables (including PORTKEY_CONFIG_ID)
 *   2. Client init — x-portkey-config header attached
 *   3. Single request — Config connectivity
 *   4. Load balancing — 5 parallel requests (verify Portkey distributes them)
 *
 * Run from the ai-server/ directory:
 *   node scripts/test-portkey-config.js
 */

require('dotenv').config();

// ─── Colours ─────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  blue:   '\x1b[34m',
};

const ok   = (msg) => console.log(`  ${C.green}[PASS]${C.reset} ${msg}`);
const fail = (msg) => console.log(`  ${C.red}[FAIL]${C.reset} ${msg}`);
const info = (msg) => console.log(`  ${C.cyan}[INFO]${C.reset} ${msg}`);
const warn = (msg) => console.log(`  ${C.yellow}[WARN]${C.reset} ${msg}`);
const sep  = ()    => console.log(C.gray + '─'.repeat(60) + C.reset);

let passed = 0;
let failed = 0;

function assert(condition, passMsg, failMsg) {
  if (condition) { ok(passMsg); passed++; }
  else           { fail(failMsg); failed++; }
  return condition;
}

// ─── Test 1: Environment Config ───────────────────────────────────────────────
async function testEnvConfig() {
  console.log(`\n${C.bold}[1/4] Environment Configuration${C.reset}`);
  sep();

  const apiKey   = process.env.PORTKEY_API_KEY;
  const configId = process.env.PORTKEY_CONFIG_ID;
  const model    = process.env.PORTKEY_MODEL;

  assert(process.env.USE_PORTKEY === 'true',
    'USE_PORTKEY=true',
    `USE_PORTKEY="${process.env.USE_PORTKEY}" — must be "true"`);

  assert(apiKey && apiKey.length > 10,
    `PORTKEY_API_KEY set  (${apiKey ? apiKey.slice(0, 6) + '...' + apiKey.slice(-4) : 'missing'})`,
    'PORTKEY_API_KEY missing or too short');

  assert(configId && configId.startsWith('pc-'),
    `PORTKEY_CONFIG_ID="${configId}"`,
    `PORTKEY_CONFIG_ID="${configId}" — expected format: pc-xxxx (get from Portkey → Configs)`);

  assert(model && !model.startsWith('@'),
    `PORTKEY_MODEL="${model}" (plain model name — routing handled by config)`,
    `PORTKEY_MODEL="${model}" — remove @slug/ prefix, the config handles routing now`);
}

// ─── Test 2: Client Init + Config Header ──────────────────────────────────────
async function testClientInit() {
  console.log(`\n${C.bold}[2/4] Client Init — x-portkey-config Header${C.reset}`);
  sep();

  const { initializeClient, getPortkeyClient, isPortkeyEnabled } = require('../src/services/ai/ai-client');

  try {
    initializeClient();
    const client = getPortkeyClient();

    assert(client !== null,
      'Portkey client initialized',
      'Portkey client is null — check PORTKEY_API_KEY');

    // OpenAI SDK v4 stores constructor options in _options
    const storedHeaders = client._options?.defaultHeaders || {};
    const configHeader  = storedHeaders['x-portkey-config'];

    assert(
      configHeader === process.env.PORTKEY_CONFIG_ID,
      `x-portkey-config header = "${configHeader}"`,
      `x-portkey-config header missing or wrong — got: "${configHeader || 'undefined'}"`
    );

    info(`Portkey enabled : ${isPortkeyEnabled()}`);
  } catch (err) {
    fail(`Client init threw: ${err.message}`);
    failed++;
  }
}

// ─── Test 3: Single Request (Config connectivity) ─────────────────────────────
async function testSingleRequest() {
  console.log(`\n${C.bold}[3/4] Single Request — Config Connectivity${C.reset}`);
  sep();

  const { chatCompletionWithFallback } = require('../src/services/ai/ai-client');
  info(`Config  : ${process.env.PORTKEY_CONFIG_ID}`);
  info(`Model   : ${process.env.PORTKEY_MODEL}`);
  info('Sending single request...');

  const start = Date.now();
  try {
    const { response, provider, model } = await chatCompletionWithFallback({
      messages: [
        { role: 'user', content: 'Reply with exactly this text and nothing else: "config ok"' }
      ],
      // temperature intentionally omitted — GPT-5 family rejects non-default values
      max_tokens: 15,
      apiCallName: 'config-connectivity-test'
    });

    const duration = Date.now() - start;
    const content  = response.choices?.[0]?.message?.content?.trim() || '';
    const usage    = response.usage || {};

    assert(
      content.toLowerCase().includes('config ok'),
      `Response: "${content}"`,
      `Unexpected response: "${content}"`
    );
    ok(`Provider : ${provider}  |  Model : ${model}  |  ${duration}ms`);
    info(`Tokens — in: ${usage.prompt_tokens || '?'}, out: ${usage.completion_tokens || '?'}`);
  } catch (err) {
    fail(`Request failed: ${err.message}`);
    failed++;
  }
}

// ─── Test 4: Load Balancing (5 parallel requests) ─────────────────────────────
async function testLoadBalancing() {
  console.log(`\n${C.bold}[4/4] Load Balancing — 5 Parallel Requests${C.reset}`);
  sep();

  const { chatCompletionWithFallback } = require('../src/services/ai/ai-client');
  info('Sending 5 concurrent requests — Portkey splits them across google-key1 / google-key2...');

  const makeRequest = (n) => {
    const start = Date.now();
    return chatCompletionWithFallback({
      messages: [{ role: 'user', content: `Reply with exactly: "req${n} ok"` }],
      // temperature intentionally omitted — GPT-5 family rejects non-default values
      max_tokens: 10,
      apiCallName: `lb-test-${n}`
    })
      .then(({ response, provider }) => ({
        n,
        success: true,
        content:  response.choices?.[0]?.message?.content?.trim() || '',
        provider,
        ms: Date.now() - start
      }))
      .catch(err => ({ n, success: false, error: err.message, ms: Date.now() - start }));
  };

  const wallStart = Date.now();
  const results   = await Promise.all([1, 2, 3, 4, 5].map(makeRequest));
  const wallTime  = Date.now() - wallStart;

  results.forEach(r => {
    if (r.success) {
      ok(`Req ${r.n}: "${r.content}"  via ${r.provider}  ${r.ms}ms`);
    } else {
      fail(`Req ${r.n}: ${r.error}`);
    }
  });

  const successCount = results.filter(r => r.success).length;
  assert(
    successCount === 5,
    `All 5 requests succeeded  (wall time: ${wallTime}ms — ran in parallel)`,
    `Only ${successCount}/5 requests succeeded`
  );

  const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
  info(`Average latency: ${avgMs}ms per request`);
  warn('Key distribution is not visible from client side — open Portkey Analytics to');
  warn('confirm traffic is split between google-key1 and google-key2');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
async function run() {
  console.log(`\n${C.bold}${'═'.repeat(60)}${C.reset}`);
  console.log(`${C.bold}  PORTKEY CONFIG TEST${C.reset}`);
  console.log(`${C.bold}  Config : ${process.env.PORTKEY_CONFIG_ID || 'NOT SET'}${C.reset}`);
  console.log(`${C.bold}  Model  : ${process.env.PORTKEY_MODEL || 'NOT SET'}${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(60)}${C.reset}`);

  await testEnvConfig();
  await testClientInit();
  await testSingleRequest();
  await testLoadBalancing();

  console.log(`\n${C.bold}${'═'.repeat(60)}${C.reset}`);
  console.log(`${C.bold}  RESULTS${C.reset}`);
  sep();

  const total = passed + failed;
  if (failed === 0) {
    console.log(`  ${C.green}${C.bold}All ${total} checks passed ✓${C.reset}`);
    console.log(`\n  ${C.bold}How to verify load balance distribution:${C.reset}`);
    console.log(`  ${C.cyan}→ Open Portkey Analytics and look at requests split across google-key1 / google-key2${C.reset}`);
    console.log(`\n  ${C.bold}How to test Portkey-level fallback (google → openai):${C.reset}`);
    console.log(`  ${C.cyan}→ In Portkey Model Catalog, temporarily DISABLE google-key1 and google-key2${C.reset}`);
    console.log(`  ${C.cyan}→ Re-run Test 3 (node scripts/test-portkey-config.js) — it should still succeed via OpenAI${C.reset}`);
    console.log(`  ${C.cyan}→ Re-enable the Google keys when done${C.reset}`);
    console.log();
  } else {
    console.log(`  ${C.green}Passed: ${passed}${C.reset}  ${C.red}Failed: ${failed}${C.reset}  Total: ${total}`);
    console.log(`\n  ${C.yellow}Fix the issues above before deploying.${C.reset}\n`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error(`\n${C.red}Unhandled error:${C.reset}`, err.message);
  process.exit(1);
});
