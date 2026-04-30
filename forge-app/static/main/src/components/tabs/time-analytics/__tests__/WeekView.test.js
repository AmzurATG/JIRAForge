import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import WeekView from '../WeekView';

// Mock @forge/bridge
jest.mock('@forge/bridge', () => ({
  invoke: jest.fn(),
}));

// Mock DayIssueDrilldown to verify it receives the correct date
jest.mock('../DayIssueDrilldown', () => {
  return function MockDayIssueDrilldown({ selectedDate, onClose }) {
    return (
      <div data-testid="day-drilldown" data-date={selectedDate}>
        <span>Drill-down for {selectedDate}</span>
        <button onClick={onClose}>Close</button>
      </div>
    );
  };
});

// Helper: generate mock time data for the current week
function createMockTimeData() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const daysToMonday = dow === 0 ? 6 : dow - 1;
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - daysToMonday);

  const formatDate = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const todayStr = formatDate(today);

  // Create daily summary entries for each day of the week up to today
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
        total_seconds: 3600 + (i * 1800), // 1h, 1.5h, 2h, etc.
      });
    }
  }

  return {
    allUsers: [{ id: 'user-1', display_name: 'Test User', email: 'test@example.com' }],
    dailySummary,
    canViewAllUsers: false,
  };
}

// Helper: get today's date string in YYYY-MM-DD format
function getTodayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Helper: get Monday's date string for the current week
function getMondayStr() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay();
  const daysToMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(today);
  monday.setDate(today.getDate() - daysToMonday);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const day = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('WeekView', () => {
  const mockTimeData = createMockTimeData();

  it('renders week table with day columns', () => {
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={null} />);
    expect(screen.getByText('User')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('does not show drill-down panel when no date is selected', () => {
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={null} />);
    expect(screen.queryByTestId('day-drilldown')).not.toBeInTheDocument();
  });

  it('clicking a day cell opens drill-down for that specific date', () => {
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={null} />);

    // Find all time-drilldown-btn buttons (one per day with data)
    const buttons = screen.getAllByTitle('Click for issue breakdown');
    expect(buttons.length).toBeGreaterThan(0);

    // Click the first button (Monday)
    fireEvent.click(buttons[0]);

    const drilldown = screen.getByTestId('day-drilldown');
    expect(drilldown).toBeInTheDocument();
    // Verify the date is Monday (first day of the week), not today
    expect(drilldown.getAttribute('data-date')).toBe(getMondayStr());
  });

  it('clicking the same day cell toggles drill-down closed', () => {
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={null} />);

    const buttons = screen.getAllByTitle('Click for issue breakdown');
    
    // Click to open
    fireEvent.click(buttons[0]);
    expect(screen.getByTestId('day-drilldown')).toBeInTheDocument();

    // Click again to close
    fireEvent.click(buttons[0]);
    expect(screen.queryByTestId('day-drilldown')).not.toBeInTheDocument();
  });

  it('summaryDrillDate auto-opens the drill-down for that date', () => {
    const todayStr = getTodayStr();
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={todayStr} />);

    const drilldown = screen.getByTestId('day-drilldown');
    expect(drilldown.getAttribute('data-date')).toBe(todayStr);
  });

  it('user click overrides summaryDrillDate (BUG FIX VERIFICATION)', () => {
    // This is the core test for the fix.
    // summaryDrillDate is set to today, but user clicks Monday.
    // Before the fix: drill-down would revert to today on re-render.
    // After the fix: drill-down stays on the user-selected date.

    const todayStr = getTodayStr();
    const mondayStr = getMondayStr();

    // Skip this test if today is Monday (both dates would be the same)
    if (todayStr === mondayStr) {
      return;
    }

    const { rerender } = render(
      <WeekView loading={false} timeData={mockTimeData} summaryDrillDate={todayStr} />
    );

    // Initially shows today due to summaryDrillDate
    let drilldown = screen.getByTestId('day-drilldown');
    expect(drilldown.getAttribute('data-date')).toBe(todayStr);

    // User clicks Monday's cell
    const buttons = screen.getAllByTitle('Click for issue breakdown');
    fireEvent.click(buttons[0]);

    // Should now show Monday, NOT today
    drilldown = screen.getByTestId('day-drilldown');
    expect(drilldown.getAttribute('data-date')).toBe(mondayStr);

    // Force a re-render (simulates state update elsewhere in the tree)
    rerender(
      <WeekView loading={false} timeData={mockTimeData} summaryDrillDate={todayStr} />
    );

    // CRITICAL: After re-render, drill-down should STILL show Monday
    drilldown = screen.getByTestId('day-drilldown');
    expect(drilldown.getAttribute('data-date')).toBe(mondayStr);
  });

  it('switching between different day cells updates the drill-down', () => {
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={null} />);

    const buttons = screen.getAllByTitle('Click for issue breakdown');
    
    if (buttons.length < 2) {
      // If only one day has data (e.g., today is Monday), skip
      return;
    }

    // Click first day
    fireEvent.click(buttons[0]);
    const drilldown1 = screen.getByTestId('day-drilldown');
    const date1 = drilldown1.getAttribute('data-date');

    // Click second day
    fireEvent.click(buttons[1]);
    const drilldown2 = screen.getByTestId('day-drilldown');
    const date2 = drilldown2.getAttribute('data-date');

    // Dates should be different
    expect(date1).not.toBe(date2);
  });

  it('shows loading state when loading prop is true', () => {
    render(<WeekView loading={true} timeData={mockTimeData} summaryDrillDate={null} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows empty state when no users have data', () => {
    const emptyData = { allUsers: [], dailySummary: [], canViewAllUsers: false };
    render(<WeekView loading={false} timeData={emptyData} summaryDrillDate={null} />);
    expect(screen.getByText('No users found')).toBeInTheDocument();
  });

  it('does not open drill-down if summaryDrillDate is outside the current week', () => {
    // Use a date far in the past that won't be in the current week
    const oldDate = '2020-01-01';
    render(<WeekView loading={false} timeData={mockTimeData} summaryDrillDate={oldDate} />);
    expect(screen.queryByTestId('day-drilldown')).not.toBeInTheDocument();
  });

  it('new summaryDrillDate value triggers drill-down update', () => {
    const todayStr = getTodayStr();
    const mondayStr = getMondayStr();

    // Skip if today is Monday
    if (todayStr === mondayStr) return;

    const { rerender } = render(
      <WeekView loading={false} timeData={mockTimeData} summaryDrillDate={mondayStr} />
    );

    // Shows Monday
    let drilldown = screen.getByTestId('day-drilldown');
    expect(drilldown.getAttribute('data-date')).toBe(mondayStr);

    // Now parent passes today's date as a new summaryDrillDate
    rerender(
      <WeekView loading={false} timeData={mockTimeData} summaryDrillDate={todayStr} />
    );

    // Should update to today
    drilldown = screen.getByTestId('day-drilldown');
    expect(drilldown.getAttribute('data-date')).toBe(todayStr);
  });
});
