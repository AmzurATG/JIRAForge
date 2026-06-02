/**
 * Dashboard Page
 * 
 * Main dashboard with KPIs and productivity charts.
 */

import { useState, useEffect } from 'react';
import { Clock, TrendingUp, Users, Activity } from 'lucide-react';
import { dashboardApi } from '../api/dashboard';
import KPICard from '../components/common/KPICard';
import DateRangePicker from '../components/common/DateRangePicker';
import LobFilter from '../components/common/LobFilter';
import ProductivityTrendChart from '../components/charts/ProductivityTrendChart';
import ProductivityDonutChart from '../components/charts/ProductivityDonutChart';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorBanner from '../components/common/ErrorBanner';
import { formatDate } from '../utils/formatters';

function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dashboardData, setDashboardData] = useState(null);
  const [lobId, setLobId] = useState('');

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
    loadDashboardData();
  }, [dateRange, lobId]);

  const loadDashboardData = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await dashboardApi.getData(dateRange.from, dateRange.to, lobId);
      setDashboardData(response.data);
    } catch (err) {
      console.error('Failed to load dashboard:', err);
      setError(err.response?.data?.error || 'Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  const handleDateRangeChange = (newRange) => {
    setDateRange(newRange);
  };

  if (loading && !dashboardData) {
    return (
      <div className="flex justify-center items-center h-64">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">Overview of team productivity metrics</p>
        </div>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {/* Filters */}
      <div className="card grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="filter-label">Date Range</label>
          <DateRangePicker
            from={dateRange.from}
            to={dateRange.to}
            onChange={handleDateRangeChange}
          />
        </div>
        <LobFilter value={lobId} onChange={setLobId} />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <KPICard
          title="Total Productive Hours"
          value={dashboardData?.summary?.totalProductiveHours?.toFixed(2) || '0.00'}
          subtitle="Hours tracked"
          icon={Clock}
          variant="success"
        />
        <KPICard
          title="Total Non-Productive Hours"
          value={dashboardData?.summary?.totalNonProductiveHours?.toFixed(2) || '0.00'}
          subtitle="Hours tracked"
          icon={Activity}
          variant="danger"
        />
        <KPICard
          title="Productivity Rate"
          value={`${dashboardData?.summary?.productivityPercentage?.toFixed(1) || '0.0'}%`}
          subtitle="Overall efficiency"
          icon={TrendingUp}
          variant="info"
        />
        <KPICard
          title="Active Employees"
          value={dashboardData?.summary?.employeeCount || '0'}
          subtitle="In selected period"
          icon={Users}
          variant="default"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="section-title mb-4">Productivity Trend</h3>
          <ProductivityTrendChart data={dashboardData?.dailyTrend || []} />
        </div>
        <div className="card">
          <h3 className="section-title mb-4">Productivity Distribution</h3>
          <ProductivityDonutChart
            productivePercentage={dashboardData?.summary?.productivityPercentage || 0}
            nonProductivePercentage={100 - (dashboardData?.summary?.productivityPercentage || 0)}
          />
        </div>
      </div>
    </div>
  );
}

export default DashboardPage;
