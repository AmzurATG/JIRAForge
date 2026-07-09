import React, { useEffect, useState } from 'react';
import { formatTime } from '../../../utils';
import { normalizeDate, getMonthStr } from './dateUtils';
import DayIssueDrilldown from './DayIssueDrilldown';

/**
 * Month View Component
 * Displays monthly calendar and team summary
 */
function MonthView({ loading, timeData, selectedMonth, setSelectedMonth, userPermissions, summaryDrillDate }) {
  const [selectedDate, setSelectedDate] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const today = new Date();
  const year = selectedMonth.getFullYear();
  const month = selectedMonth.getMonth();
  const selectedMonthStr = getMonthStr(selectedMonth);

  useEffect(() => {
    if (!summaryDrillDate) return;
    if (summaryDrillDate.startsWith(selectedMonthStr)) {
      setSelectedDate(summaryDrillDate);
    }
  }, [summaryDrillDate, selectedMonthStr]);

  const navigatePrevMonth = () => {
    setSelectedMonth(new Date(year, month - 1, 1));
  };

  const navigateNextMonth = () => {
    setSelectedMonth(new Date(year, month + 1, 1));
  };

  const goToToday = () => {
    setSelectedMonth(new Date());
  };

  const getTimeByDate = () => {
    const timeByDate = {};
    timeData?.dailySummary?.forEach(day => {
      const workDateStr = normalizeDate(day.work_date);
      if (workDateStr.startsWith(selectedMonthStr)) {
        const date = new Date(workDateStr + 'T00:00:00');
        if (date.getMonth() === month && date.getFullYear() === year) {
          const dayNum = date.getDate();
          timeByDate[dayNum] = (timeByDate[dayNum] || 0) + (day.total_seconds || 0);
        }
      }
    });
    return timeByDate;
  };

  const renderCalendar = () => {
    const firstDayOfMonth = new Date(year, month, 1);
    let firstDay = firstDayOfMonth.getDay() - 1;
    if (firstDay < 0) firstDay = 6;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const timeByDate = getTimeByDate();

    const rows = [];
    let day = 1;
    const totalWeeks = Math.ceil((firstDay + daysInMonth) / 7);

    for (let week = 0; week < totalWeeks; week++) {
      const cells = [];
      for (let weekDay = 0; weekDay < 7; weekDay++) {
        const dayIndex = week * 7 + weekDay;
        if (dayIndex < firstDay || day > daysInMonth) {
          cells.push(<td key={weekDay} className="calendar-cell empty"></td>);
        } else {
          const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
          const isWeekend = weekDay >= 5;
          const timeTracked = timeByDate[day] || 0;
          const currentDay = day;
          const clickedDateStr = `${selectedMonthStr}-${String(currentDay).padStart(2, '0')}`;

          cells.push(
            <td
              key={weekDay}
              className={`calendar-cell ${isToday ? 'today' : ''} ${timeTracked > 0 ? 'has-time' : ''} ${isWeekend ? 'weekend' : ''}`}
            >
              <div className="cell-day">{currentDay}</div>
              {timeTracked > 0 && (
                <button
                  className={`cell-time cell-time-drilldown ${selectedDate === clickedDateStr ? 'active' : ''}`}
                  onClick={() => setSelectedDate(selectedDate === clickedDateStr ? null : clickedDateStr)}
                  title="Click for issue breakdown"
                >
                  {formatTime(timeTracked)}
                </button>
              )}
            </td>
          );
          day++;
        }
      }
      rows.push(<tr key={week}>{cells}</tr>);
    }

    return rows;
  };

  const renderHorizontalCalendar = () => {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const timeByDate = getTimeByDate();
    const days = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const weekDay = date.getDay();
      const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
      const isWeekend = weekDay === 0 || weekDay === 6;
      const timeTracked = timeByDate[day] || 0;
      const clickedDateStr = `${selectedMonthStr}-${String(day).padStart(2, '0')}`;

      days.push(
        <div
          key={day}
          className={`horizontal-day-card ${isToday ? 'today' : ''} ${isWeekend ? 'weekend' : ''} ${selectedDate === clickedDateStr ? 'active' : ''}`}
          onClick={() => timeTracked > 0 && setSelectedDate(selectedDate === clickedDateStr ? null : clickedDateStr)}
        >
          <div className="day-name">{dayNames[weekDay]}</div>
          <div className="day-number">{day}</div>
          {timeTracked > 0 ? (
            <div className="day-time" title="Click for issue breakdown">
              {formatTime(timeTracked)}
            </div>
          ) : (
            <div className="day-time empty">-</div>
          )}
        </div>
      );
    }

    return (
      <div className="horizontal-calendar-container">
        {days}
      </div>
    );
  };

  return (
    <div className="timesheet-month-view">
      <div className="month-header-container">
        <div className="month-nav">
          <button className="month-nav-btn" onClick={navigatePrevMonth}>
            <span className="nav-arrow">&#8249;</span>
          </button>
          <div className="month-title-wrapper">
            <h3 className="month-title">
              {selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </h3>
            <span className="month-subtitle">
              {timeData?.canViewAllUsers ? 'Team Timesheet' : 'My Timesheet'}
            </span>
          </div>
          <button className="month-nav-btn" onClick={navigateNextMonth}>
            <span className="nav-arrow">&#8250;</span>
          </button>
        </div>
        <button className="today-btn" onClick={goToToday}>
          Today
        </button>
      </div>

      {loading ? (
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <p>Loading timesheet...</p>
        </div>
      ) : (
        <div className={`month-layout ${!isExpanded ? 'horizontal-mode' : ''}`}>
          <div className="month-calendar-card">
            <div className="calendar-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4>Calendar View</h4>
              <button 
                className="expand-calendar-btn"
                onClick={() => setIsExpanded(!isExpanded)}
              >
                {isExpanded ? 'Collapse' : 'Expand'}
              </button>
            </div>
            {isExpanded ? (
              <table className="calendar-table">
                <thead>
                  <tr>
                    <th>Mon</th>
                    <th>Tue</th>
                    <th>Wed</th>
                    <th>Thu</th>
                    <th>Fri</th>
                    <th className="weekend">Sat</th>
                    <th className="weekend">Sun</th>
                  </tr>
                </thead>
                <tbody>{renderCalendar()}</tbody>
              </table>
            ) : (
              renderHorizontalCalendar()
            )}
          </div>

          <div className="month-right-column">
            {selectedDate ? (
              <DayIssueDrilldown
                selectedDate={selectedDate}
                onClose={() => setSelectedDate(null)}
              />
            ) : (
              <div className="drilldown-placeholder">
                <h4>Issue Breakdown</h4>
                <p>Click any day hour value to see issue-level details.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default MonthView;
