/**
 * Employee Detail Page
 * 
 * Shows detailed employee metrics, daily trend, and activity logs.
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Clock, TrendingUp, Activity, BarChart3 } from 'lucide-react';
import { employeesApi } from '../api/employees';
import KPICard from '../components/common/KPICard';
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
  
  // Default to last 30 days
  const [dateRange, setDateRange] = useState(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - 30);
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
        classification: activeTab === 'all' ? undefined : activeTab === 'productive' ? 'productive' : 'non-productive',
        from: dateRange.from,
        to: dateRange.to,
        page: logsPage,
        limit: 20,
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
      key: 'classification',
      label: 'Classification',
      sortable: true,
      render: (value) => (
        <span
          className={`px-2 py-1 rounded text-xs font-semibold ${
            value === 'productive'
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
          }`}
        >
          {value || 'N/A'}
        </span>
      ),
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
    <div>
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={() => navigate('/employees')}
          className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold">{employeeDetail?.user?.name || 'Employee Detail'}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">{employeeDetail?.user?.email}</p>
        </div>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {/* Date Range Filter */}
      <div className="mb-6">
        <DateRangePicker
          from={dateRange.from}
          to={dateRange.to}
          onChange={handleDateRangeChange}
        />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
        <KPICard
          title="Productive Hours"
          value={employeeDetail?.summary?.productiveHours?.toFixed(1) || '0.0'}
          subtitle="Hours"
          icon={Clock}
        />
        <KPICard
          title="Non-Productive Hours"
          value={employeeDetail?.summary?.nonProductiveHours?.toFixed(1) || '0.0'}
          subtitle="Hours"
          icon={Activity}
        />
        <KPICard
          title="Productivity Percentage"
          value={`${employeeDetail?.summary?.productivityPercentage?.toFixed(1) || '0.0'}%`}
          icon={TrendingUp}
        />
        <KPICard
          title="Total Hours"
          value={((employeeDetail?.summary?.productiveHours || 0) + (employeeDetail?.summary?.nonProductiveHours || 0)).toFixed(1)}
          subtitle="Hours"
          icon={BarChart3}
        />
      </div>

      {/* Daily Trend Chart */}
      <div className="mb-6">
        <DailyLineChart data={employeeDetail?.dailyTrend || []} />
      </div>

      {/* Activity Logs */}
      <div className="card mb-6">
        <h2 className="text-xl font-semibold mb-4">Activity Logs</h2>
        
        {/* Tabs */}
        <div className="flex gap-2 mb-4 border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => handleTabChange('all')}
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              activeTab === 'all'
                ? 'border-primary-600 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            All Activities
          </button>
          <button
            onClick={() => handleTabChange('productive')}
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              activeTab === 'productive'
                ? 'border-primary-600 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            Productive
          </button>
          <button
            onClick={() => handleTabChange('non-productive')}
            className={`px-4 py-2 font-medium border-b-2 transition-colors ${
              activeTab === 'non-productive'
                ? 'border-primary-600 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            Non-Productive
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
            limit: 20,
            totalCount: logsTotalCount,
            onPageChange: setLogsPage,
          }}
        />
      </div>
    </div>
  );
}

export default EmployeeDetailPage;
