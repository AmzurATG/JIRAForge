import { formatTime } from '../../../../utils/timeFormatting';
import { normalizeDate, formatLocalDate } from '../dateUtils';

/**
 * Integration tests for Time Analytics consistency
 * Verifies that the "Time Spent Today" summary card total
 * matches the sum of individual user times in the Daily Timesheet.
 *
 * Bug: The summary card used formatTime which dropped seconds for >= 1h durations,
 * causing a visual mismatch with the per-user times that showed seconds.
 */

// --- Replicate SummaryCards.calculateTodayTotal logic ---
function calculateTodayTotal(dailySummary, todayStr) {
  return dailySummary
    .filter(day => {
      const workDateStr = normalizeDate(day.work_date);
      return workDateStr === todayStr;
    })
    .reduce((sum, day) => sum + (day.total_seconds || 0), 0) || 0;
}

// --- Replicate DayView.getUsers aggregation logic ---
function getUserTotals(dailySummary, allUsers, todayStr) {
  const todayData = dailySummary.filter(day => {
    const workDateStr = normalizeDate(day.work_date);
    return workDateStr === todayStr;
  });

  const tasksByUser = {};

  // Initialize with all known users
  allUsers.forEach(user => {
    tasksByUser[user.id] = {
      userId: user.id,
      displayName: user.display_name || user.email || 'User',
      totalSeconds: 0
    };
  });

  // Aggregate today's data by user
  todayData.forEach(item => {
    const userId = item.user_id || 'current_user';
    if (!tasksByUser[userId]) {
      tasksByUser[userId] = {
        userId,
        displayName: item.user_display_name || 'User',
        totalSeconds: 0
      };
    }
    tasksByUser[userId].totalSeconds += item.total_seconds || 0;
  });

  return Object.values(tasksByUser).sort((a, b) => b.totalSeconds - a.totalSeconds);
}

