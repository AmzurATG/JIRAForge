/**
 * AI Prompts Module Unit Tests
 * Tests for formatAssignedIssues and related prompt functions
 */

'use strict';

const { formatAssignedIssues } = require('../../src/services/ai/prompts');

describe('formatAssignedIssues', () => {
  it('should return "None - track all work" for empty issues', () => {
    expect(formatAssignedIssues([])).toBe('None - track all work');
    expect(formatAssignedIssues(null)).toBe('None - track all work');
    expect(formatAssignedIssues(undefined)).toBe('None - track all work');
  });

  it('should format basic issue with key, summary and status', () => {
    const issues = [{ key: 'PROJ-1', summary: 'Test task', status: 'In Progress' }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('PROJ-1: Test task (Status: In Progress)');
  });

  // Fix 4: Issue recency signal
  it('should add recency warning for issues updated >14 days ago', () => {
    const issues = [{
      key: 'PROJ-1',
      summary: 'Old task',
      status: 'In Progress',
      updated: new Date(Date.now() - 30 * 86400000).toISOString()
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('Last updated:');
    expect(result).toContain('days ago');
    expect(result).toContain('likely inactive');
  });

  it('should NOT add recency warning for recently updated issues', () => {
    const issues = [{
      key: 'PROJ-2',
      summary: 'Fresh task',
      status: 'In Progress',
      updated: new Date().toISOString()
    }];
    const result = formatAssignedIssues(issues);
    expect(result).not.toContain('Last updated');
    expect(result).not.toContain('likely inactive');
  });

  it('should NOT add recency warning for issues updated within 14 days', () => {
    const issues = [{
      key: 'PROJ-3',
      summary: 'Recent task',
      status: 'In Progress',
      updated: new Date(Date.now() - 10 * 86400000).toISOString()
    }];
    const result = formatAssignedIssues(issues);
    expect(result).not.toContain('likely inactive');
  });

  it('should handle issues without updated field', () => {
    const issues = [{
      key: 'PROJ-4',
      summary: 'No date',
      status: 'In Progress'
    }];
    const result = formatAssignedIssues(issues);
    expect(result).toContain('PROJ-4');
    expect(result).not.toContain('Last updated');
  });

  // Fix 7: Issue list limit 30, sorted by recency
  it('should return up to 50 issues', () => {
    const issues = Array.from({ length: 60 }, (_, i) => ({
      key: `PROJ-${i}`,
      summary: `Task ${i}`,
      status: 'In Progress',
      updated: new Date(Date.now() - i * 86400000).toISOString()
    }));
    const result = formatAssignedIssues(issues);
    const keys = result.match(/PROJ-\d+/g);
    expect(keys.length).toBe(50);
  });

  it('should sort issues by recency (newest first)', () => {
    const issues = [
      {
        key: 'PROJ-OLD',
        summary: 'Old',
        status: 'In Progress',
        updated: '2026-03-01T00:00:00Z'
      },
      {
        key: 'PROJ-NEW',
        summary: 'New',
        status: 'In Progress',
        updated: '2026-04-20T00:00:00Z'
      }
    ];
    const result = formatAssignedIssues(issues);
    expect(result.indexOf('PROJ-NEW')).toBeLessThan(result.indexOf('PROJ-OLD'));
  });

  it('should sort issues without updated field last', () => {
    const issues = [
      { key: 'PROJ-NODATE', summary: 'No date', status: 'In Progress' },
      {
        key: 'PROJ-DATED',
        summary: 'Has date',
        status: 'In Progress',
        updated: '2026-04-20T00:00:00Z'
      }
    ];
    const result = formatAssignedIssues(issues);
    expect(result.indexOf('PROJ-DATED')).toBeLessThan(result.indexOf('PROJ-NODATE'));
  });
});
