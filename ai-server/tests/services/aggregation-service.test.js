'use strict';

const aggregationService = require('../../src/services/db/aggregation-service');
const { getClient } = require('../../src/services/db/supabase-client');

jest.mock('../../src/services/db/supabase-client');

describe('Aggregation Service - Consistency (AC4, AC5)', () => {
  let mockSupabase;
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock Supabase client with chainable methods
    mockSupabase = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      gte: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis()
    };
    
    getClient.mockReturnValue(mockSupabase);
  });
  
  test('getDailyTotal enforces org_id for RLS safety', async () => {
    await expect(
      aggregationService.getDailyTotal(null, 'user-123', '2026-05-07')
    ).rejects.toThrow('org_id is required');
  });
  
  test('getDailyTotal excludes idle records from work time', async () => {
    mockSupabase.neq.mockResolvedValue({
      data: [
        { duration_seconds: 3600 },  // 1 hour work
        { duration_seconds: 1800 }   // 30 min work
        // Idle records excluded by neq('is_idle', true)
      ],
      error: null
    });
    
    const total = await aggregationService.getDailyTotal(
      'org-123', 
      'user-456', 
      '2026-05-07'
    );
    
    expect(total).toBe(5400);  // 1.5 hours
    expect(mockSupabase.from).toHaveBeenCalledWith('activity_records');
    expect(mockSupabase.neq).toHaveBeenCalledWith('is_idle', true);
  });
  
  test('getDailyTotal returns 0 for date with no activities', async () => {    
    mockSupabase.neq.mockResolvedValue({
      data: [],  // No activities
      error: null
    });
    
    const total = await aggregationService.getDailyTotal(
      'org-123',
      'user-456',
      '2026-05-07'
    );
    
    expect(total).toBe(0);
  });
  
  test('getWeeklyTotal sums exactly 7 days', async () => {
    mockSupabase.neq.mockResolvedValue({
      data: [
        { duration_seconds: 14400 },  // Day 1: 4 hours
        { duration_seconds: 14400 },  // Day 2: 4 hours
        { duration_seconds: 14400 },  // Day 3: 4 hours
        { duration_seconds: 14400 },  // Day 4: 4 hours
        { duration_seconds: 14400 }   // Day 5: 4 hours
      ],
      error: null
    });
    
    const total = await aggregationService.getWeeklyTotal(
      'org-123',
      'user-456',
      '2026-05-05'  // Monday
    );
    
    expect(total).toBe(72000);  // 20 hours total
  });
});
