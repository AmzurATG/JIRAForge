#!/usr/bin/env node
/**
 * Portkey Integration Test Script
 *
 * Verifies the Portkey AI Gateway is correctly configured and reachable.
 * Run from the ai-server directory:
 *
 *   node scripts/test-portkey.js
 *
 * Requirements:
 *   .env must have: USE_PORTKEY=true, PORTKEY_API_KEY, PORTKEY_MODEL
 */

require('dotenv').config();

// Force Portkey-only for this test — Fireworks is not being tested here
process.env.USE_FIREWORKS = 'false';

// ─── Colours ─────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

const ok   = (msg) => console.log(`  ${C.green}[PASS]${C.reset} ${msg}`);
const fail = (msg) => console.log(`  ${C.red}[FAIL]${C.reset} ${msg}`);
const info = (msg) => console.log(`  ${C.cyan}[INFO]${C.reset} ${msg}`);
const warn = (msg) => console.log(`  ${C.yellow}[WARN]${C.reset} ${msg}`);
const sep  = ()    => console.log(C.gray + '─'.repeat(60) + C.reset);

// ─── Helpers ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, passMsg, failMsg) {
  if (condition) {
    ok(passMsg);
    passed++;
  } else {
    fail(failMsg);
    failed++;
  }
  return condition;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testEnvConfig() {
  console.log(`\n${C.bold}[1/3] Environment Configuration${C.reset}`);
  sep();

  const apiKey = process.env.PORTKEY_API_KEY;
  const model  = process.env.PORTKEY_MODEL;
  const usePortkey = process.env.USE_PORTKEY;

  assert(usePortkey === 'true',
    'USE_PORTKEY=true',
    `USE_PORTKEY is "${usePortkey}" — must be "true"`);

  assert(apiKey && apiKey.length > 10,
    `PORTKEY_API_KEY is set (${apiKey ? apiKey.slice(0, 6) + '...' + apiKey.slice(-4) : 'missing'})`,
    'PORTKEY_API_KEY is missing or too short');

  const configId = process.env.PORTKEY_CONFIG_ID;
  if (configId) {
    // Config-based setup: plain model name is valid (e.g. gemini-2.0-flash)
    assert(!!model,
      `PORTKEY_MODEL="${model}" (config mode — plain model name expected)`,
      'PORTKEY_MODEL is missing');
    info(`PORTKEY_CONFIG_ID="${configId}" — config mode active`);
  } else {
    // Virtual-key / Model Catalog mode: must be @slug/model-name format
    assert(model && model.startsWith('@'),
      `PORTKEY_MODEL="${model}"`,
      `PORTKEY_MODEL="${model}" — expected format: @virtualKeySlug/model-name (or set PORTKEY_CONFIG_ID for config mode)`);
  }

  info('Fireworks disabled for this test (Portkey-only)');
}

async function testClientInit() {
  console.log(`\n${C.bold}[2/3] Client Initialisation${C.reset}`);
  sep();

  const { initializeClient, getPortkeyClient, getProviderStatus } = require('../src/services/ai/ai-client');

  try {
    initializeClient();
    const client = getPortkeyClient();

    assert(client !== null,
      'Portkey client initialised successfully',
      'Portkey client is null — check PORTKEY_API_KEY');

    const status = getProviderStatus();
    info(`Provider order: ${status.providerOrder.join(' → ')}`);
    info(`Current primary: ${status.currentPrimary}`);
    info(`Portkey enabled: ${status.portKeyEnabled}`);
    info(`Fireworks enabled: ${status.fireworksEnabled}`);

  } catch (err) {
    fail(`Client init threw: ${err.message}`);
    failed++;
  }
}

async function testSimpleCompletion() {
  console.log(`\n${C.bold}[3/3] Simple Text Completion (live API call)${C.reset}`);
  sep();

  const { chatCompletionWithFallback } = require('../src/services/ai/ai-client');

  const messages = [
    {
      role: 'system',
      content: 'You are a helpful assistant. Reply in plain text only, no markdown.'
    },
    {
      role: 'user',
      content: 'Reply with exactly this text and nothing else: "Portkey connection successful"'
    }
  ];

  info(`Model: ${process.env.PORTKEY_MODEL}`);
  info('Sending test request...');

  const start = Date.now();

  try {
    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      temperature: 0,
      max_tokens: 20,
      isVision: false,
      apiCallName: 'portkey-connection-test'
    });

    const duration = Date.now() - start;
    const content = response.choices?.[0]?.message?.content?.trim() || '';
    const usage = response.usage || {};

    assert(
      content.toLowerCase().includes('portkey connection successful'),
      `Got expected response: "${content}"`,
      `Unexpected response: "${content}"`
    );

    ok(`Provider used: ${provider}`);
    ok(`Latency: ${duration}ms`);
    info(`Tokens — prompt: ${usage.prompt_tokens || '?'}, completion: ${usage.completion_tokens || '?'}`);

  } catch (err) {
    fail(`API call failed: ${err.message}`);
    failed++;
    warn('Check that your PORTKEY_API_KEY is valid and the virtual key slug in PORTKEY_MODEL exists in Portkey\'s Model Catalog');
  }
}


// ─── Summary ─────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${C.bold}${'═'.repeat(60)}${C.reset}`);
  console.log(`${C.bold}  PORTKEY INTEGRATION TEST${C.reset}`);
  console.log(`${C.bold}${'═'.repeat(60)}${C.reset}`);

  await testEnvConfig();
  await testClientInit();
  await testSimpleCompletion();

  console.log(`\n${C.bold}${'═'.repeat(60)}${C.reset}`);
  console.log(`${C.bold}  RESULTS${C.reset}`);
  sep();

  const total = passed + failed;
  if (failed === 0) {
    console.log(`  ${C.green}${C.bold}All ${total} checks passed ✓${C.reset}`);
    console.log(`\n  ${C.cyan}Portkey is ready. Update your server .env and restart.${C.reset}\n`);
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
