'use strict';

// Mock the AI provider layer so no real provider/SDK is loaded.
jest.mock('../../src/services/ai', () => ({ chatCompletionWithFallback: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const ai = require('../../src/services/ai');
const svc = require('../../src/services/portal-app-suggest-service');

const ORIGINAL_FLAG = process.env.PORTAL_AI_APP_SUGGEST;
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.PORTAL_AI_APP_SUGGEST;
  else process.env.PORTAL_AI_APP_SUGGEST = ORIGINAL_FLAG;
  jest.clearAllMocks();
});

function aiReturns(content) {
  ai.chatCompletionWithFallback.mockResolvedValue({
    response: { choices: [{ message: { content } }] },
    provider: 'portkey',
    model: 'm',
  });
}

describe('safeParse / normalize', () => {
  test('parses strict JSON and normalizes fields', () => {
    const out = svc.safeParse(JSON.stringify({
      displayName: 'Notion',
      kinds: ['process', 'url'],
      processNames: ['Notion.exe'],
      domains: ['https://www.notion.so/app'],
      suggestedClassification: 'productive',
      confidence: 0.9,
      rationale: 'docs',
    }));
    expect(out.displayName).toBe('Notion');
    expect(out.processNames).toEqual(['notion.exe']); // lower-cased
    expect(out.domains).toEqual(['notion.so']);        // scheme/www/path stripped
    expect(out.kinds).toEqual(['process', 'url']);
    expect(out.suggestedClassification).toBe('productive');
    expect(out.confidence).toBe(0.9);
  });

  test('strips ```json fences and derives kinds from arrays', () => {
    const out = svc.safeParse('```json\n{"displayName":"Slack","processNames":["slack.exe"]}\n```');
    expect(out.displayName).toBe('Slack');
    expect(out.processNames).toEqual(['slack.exe']);
    expect(out.kinds).toEqual(['process']); // derived since none provided
  });

  test('malformed / empty content returns null', () => {
    expect(svc.safeParse('not json at all')).toBeNull();
    expect(svc.safeParse('')).toBeNull();
    expect(svc.safeParse(null)).toBeNull();
  });

  test('invalid classification → neutral; out-of-range confidence clamped', () => {
    const out = svc.safeParse(JSON.stringify({ displayName: 'X', suggestedClassification: 'banana', confidence: 5 }));
    expect(out.suggestedClassification).toBe('neutral');
    expect(out.confidence).toBe(1);
  });
});

describe('suggestApp', () => {
  test('flag off → null, no AI call', async () => {
    process.env.PORTAL_AI_APP_SUGGEST = 'off';
    const out = await svc.suggestApp('Notion');
    expect(out).toBeNull();
    expect(ai.chatCompletionWithFallback).not.toHaveBeenCalled();
  });

  test('flag on + valid JSON → parsed suggestion', async () => {
    process.env.PORTAL_AI_APP_SUGGEST = 'on';
    aiReturns(JSON.stringify({
      displayName: 'Notion', processNames: ['notion.exe'], domains: ['notion.so'],
      suggestedClassification: 'productive', confidence: 0.8,
    }));
    const out = await svc.suggestApp('Notion');
    expect(ai.chatCompletionWithFallback).toHaveBeenCalled();
    expect(out.displayName).toBe('Notion');
    expect(out.kinds).toEqual(['process', 'url']);
  });

  test('flag on + malformed provider output → null (no throw)', async () => {
    process.env.PORTAL_AI_APP_SUGGEST = 'on';
    aiReturns('the app is Notion, a productive tool'); // not JSON
    await expect(svc.suggestApp('Notion')).resolves.toBeNull();
  });

  test('flag on + provider throws → null (no throw)', async () => {
    process.env.PORTAL_AI_APP_SUGGEST = 'on';
    ai.chatCompletionWithFallback.mockRejectedValue(new Error('timeout'));
    await expect(svc.suggestApp('Notion')).resolves.toBeNull();
  });

  test('empty name → null, no AI call', async () => {
    process.env.PORTAL_AI_APP_SUGGEST = 'on';
    const out = await svc.suggestApp('   ');
    expect(out).toBeNull();
    expect(ai.chatCompletionWithFallback).not.toHaveBeenCalled();
  });
});
