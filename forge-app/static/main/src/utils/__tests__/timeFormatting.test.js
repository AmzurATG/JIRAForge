import { formatTime, formatHours } from '../timeFormatting';

describe('formatTime', () => {
  describe('edge cases', () => {
    it('returns "0s" for 0 seconds', () => {
      expect(formatTime(0)).toBe('0s');
    });

    it('returns "0s" for null', () => {
      expect(formatTime(null)).toBe('0s');
    });

    it('returns "0s" for undefined', () => {
      expect(formatTime(undefined)).toBe('0s');
    });

    it('returns "0s" for negative values', () => {
      expect(formatTime(-10)).toBe('0s');
    });
  });

  describe('seconds only (< 1 minute)', () => {
    it('formats 1 second', () => {
      expect(formatTime(1)).toBe('1s');
    });

    it('formats 30 seconds', () => {
      expect(formatTime(30)).toBe('30s');
    });

    it('formats 59 seconds', () => {
      expect(formatTime(59)).toBe('59s');
    });
  });

  describe('minutes and seconds (< 1 hour)', () => {
    it('formats exact minutes', () => {
      expect(formatTime(60)).toBe('1m');
      expect(formatTime(300)).toBe('5m');
    });

    it('formats minutes with seconds', () => {
      expect(formatTime(90)).toBe('1m 30s');
      expect(formatTime(150)).toBe('2m 30s');
    });

    it('formats 44m 50s (2690 seconds) — user Srilakshmi Achanta', () => {
      expect(formatTime(2690)).toBe('44m 50s');
    });

    it('formats 23m 12s (1392 seconds) — user Joseph Visak', () => {
      expect(formatTime(1392)).toBe('23m 12s');
    });
  });

  describe('hours with minutes and seconds (>= 1 hour)', () => {
    it('formats exact hours', () => {
      expect(formatTime(3600)).toBe('1h');
      expect(formatTime(7200)).toBe('2h');
    });

    it('formats hours with minutes', () => {
      expect(formatTime(3660)).toBe('1h 1m');
      expect(formatTime(5400)).toBe('1h 30m');
    });

    it('formats hours with seconds only', () => {
      expect(formatTime(3602)).toBe('1h 2s');
    });

    it('formats hours with minutes AND seconds — the critical fix', () => {
      expect(formatTime(3661)).toBe('1h 1m 1s');
      expect(formatTime(3723)).toBe('1h 2m 3s');
    });

    it('formats 1h 8m 2s (4082 seconds) — the exact bug scenario total', () => {
      // 44m 50s (2690) + 23m 12s (1392) = 4082 seconds = 1h 8m 2s
      expect(formatTime(4082)).toBe('1h 8m 2s');
    });

    it('formats large durations with all components', () => {
      // 19h 6m 0s = 68760 seconds
      expect(formatTime(68760)).toBe('19h 6m');
      // 19h 6m 30s = 68790 seconds
      expect(formatTime(68790)).toBe('19h 6m 30s');
    });
  });

  describe('consistency: sum of individual times equals formatted total', () => {
    it('sum of user times matches the overall total — the reported bug scenario', () => {
      const srilakshmiSeconds = 2690; // 44m 50s
      const josephSeconds = 1392;     // 23m 12s
      const padmajaSeconds = 0;       // 0s

      const totalSeconds = srilakshmiSeconds + josephSeconds + padmajaSeconds;

      // Individual formatted values
      const srilakshmiFormatted = formatTime(srilakshmiSeconds);
      const josephFormatted = formatTime(josephSeconds);
      const totalFormatted = formatTime(totalSeconds);

      expect(srilakshmiFormatted).toBe('44m 50s');
      expect(josephFormatted).toBe('23m 12s');
      // CRITICAL: total must show seconds so it visually adds up
      expect(totalFormatted).toBe('1h 8m 2s');
      expect(totalSeconds).toBe(4082);
    });

    it('sum still works when all values are exact minutes', () => {
      const user1 = 1800; // 30m
      const user2 = 1800; // 30m
      const total = user1 + user2; // 3600 = 1h

      expect(formatTime(user1)).toBe('30m');
      expect(formatTime(user2)).toBe('30m');
      expect(formatTime(total)).toBe('1h');
    });

    it('sum preserves seconds across multiple users', () => {
      const user1 = 1801; // 30m 1s
      const user2 = 1801; // 30m 1s
      const total = user1 + user2; // 3602 = 1h 2s

      expect(formatTime(user1)).toBe('30m 1s');
      expect(formatTime(user2)).toBe('30m 1s');
      expect(formatTime(total)).toBe('1h 2s');
    });
  });

  describe('fractional/decimal seconds handling', () => {
    it('floors fractional seconds', () => {
      expect(formatTime(1.9)).toBe('1s');
      expect(formatTime(61.7)).toBe('1m 1s');
    });
  });
});

describe('formatHours', () => {
  it('returns "0" for null/undefined/0', () => {
    expect(formatHours(0)).toBe('0');
    expect(formatHours(null)).toBe('0');
    expect(formatHours(undefined)).toBe('0');
  });

  it('formats seconds to decimal hours', () => {
    expect(formatHours(3600)).toBe('1.0');
    expect(formatHours(5400)).toBe('1.5');
    expect(formatHours(9000, 2)).toBe('2.50');
  });
});
