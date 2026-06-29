'use strict';

const mockKvsGet = jest.fn();
const mockKvsSet = jest.fn().mockResolvedValue(undefined);
const mockKvsDelete = jest.fn().mockResolvedValue(undefined);

jest.mock('@forge/kvs', () => ({
  kvs: {
    get: (...a) => mockKvsGet(...a),
    set: (...a) => mockKvsSet(...a),
    delete: (...a) => mockKvsDelete(...a)
  }
}));

const mockSupabaseQuery = jest.fn();
jest.mock('../../src/utils/remote.js', () => ({
  supabaseQuery: (...args) => mockSupabaseQuery(...args)
}));

const { registerDqNudgePreferenceResolvers } = require('../../src/resolvers/dqNudgePreferenceResolvers.js');

function makeResolver() {
  const map = new Map();
  return {
    define(name, h) { map.set(name, h); },
    invoke(name, req) { return map.get(name)(req); }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockKvsGet.mockResolvedValue(null);
});

const CTX = { accountId: 'acct-1', cloudId: 'cloud-1' };

// ---------------------------------------------------------------------------
// getDqNudgePreferences
// ---------------------------------------------------------------------------
describe('getDqNudgePreferences', () => {
  test('returns DEFAULTS when no server row exists', async () => {
    mockSupabaseQuery.mockResolvedValue({ data: [] });
    const r = makeResolver();
    registerDqNudgePreferenceResolvers(r);
    const res = await r.invoke('getDqNudgePreferences', { context: CTX });
    expect(res.success).toBe(true);
    expect(res.preferences).toEqual({ bellEnabled: true, popupEnabled: true });
  });

  test('returns existing preferences from server', async () => {
    mockSupabaseQuery.mockResolvedValue({
      data: [{ bell_enabled: false, popup_enabled: true }]
    });
    const r = makeResolver();
    registerDqNudgePreferenceResolvers(r);
    const res = await r.invoke('getDqNudgePreferences', { context: CTX });
    expect(res.preferences).toEqual({ bellEnabled: false, popupEnabled: true });
  });

  test('hits cache on second call', async () => {
    mockSupabaseQuery.mockResolvedValue({ data: [{ bell_enabled: true, popup_enabled: true }] });
    const r = makeResolver();
    registerDqNudgePreferenceResolvers(r);
    await r.invoke('getDqNudgePreferences', { context: CTX });
    expect(mockKvsSet).toHaveBeenCalled();
    // Wire the cache: subsequent get returns the cached entry.
    const setCall = mockKvsSet.mock.calls[0][1];
    mockKvsGet.mockResolvedValue(setCall);
    await r.invoke('getDqNudgePreferences', { context: CTX });
    expect(mockSupabaseQuery).toHaveBeenCalledTimes(1); // only the first call hit the server
  });

  test('soft-fails to defaults on error', async () => {
    mockSupabaseQuery.mockRejectedValue(new Error('boom'));
    const r = makeResolver();
    registerDqNudgePreferenceResolvers(r);
    const res = await r.invoke('getDqNudgePreferences', { context: CTX });
    expect(res.success).toBe(true);
    expect(res.fallback).toBe(true);
    expect(res.preferences).toEqual({ bellEnabled: true, popupEnabled: true });
  });

  test('returns error when context missing', async () => {
    const r = makeResolver();
    registerDqNudgePreferenceResolvers(r);
    const res = await r.invoke('getDqNudgePreferences', { context: {} });
    expect(res.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setDqNudgePreferences
// ---------------------------------------------------------------------------
describe('setDqNudgePreferences', () => {
  test('rejects empty payload', async () => {
    const r = makeResolver();
    registerDqNudgePreferenceResolvers(r);
    const res = await r.invoke('setDqNudgePreferences', { payload: {}, context: CTX });
    expect(res.success).toBe(false);
  });

  test('rejects non-boolean values', async () => {
    const r = makeResolver();
    registerDqNudgePreferenceResolvers(r);
    const res = await r.invoke('setDqNudgePreferences', {
      payload: { bellEnabled: 'yes' }, context: CTX
    });
    expect(res.success).toBe(false);
  });

  test('partial update merges with existing', async () => {
    // First call (loadFromServer) returns existing prefs.
    mockSupabaseQuery
      .mockResolvedValueOnce({ data: [{ bell_enabled: true, popup_enabled: true }] })
      .mockResolvedValueOnce({ data: null }); // saveToServer POST

    const r = makeResolver();
    registerDqNudgePreferenceResolvers(r);
    const res = await r.invoke('setDqNudgePreferences', {
      payload: { popupEnabled: false }, context: CTX
    });
    expect(res.success).toBe(true);
    expect(res.preferences).toEqual({ bellEnabled: true, popupEnabled: false });

    // The POST body should reflect the merged state.
    const postCall = mockSupabaseQuery.mock.calls[1];
    expect(postCall[1].method).toBe('POST');
    expect(postCall[1].body.bell_enabled).toBe(true);
    expect(postCall[1].body.popup_enabled).toBe(false);
  });
});