describe('Time Analytics — Summary Card vs Daily Timesheet consistency', () => {
  const todayStr = '2026-03-16';

  // Realistic mock data matching the screenshot scenario
  const mockAllUsers = [
    { id: 'user-1', display_name: 'Srilakshmi Achanta', email: 'srilakshmi@test.com' },
    { id: 'user-2', display_name: 'Joseph Visak', email: 'joseph@test.com' },
    { id: 'user-3', display_name: 'Padmaja Bodsakurthi', email: 'padmaja@test.com' },
  ];

  describe('Bug scenario: seconds dropped when total >= 1 hour', () => {
    const dailySummary = [
      { work_date: '2026-03-16', user_id: 'user-1', user_display_name: 'Srilakshmi Achanta', total_seconds: 2690 },
      { work_date: '2026-03-16', user_id: 'user-2', user_display_name: 'Joseph Visak', total_seconds: 1392 },
    ];

    it('summary card total (raw seconds) matches sum of user totals', () => {
      const summaryTotal = calculateTodayTotal(dailySummary, todayStr);
      const users = getUserTotals(dailySummary, mockAllUsers, todayStr);
      const usersSum = users.reduce((sum, u) => sum + u.totalSeconds, 0);

      expect(summaryTotal).toBe(usersSum);
      expect(summaryTotal).toBe(4082);
    });

    it('formatted summary card total matches sum of formatted user times', () => {
      const summaryTotal = calculateTodayTotal(dailySummary, todayStr);
      const users = getUserTotals(dailySummary, mockAllUsers, todayStr);

      const summaryFormatted = formatTime(summaryTotal);
      const userFormattedTimes = users
        .filter(u => u.totalSeconds > 0)
        .map(u => ({ name: u.displayName, formatted: formatTime(u.totalSeconds), seconds: u.totalSeconds }));

      // Verify individual user times
      expect(userFormattedTimes).toEqual([
        { name: 'Srilakshmi Achanta', formatted: '44m 50s', seconds: 2690 },
        { name: 'Joseph Visak', formatted: '23m 12s', seconds: 1392 },
      ]);

      // CRITICAL: summary must include seconds — "1h 8m 2s" not "1h 8m"
      expect(summaryFormatted).toBe('1h 8m 2s');
    });
  });

  describe('Multiple users with per-project breakdown', () => {
    const dailySummary = [
      { work_date: '2026-03-16', user_id: 'user-1', total_seconds: 1800, project_key: 'PROJ-A' },
      { work_date: '2026-03-16', user_id: 'user-1', total_seconds: 890, project_key: 'PROJ-B' },
      { work_date: '2026-03-16', user_id: 'user-2', total_seconds: 1392, project_key: 'PROJ-A' },
      // yesterday — should be excluded
      { work_date: '2026-03-15', user_id: 'user-1', total_seconds: 5000 },
    ];

    it('both calculations correctly filter to today and aggregate', () => {
      const summaryTotal = calculateTodayTotal(dailySummary, todayStr);
      const users = getUserTotals(dailySummary, mockAllUsers, todayStr);
      const usersSum = users.reduce((sum, u) => sum + u.totalSeconds, 0);

      // 1800 + 890 + 1392 = 4082 (same as yesterday's 5000 is excluded)
      expect(summaryTotal).toBe(4082);
      expect(usersSum).toBe(4082);
    });

    it('user totals correctly aggregate across projects', () => {
      const users = getUserTotals(dailySummary, mockAllUsers, todayStr);
      const user1 = users.find(u => u.userId === 'user-1');
      const user2 = users.find(u => u.userId === 'user-2');

      expect(user1.totalSeconds).toBe(2690); // 1800 + 890
      expect(user2.totalSeconds).toBe(1392);
    });
  });

  describe('Edge case: no activity today', () => {
    const dailySummary = [
      { work_date: '2026-03-15', user_id: 'user-1', total_seconds: 5000 },
    ];

    it('both return 0 when no data for today', () => {
      const summaryTotal = calculateTodayTotal(dailySummary, todayStr);
      const users = getUserTotals(dailySummary, mockAllUsers, todayStr);
      const usersSum = users.reduce((sum, u) => sum + u.totalSeconds, 0);

      expect(summaryTotal).toBe(0);
      expect(usersSum).toBe(0);
      expect(formatTime(summaryTotal)).toBe('0s');
    });
  });

  describe('Edge case: empty data', () => {
    it('handles empty dailySummary', () => {
      const summaryTotal = calculateTodayTotal([], todayStr);
      const users = getUserTotals([], mockAllUsers, todayStr);
      const usersSum = users.reduce((sum, u) => sum + u.totalSeconds, 0);

      expect(summaryTotal).toBe(0);
      expect(usersSum).toBe(0);
    });
  });

  describe('Edge case: exact hour boundary', () => {
    const dailySummary = [
      { work_date: '2026-03-16', user_id: 'user-1', total_seconds: 1800 },
      { work_date: '2026-03-16', user_id: 'user-2', total_seconds: 1800 },
    ];

    it('exact 1h displays consistently', () => {
      const summaryTotal = calculateTodayTotal(dailySummary, todayStr);
      expect(summaryTotal).toBe(3600);
      expect(formatTime(summaryTotal)).toBe('1h');
      expect(formatTime(1800)).toBe('30m');
    });
  });

  describe('Edge case: user in dailySummary but not in allUsers', () => {
    const dailySummary = [
      { work_date: '2026-03-16', user_id: 'unknown-user', user_display_name: 'Unknown User', total_seconds: 500 },
      { work_date: '2026-03-16', user_id: 'user-1', total_seconds: 1000 },
    ];

    it('summary total includes unknown user time', () => {
      const summaryTotal = calculateTodayTotal(dailySummary, todayStr);
      const users = getUserTotals(dailySummary, mockAllUsers, todayStr);
      const usersSum = users.reduce((sum, u) => sum + u.totalSeconds, 0);

      expect(summaryTotal).toBe(1500);
      expect(usersSum).toBe(1500);
    });
  });

  describe('Date normalization edge cases', () => {
    it('handles timestamps with time component in work_date', () => {
      const dailySummary = [
        { work_date: '2026-03-16T00:00:00.000Z', user_id: 'user-1', total_seconds: 1000 },
      ];
      const total = calculateTodayTotal(dailySummary, todayStr);
      expect(total).toBe(1000);
    });

    it('normalizeDate handles plain date strings', () => {
      expect(normalizeDate('2026-03-16')).toBe('2026-03-16');
    });

    it('normalizeDate strips time from timestamps', () => {
      expect(normalizeDate('2026-03-16T14:30:00.000Z')).toBe('2026-03-16');
    });

    it('normalizeDate handles null/undefined', () => {
      expect(normalizeDate(null)).toBe('');
      expect(normalizeDate(undefined)).toBe('');
    });
  });
});
