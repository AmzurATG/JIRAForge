/**
 * Employee Detail Page
 * 
 * Shows detailed employee metrics, daily trend, and activity logs.
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Clock, TrendingUp, Activity, BarChart3, MapPin, Briefcase, Moon, CircleDashed } from 'lucide-react';
import { employeesApi } from '../api/employees';
import KPICard from '../components/common/KPICard';
import CategoryBadge from '../components/common/CategoryBadge';
import CategoryLegend from '../components/common/CategoryLegend';
import DateRangePicker from '../components/common/DateRangePicker';
import DailyLineChart from '../components/charts/DailyLineChart';
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
  
  // Default to last 7 days
  const [dateRange, setDateRange] = useState(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - 7);
    return {
      from: formatDate(from),
      to: formatDate(to),
    };
  });

  useEffect(() => {
    loadEmployeeDetail();
  }, [userId, dateRange]);

  useEffect(() => {
    loadEmployeeLogs();
  }, [userId, activeTab, logsPage, dateRange]);

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
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="page-title">{employeeDetail?.user?.name || 'Employee Detail'}</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-0.5 flex items-center gap-2">
            {employeeDetail?.user?.email}
            {employeeDetail?.user?.location?.name && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-300">
                <MapPin className="w-3 h-3" /> {employeeDetail.user.location.name}
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
          title="Neutral Hours"
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

      {/* Daily Trend Chart */}
      <div className="card">
        <h3 className="section-title mb-4">Daily Productivity Trend</h3>
        <DailyLineChart data={employeeDetail?.dailyTrend || []} />
      </div>

      {/* Activity Logs */}
      <div className="card">
        <h3 className="section-title mb-4">Activity Logs</h3>
        
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
            Neutral
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
      </div>
    </div>
  );
}

export default EmployeeDetailPage;
