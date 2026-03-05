'use strict';

// ---------------------------------------------------------------------------
// Mocks — hoisted before all imports by babel-jest
// ---------------------------------------------------------------------------

jest.mock('../../src/utils/remote.js', () => {
  const supabaseQuery = jest.fn();
  return {
    __esModule: true,
    supabaseQuery,
    // Expose so tests can reference the same instance
    _supabaseQuery: supabaseQuery,
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

const remote = require('../../src/utils/remote.js');
const mockSupabaseQuery = remote._supabaseQuery;

const { getSupabaseConfig, supabaseRequest } = require('../../src/utils/supabase/config.js');

// Silence console.error produced by the catch block in supabaseRequest
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.error.mockRestore();
});

// ---------------------------------------------------------------------------
// getSupabaseConfig
// ---------------------------------------------------------------------------

describe('getSupabaseConfig', () => {
  it('returns remote placeholder config regardless of accountId', async () => {
    const result = await getSupabaseConfig('user-123');
    expect(result).toEqual({
      url: 'remote:ai-server',
      serviceRoleKey: 'managed-by-ai-server',
      anonKey: 'managed-by-ai-server',
      isRemoteMode: true,
    });
  });

  it('works with null accountId', async () => {
    const result = await getSupabaseConfig(null);
    expect(result.isRemoteMode).toBe(true);
    expect(result.url).toBe('remote:ai-server');
  });

  it('works with undefined accountId', async () => {
    const result = await getSupabaseConfig(undefined);
    expect(result).toMatchObject({ isRemoteMode: true });
  });
});

// ---------------------------------------------------------------------------
// supabaseRequest — shared setup
// ---------------------------------------------------------------------------

describe('supabaseRequest', () => {
  const config = { url: 'remote:ai-server', isRemoteMode: true };

  beforeEach(() => {
    mockSupabaseQuery.mockReset();
    mockSupabaseQuery.mockResolvedValue([{ id: '1' }]);
  });

  // ── Endpoint parsing ──────────────────────────────────────────────────────

  describe('endpoint parsing', () => {
    it('passes table name correctly for endpoint with no query string', async () => {
      await supabaseRequest(config, 'screenshots');
      expect(mockSupabaseQuery).toHaveBeenCalledWith('screenshots', expect.objectContaining({ query: {} }));
    });

    it('handles endpoint with question mark but empty query string', async () => {
      await supabaseRequest(config, 'users?');
      expect(mockSupabaseQuery).toHaveBeenCalledWith('users', expect.objectContaining({ query: {} }));
    });
  });

  // ── order param ───────────────────────────────────────────────────────────

  describe('order param', () => {
    it('parses order with desc direction — ascending: false', async () => {
      await supabaseRequest(config, 'screenshots?order=work_date.desc');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'screenshots',
        expect.objectContaining({ query: { order: { column: 'work_date', ascending: false } } }),
      );
    });

    it('parses order with asc direction — ascending: true', async () => {
      await supabaseRequest(config, 'logs?order=created_at.asc');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'logs',
        expect.objectContaining({ query: { order: { column: 'created_at', ascending: true } } }),
      );
    });

    it('defaults order to ascending when no direction is specified', async () => {
      await supabaseRequest(config, 'users?order=name');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { order: { column: 'name', ascending: true } } }),
      );
    });

    it('handles column name containing dots (uses last dot as separator)', async () => {
      // value = "col.sub.desc" → lastIndexOf('.') splits on last dot
      await supabaseRequest(config, 'tbl?order=col.sub.desc');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'tbl',
        expect.objectContaining({ query: { order: { column: 'col.sub', ascending: false } } }),
      );
    });
  });

  // ── limit and offset ──────────────────────────────────────────────────────

  describe('limit param', () => {
    it('parses limit as integer', async () => {
      await supabaseRequest(config, 'users?limit=20');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { limit: 20 } }),
      );
    });
  });

  describe('offset param', () => {
    it('parses offset as integer', async () => {
      await supabaseRequest(config, 'users?offset=10');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { offset: 10 } }),
      );
    });
  });

  // ── select param ──────────────────────────────────────────────────────────

  describe('select param', () => {
    it('stores select into query._select', async () => {
      await supabaseRequest(config, 'users?select=id,name,email');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { _select: 'id,name,email' } }),
      );
    });

    it('stores wildcard select', async () => {
      await supabaseRequest(config, 'documents?select=*');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'documents',
        expect.objectContaining({ query: { _select: '*' } }),
      );
    });
  });

  // ── or param ─────────────────────────────────────────────────────────────

  describe('or param', () => {
    it('strips surrounding parentheses from the or value', async () => {
      await supabaseRequest(config, 'users?or=(name.eq.Alice,name.eq.Bob)');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { or: 'name.eq.Alice,name.eq.Bob' } }),
      );
    });

    it('leaves or value unchanged when it has no surrounding parens', async () => {
      await supabaseRequest(config, 'users?or=name.eq.Alice,name.eq.Bob');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { or: 'name.eq.Alice,name.eq.Bob' } }),
      );
    });

    it('strips only the leading paren when trailing paren is absent', async () => {
      await supabaseRequest(config, 'users?or=(name.eq.Alice');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { or: 'name.eq.Alice' } }),
      );
    });
  });

  // ── filter operators ──────────────────────────────────────────────────────

  describe('filter operators', () => {
    it('parses eq operator', async () => {
      await supabaseRequest(config, 'users?id=eq.abc123');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { eq: { id: 'abc123' } } }),
      );
    });

    it('parses neq operator', async () => {
      await supabaseRequest(config, 'users?status=neq.deleted');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { neq: { status: 'deleted' } } }),
      );
    });

    it('parses gt operator', async () => {
      await supabaseRequest(config, 'logs?count=gt.5');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'logs',
        expect.objectContaining({ query: { gt: { count: '5' } } }),
      );
    });

    it('parses gte operator', async () => {
      await supabaseRequest(config, 'logs?count=gte.5');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'logs',
        expect.objectContaining({ query: { gte: { count: '5' } } }),
      );
    });

    it('parses lt operator', async () => {
      await supabaseRequest(config, 'logs?count=lt.10');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'logs',
        expect.objectContaining({ query: { lt: { count: '10' } } }),
      );
    });

    it('parses lte operator', async () => {
      await supabaseRequest(config, 'logs?count=lte.10');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'logs',
        expect.objectContaining({ query: { lte: { count: '10' } } }),
      );
    });

    it('parses in operator — strips parens and splits on comma', async () => {
      await supabaseRequest(config, 'users?id=in.(1,2,3)');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { in: { id: ['1', '2', '3'] } } }),
      );
    });

    it('parses in operator with no surrounding parens', async () => {
      await supabaseRequest(config, 'users?id=in.1,2,3');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { in: { id: ['1', '2', '3'] } } }),
      );
    });

    it('parses is.null — sets value to null', async () => {
      await supabaseRequest(config, 'tasks?active_task_key=is.null');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'tasks',
        expect.objectContaining({ query: { is: { active_task_key: null } } }),
      );
    });

    it('parses is with non-null value — keeps the string', async () => {
      await supabaseRequest(config, 'tasks?flag=is.true');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'tasks',
        expect.objectContaining({ query: { is: { flag: 'true' } } }),
      );
    });

    it('parses not.is operator with null value', async () => {
      await supabaseRequest(config, 'tasks?active_task_key=not.is.null');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'tasks',
        expect.objectContaining({
          query: { not: { active_task_key: { operator: 'is', value: null } } },
        }),
      );
    });

    it('parses not.is operator with non-null value', async () => {
      await supabaseRequest(config, 'tasks?key=not.is.somevalue');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'tasks',
        expect.objectContaining({
          query: { not: { key: { operator: 'is', value: 'somevalue' } } },
        }),
      );
    });

    it('falls back to simple eq for unrecognised format', async () => {
      await supabaseRequest(config, 'users?name=Alice');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { eq: { name: 'Alice' } } }),
      );
    });

    it('accumulates multiple fields under the same operator', async () => {
      await supabaseRequest(config, 'users?id=eq.abc&name=eq.Alice');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ query: { eq: { id: 'abc', name: 'Alice' } } }),
      );
    });

    it('accumulates multiple not.is entries', async () => {
      await supabaseRequest(config, 'tasks?a=not.is.null&b=not.is.null');
      const call = mockSupabaseQuery.mock.calls[0][1];
      expect(call.query.not).toEqual({
        a: { operator: 'is', value: null },
        b: { operator: 'is', value: null },
      });
    });
  });

  // ── combined params ───────────────────────────────────────────────────────

  describe('combined query params', () => {
    it('handles multiple different params in a single query string', async () => {
      await supabaseRequest(config, 'users?id=eq.abc&status=neq.deleted&limit=10&offset=5');
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({
          query: {
            eq: { id: 'abc' },
            neq: { status: 'deleted' },
            limit: 10,
            offset: 5,
          },
        }),
      );
    });

    it('combines order, limit, offset, and filter together', async () => {
      await supabaseRequest(config, 'docs?order=created_at.desc&limit=5&id=eq.xyz');
      const call = mockSupabaseQuery.mock.calls[0][1];
      expect(call.query).toMatchObject({
        order: { column: 'created_at', ascending: false },
        limit: 5,
        eq: { id: 'xyz' },
      });
    });
  });

  // ── options handling ──────────────────────────────────────────────────────

  describe('options handling', () => {
    it('defaults method to GET when no options are provided', async () => {
      await supabaseRequest(config, 'users');
      expect(mockSupabaseQuery).toHaveBeenCalledWith('users', expect.objectContaining({ method: 'GET' }));
    });

    it('uses the method from options', async () => {
      await supabaseRequest(config, 'users', { method: 'POST', body: { name: 'Alice' } });
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ method: 'POST', body: { name: 'Alice' } }),
      );
    });

    it('passes PATCH method through', async () => {
      await supabaseRequest(config, 'users', { method: 'PATCH', body: { status: 'active' } });
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    it('passes DELETE method through', async () => {
      await supabaseRequest(config, 'users', { method: 'DELETE' });
      expect(mockSupabaseQuery).toHaveBeenCalledWith(
        'users',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('sets select to "*" when Prefer header includes return=representation', async () => {
      await supabaseRequest(config, 'users', { headers: { Prefer: 'return=representation' } });
      expect(mockSupabaseQuery).toHaveBeenCalledWith('users', expect.objectContaining({ select: '*' }));
    });

    it('sets select to undefined when there is no Prefer header', async () => {
      await supabaseRequest(config, 'users');
      expect(mockSupabaseQuery).toHaveBeenCalledWith('users', expect.objectContaining({ select: undefined }));
    });

    it('sets select to undefined when Prefer header does not include return=representation', async () => {
      await supabaseRequest(config, 'users', { headers: { Prefer: 'count=exact' } });
      expect(mockSupabaseQuery).toHaveBeenCalledWith('users', expect.objectContaining({ select: undefined }));
    });

    it('passes body as undefined when no options are provided', async () => {
      await supabaseRequest(config, 'users');
      expect(mockSupabaseQuery).toHaveBeenCalledWith('users', expect.objectContaining({ body: undefined }));
    });
  });

  // ── return value and error propagation ───────────────────────────────────

  describe('return value', () => {
    it('returns the result from supabaseQuery', async () => {
      const data = [{ id: '1', name: 'Alice' }];
      mockSupabaseQuery.mockResolvedValue(data);
      const result = await supabaseRequest(config, 'users');
      expect(result).toBe(data);
    });
  });

  describe('error propagation', () => {
    it('re-throws errors from supabaseQuery', async () => {
      mockSupabaseQuery.mockRejectedValue(new Error('Network error'));
      await expect(supabaseRequest(config, 'users')).rejects.toThrow('Network error');
    });

    it('logs the error before re-throwing', async () => {
      mockSupabaseQuery.mockRejectedValue(new Error('DB down'));
      await supabaseRequest(config, 'users').catch(() => {});
      expect(console.error).toHaveBeenCalledWith(
        '[Supabase] Remote request failed:',
        expect.any(Error),
      );
    });
  });
});
