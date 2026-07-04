/**
 * Employee Detail Page
 * 
 * Shows detailed employee metrics, daily trend, and activity logs.
 */

import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Clock, TrendingUp, Activity, BarChart3, Building2, Briefcase, Moon, CircleDashed, ChevronLeft, ChevronRight } from 'lucide-react';
import { employeesApi } from '../api/employees';
import KPICard from '../components/common/KPICard';
import CategoryBadge from '../components/common/CategoryBadge';
import CategoryLegend from '../components/common/CategoryLegend';
import DateRangePicker from '../components/common/DateRangePicker';
import DailyLineChart from '../components/charts/DailyLineChart';
import DayTimeline from '../components/charts/DayTimeline';
import DataTable from '../components/common/DataTable';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorBanner from '../components/common/ErrorBanner';
import { formatDate, formatDuration, formatDateTime } from '../utils/formatters';

function EmployeeDetailPage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [employeeDetail, setEmployeeDetail] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('all'); // 'all', 'productive', 'non-productive'
  const [logsPage, setLogsPage] = useState(1);
  const [logsTotalCount, setLogsTotalCount] = useState(0);

  // Activity Logs section view: 'timeline' (default) shows the merged day bar;
  // 'table' shows the existing paginated DataTable.
  const [logsView, setLogsView] = useState('timeline');
  const [timelineLogs, setTimelineLogs] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  // Timeline pager (spec 2026-07-03 timeline revamp): 0 = newest chunk.
  const [timelinePage, setTimelinePage] = useState(0);
  const [timelineTruncated, setTimelineTruncated] = useState(false);

  // Default to today (shown as the "Today" preset in the picker)
  const [dateRange, setDateRange] = useState(() => {
    const today = formatDate(new Date());
    return { from: today, to: today };
  });

  useEffect(() => {
    loadEmployeeDetail();
  }, [userId, dateRange]);

  // Table logs: only fetch while the Table view is active.
  useEffect(() => {
    if (logsView !== 'table') return;
    loadEmployeeLogs();
  }, [userId, activeTab, logsPage, dateRange, logsView]);

  // 'YYYY-MM-DD' ± n days, formatted with the same local-date rules as formatDate.
  const addDays = (dateStr, n) => {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + n);
    return formatDate(d);
  };

  // Timeline pager index: the detail response has one dailyTrend entry per
  // work_date with data, so its dates are the exact set of renderable days.
  // Newest first, TIMELINE_DAYS_PER_PAGE per chunk; ≤1 chunk → no pager.
  const TIMELINE_DAYS_PER_PAGE = 7;
  const timelineChunks = useMemo(() => {
    const dates = (employeeDetail?.dailyTrend || []).map((d) => d.date).sort().reverse();
    const chunks = [];
    for (let i = 0; i < dates.length; i += TIMELINE_DAYS_PER_PAGE) {
      const slice = dates.slice(i, i + TIMELINE_DAYS_PER_PAGE);
      chunks.push({ dates: slice, from: slice[slice.length - 1], to: slice[0] });
    }
    return chunks;
  }, [employeeDetail]);
  const timelineTotalDays = timelineChunks.reduce((n, c) => n + c.dates.length, 0);
  const currentChunk = timelineChunks[Math.min(timelinePage, Math.max(0, timelineChunks.length - 1))] || null;

  useEffect(() => {
    setTimelinePage(0);
  }, [userId, dateRange]);

  // Timeline: fetch ONLY the visible chunk of tracked days (all categories incl.
  // idle). ±1 day of padding captures runs spilling over local midnight; the
  // chunk's own dates trim the spill tracks in DayTimeline. A week of one user
  // is a few hundred rows — no silent 5000-row truncation like the old
  // whole-range fetch (defensive banner below if it ever happens).
  // Initial/explicit loads show a one-off "Loading…"; background polls are silent.
  const loadTimeline = async ({ silent = false } = {}) => {
    if (!currentChunk) {
      setTimelineLogs([]);
      setTimelineTruncated(false);
      return;
    }
    if (!silent) setTimelineLoading(true);
    try {
      const limit = 5000;
      const response = await employeesApi.getLogs(userId, {
        from: addDays(currentChunk.from, -1),
        to: addDays(currentChunk.to, 1),
        limit,
        includeIdle: true,
      });
      setTimelineLogs(response.data || []);
      setTimelineTruncated((response.data || []).length >= limit);
    } catch (err) {
      console.error('Failed to load timeline:', err);
    } finally {
      if (!silent) setTimelineLoading(false);
    }
  };

  useEffect(() => {
    // Wait for the detail response: timelineChunks derive from it, so fetching
    // while it loads would use the PREVIOUS range's day chunks (stale flash +
    // wasted request). The effect re-fires when `loading` flips false.
    if (logsView !== 'timeline' || loading) return;
    loadTimeline({ silent: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, dateRange, logsView, timelinePage, timelineChunks, loading]);

  // Silent live refresh: while viewing the NEWEST timeline page and the range
  // includes today, re-fetch every 60s WITHOUT a loading state (the bar just
  // extends). Paused when the tab is hidden; off for past-only ranges/pages.
  useEffect(() => {
    if (logsView !== 'timeline' || timelinePage !== 0) return undefined;
    const today = formatDate(new Date());
    const includesToday = dateRange.from <= today && today <= dateRange.to;
    if (!includesToday) return undefined;
    const id = setInterval(() => {
      if (!document.hidden) loadTimeline({ silent: true });
    }, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, dateRange, logsView, timelinePage, timelineChunks]);

  const loadEmployeeDetail = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await employeesApi.getDetail(userId, {
        from: dateRange.from,
        to: dateRange.to,
      });
      setEmployeeDetail(response.data);
    } catch (err) {
      console.error('Failed to load employee detail:', err);
      setError(err.response?.data?.error || 'Failed to load employee detail');
    } finally {
      setLoading(false);
    }
  };

  const loadEmployeeLogs = async () => {
    setLogsLoading(true);

    try {
      const response = await employeesApi.getLogs(userId, {
        classification: activeTab === 'all' ? undefined : activeTab,
        from: dateRange.from,
        to: dateRange.to,
        page: logsPage,
        limit: 10,
      });
      
      setLogs(response.data || []);
      setLogsTotalCount(response.pagination?.totalCount || 0);
    } catch (err) {
      console.error('Failed to load employee logs:', err);
    } finally {
      setLogsLoading(false);
    }
  };

  const handleDateRangeChange = (newRange) => {
    setDateRange(newRange);
    setLogsPage(1);
  };

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setLogsPage(1);
  };

  const logsColumns = [
    {
      key: 'startTime',
      label: 'Start Time',
      sortable: true,
      render: (value) => formatDateTime(value),
    },
    {
      key: 'endTime',
      label: 'End Time',
      sortable: true,
      render: (value) => formatDateTime(value),
    },
    {
      key: 'application',
      label: 'Application',
      sortable: true,
    },
    {
      key: 'windowTitle',
      label: 'Window Title',
      sortable: false,
      render: (value) => (
        <span className="truncate max-w-xs block" title={value}>
          {value || 'N/A'}
        </span>
      ),
    },
    {
      key: 'durationSeconds',
      label: 'Duration',
      sortable: true,
      render: (value) => formatDuration(value),
    },
    {
      key: 'category',
      label: 'Classification',
      sortable: true,
      render: (value, row) => <CategoryBadge value={value || row.classification} />,
    },
  ];

  if (loading && !employeeDetail) {
    return (
      <div className="flex justify-center items-center h-64">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-4">
        <button
          onClick={() => navigate('/employees')}
          className="p-2.5 bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl border border-gray-200 dark:border-gray-700 transition-all duration-200 shadow-sm hover:shadow-md"
          title="Back to Employees"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="page-title">{employeeDetail?.user?.name || 'Employee Detail'}</h1>
          <p className="text-gray-500 dark:text-gray-400 text-xs mt-0.5 flex items-center gap-2">
            {employeeDetail?.user?.email}
            {employeeDetail?.user?.location?.name && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-300">
                <Building2 className="w-3 h-3" /> {employeeDetail.user.location.name}
              </span>
            )}
          </p>
        </div>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {/* Date Range Filter */}
      <div className="card">
        <label className="filter-label">Date Range</label>
        <DateRangePicker
          from={dateRange.from}
          to={dateRange.to}
          onChange={handleDateRangeChange}
        />
      </div>

      {/* KPI Cards — canonical categories: Office = Active + Idle;
          Active = Productive + Non-Productive + Neutral (see legend). */}
      <div className="flex items-center gap-1">
        <h3 className="section-title">Time Breakdown</h3>
        <CategoryLegend />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title="Office Time"
          value={employeeDetail?.summary?.officeHours?.toFixed(2) || '0.00'}
          subtitle="Active + idle"
          icon={Briefcase}
          variant="info"
        />
        <KPICard
          title="Active Time"
          value={employeeDetail?.summary?.activeHours?.toFixed(2) || '0.00'}
          subtitle="All tracked activity"
          icon={BarChart3}
          variant="default"
        />
        <KPICard
          title="Productive Hours"
          value={employeeDetail?.summary?.productiveHours?.toFixed(2) || '0.00'}
          subtitle="Hours tracked"
          icon={Clock}
          variant="success"
        />
        <KPICard
          title="Non-Productive Hours"
          value={employeeDetail?.summary?.nonProductiveHours?.toFixed(2) || '0.00'}
          subtitle="Hours tracked"
          icon={Activity}
          variant="danger"
        />
        <KPICard
          title="Unknown Hours"
          value={employeeDetail?.summary?.neutralHours?.toFixed(2) || '0.00'}
          subtitle="Unclassified / private — outside the ratio"
          icon={CircleDashed}
          variant="default"
        />
        <KPICard
          title="Idle Hours"
          value={employeeDetail?.summary?.idleHours?.toFixed(2) || '0.00'}
          subtitle="Away / locked / asleep"
          icon={Moon}
          variant="warning"
        />
        <KPICard
          title="Productivity Rate"
          value={`${employeeDetail?.summary?.productivityPercentage?.toFixed(1) || '0.0'}%`}
          subtitle="Productive ÷ (productive + non-productive)"
          icon={TrendingUp}
          variant="info"
        />
      </div>

      {/* Daily Trend Chart — stacked hours by category + productivity % line */}
      <div className="card">
        <h3 className="section-title mb-4">Daily Activity &amp; Productivity</h3>
        <DailyLineChart data={employeeDetail?.dailyTrend || []} />
      </div>

      {/* Activity Logs */}
      <div className="card">
        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          <div className="flex items-center gap-1">
            <h3 className="section-title">Activity Logs</h3>
            {logsView === 'timeline' && <CategoryLegend />}
          </div>
          {/* Timeline ⇄ Table view toggle */}
          <div className="flex gap-1 p-1 bg-gray-100 dark:bg-gray-800 rounded-xl">
            <button
              onClick={() => setLogsView('timeline')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                logsView === 'timeline'
                  ? 'bg-white dark:bg-gray-700 text-primary-600 dark:text-primary-400 shadow-md'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              Timeline
            </button>
            <button
              onClick={() => setLogsView('table')}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                logsView === 'table'
                  ? 'bg-white dark:bg-gray-700 text-primary-600 dark:text-primary-400 shadow-md'
                  : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
              }`}
            >
              Table
            </button>
          </div>
        </div>

        {logsView === 'timeline' ? (
          <>
            {timelineTruncated && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
                This view hit the fetch limit — some records in this period may not be shown. Narrow the date range for complete detail.
              </div>
            )}
            <DayTimeline
              records={timelineLogs}
              loading={timelineLoading || loading}
              visibleDates={currentChunk ? new Set(currentChunk.dates) : null}
            />
            {timelineChunks.length > 1 && (
              <div className="mt-4 flex items-center justify-center gap-3 text-sm">
                <button
                  onClick={() => setTimelinePage((p) => Math.max(0, p - 1))}
                  disabled={timelinePage === 0}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <ChevronLeft className="w-4 h-4" /> Newer
                </button>
                <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                  Days {timelinePage * TIMELINE_DAYS_PER_PAGE + 1}–{Math.min((timelinePage + 1) * TIMELINE_DAYS_PER_PAGE, timelineTotalDays)} of {timelineTotalDays} tracked days
                </span>
                <button
                  onClick={() => setTimelinePage((p) => Math.min(timelineChunks.length - 1, p + 1))}
                  disabled={timelinePage >= timelineChunks.length - 1}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  Older <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </>
        ) : (
        <>
        {/* Tabs */}
        <div className="flex gap-1 mb-6 p-1 bg-gray-100 dark:bg-gray-800 rounded-xl w-fit">
          <button
            onClick={() => handleTabChange('all')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'all'
                ? 'bg-white dark:bg-gray-700 text-primary-600 dark:text-primary-400 shadow-md'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            All Activities
          </button>
          <button
            onClick={() => handleTabChange('productive')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'productive'
                ? 'bg-white dark:bg-gray-700 text-emerald-600 dark:text-emerald-400 shadow-md'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            Productive
          </button>
          <button
            onClick={() => handleTabChange('non-productive')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'non-productive'
                ? 'bg-white dark:bg-gray-700 text-red-600 dark:text-red-400 shadow-md'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            Non-Productive
          </button>
          <button
            onClick={() => handleTabChange('neutral')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === 'neutral'
                ? 'bg-white dark:bg-gray-700 text-slate-600 dark:text-slate-300 shadow-md'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            Unknown
          </button>
        </div>
        
        {/* Logs Table */}
        <DataTable
          columns={logsColumns}
          data={logs}
          loading={logsLoading}
          emptyMessage="No activity logs found"
          pagination={{
            page: logsPage,
            limit: 10,
            totalCount: logsTotalCount,
            onPageChange: setLogsPage,
          }}
        />
        </>
        )}
      </div>
    </div>
  );
}

export default EmployeeDetailPage;
