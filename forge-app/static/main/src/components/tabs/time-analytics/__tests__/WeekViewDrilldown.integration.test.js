import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WeekView from '../WeekView';

// Mock @forge/bridge invoke to simulate backend response
const mockInvoke = jest.fn();
jest.mock('@forge/bridge', () => ({
  invoke: (...args) => mockInvoke(...args),
}));

// Use the REAL DayIssueDrilldown component (not mocked)
// This tests the full flow: click → invoke → render results

// Helper: format date as YYYY-MM-DD
function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Helper: generate mock time data with multiple days
function createMockTimeData() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const daysToMonday = dow === 0 ? 6 : dow - 1;
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - daysToMonday);

  const todayStr = formatDate(today);
  const dailySummary = [];

  for (let i = 0; i <= daysToMonday; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    const dateStr = formatDate(d);
    if (dateStr <= todayStr) {
      dailySummary.push({
        work_date: dateStr,
        user_id: 'user-1',
        user_display_name: 'Test User',
        total_seconds: 3600 * (i + 1),
      });
    }
  }

  return {
    allUsers: [{ id: 'user-1', display_name: 'Test User', email: 'test@example.com' }],
    dailySummary,
    canViewAllUsers: false,
  };
}

describe('WeekView Drill-Down Integration', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('clicking a day cell calls getMyDayIssueBreakdown with the correct date', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = today.getDay();
    const daysToMonday = dow === 0 ? 6 : dow - 1;
    const monday = new Date(today);
    monday.setDate(today.getDate() - daysToMonday);
    const mondayStr = formatDate(monday);

    // Mock the backend response for the drill-down
    mockInvoke.mockResolvedValue({
      success: true,
      data: {
        totalSeconds: 3600,
        totalHours: 1,
        issueCount: 2,
        issues: [
          { issueKey: 'TA-6', summary: 'Fix login bug', totalSeconds: 2400 },
          { issueKey: 'TA-9', summary: 'Update docs', totalSeconds: 1200 },
        ],
      },
    });

    const mockTimeData = createMockTimeData();
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={null} />);

    // Click Monday's time cell
    const buttons = screen.getAllByTitle('Click for issue breakdown');
    fireEvent.click(buttons[0]);

    // Verify invoke was called with the correct date (Monday, not today)
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('getMyDayIssueBreakdown', { date: mondayStr });
    });
  });

  it('drill-down shows issue breakdown for the selected date', async () => {
    mockInvoke.mockResolvedValue({
      success: true,
      data: {
        totalSeconds: 5400,
        totalHours: 1.5,
        issueCount: 2,
        issues: [
          { issueKey: 'TA-6', summary: 'Fix login bug', totalSeconds: 3200 },
          { issueKey: 'FEEDBACK-74', summary: 'Add feedback form', totalSeconds: 2200 },
        ],
      },
    });

    const mockTimeData = createMockTimeData();
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={null} />);

    const buttons = screen.getAllByTitle('Click for issue breakdown');
    fireEvent.click(buttons[0]);

    // Wait for the drill-down to load and display issues
    await waitFor(() => {
      expect(screen.getByText('TA-6')).toBeInTheDocument();
      expect(screen.getByText('FEEDBACK-74')).toBeInTheDocument();
    });

    // Verify the header shows "Issue Breakdown"
    expect(screen.getByText('Issue Breakdown')).toBeInTheDocument();
  });

  it('switching days calls backend with the new date', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = today.getDay();
    const daysToMonday = dow === 0 ? 6 : dow - 1;

    // Skip if today is Monday (only one day with data before today)
    if (daysToMonday < 1) return;

    const monday = new Date(today);
    monday.setDate(today.getDate() - daysToMonday);
    const mondayStr = formatDate(monday);

    const tuesday = new Date(monday);
    tuesday.setDate(monday.getDate() + 1);
    const tuesdayStr = formatDate(tuesday);

    mockInvoke.mockResolvedValue({
      success: true,
      data: { totalSeconds: 3600, issueCount: 1, issues: [{ issueKey: 'TA-1', summary: 'Task', totalSeconds: 3600 }] },
    });

    const mockTimeData = createMockTimeData();
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={null} />);

    const buttons = screen.getAllByTitle('Click for issue breakdown');

    // Click Monday
    fireEvent.click(buttons[0]);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('getMyDayIssueBreakdown', { date: mondayStr });
    });

    // Click Tuesday
    fireEvent.click(buttons[1]);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('getMyDayIssueBreakdown', { date: tuesdayStr });
    });
  });

  it('handles backend error gracefully', async () => {
    mockInvoke.mockResolvedValue({
      success: false,
      error: 'Database connection failed',
    });

    const mockTimeData = createMockTimeData();
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={null} />);

    const buttons = screen.getAllByTitle('Click for issue breakdown');
    fireEvent.click(buttons[0]);

    await waitFor(() => {
      expect(screen.getByText('Database connection failed')).toBeInTheDocument();
    });
  });

  it('handles empty issues for a day', async () => {
    mockInvoke.mockResolvedValue({
      success: true,
      data: { totalSeconds: 0, issueCount: 0, issues: [] },
    });

    const mockTimeData = createMockTimeData();
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={null} />);

    const buttons = screen.getAllByTitle('Click for issue breakdown');
    fireEvent.click(buttons[0]);

    await waitFor(() => {
      expect(screen.getByText('No issue activity recorded for this day.')).toBeInTheDocument();
    });
  });
});
