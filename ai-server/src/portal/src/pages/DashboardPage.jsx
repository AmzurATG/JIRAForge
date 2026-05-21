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
import ProductivityTrendChart from '../components/charts/ProductivityTrendChart';
import ProductivityDonutChart from '../components/charts/ProductivityDonutChart';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorBanner from '../components/common/ErrorBanner';
import { formatDate } from '../utils/formatters';

function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dashboardData, setDashboardData] = useState(null);
  
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
    loadDashboardData();
  }, [dateRange]);

  const loadDashboardData = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await dashboardApi.getData(dateRange.from, dateRange.to);
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
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Dashboard</h1>
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
          title="Total Productive Hours"
          value={dashboardData?.summary?.totalProductiveHours?.toFixed(1) || '0.0'}
          subtitle="Hours"
          icon={Clock}
        />
        <KPICard
          title="Total Non-Productive Hours"
          value={dashboardData?.summary?.totalNonProductiveHours?.toFixed(1) || '0.0'}
          subtitle="Hours"
          icon={Activity}
        />
        <KPICard
          title="Productivity Percentage"
          value={`${dashboardData?.summary?.productivityPercentage?.toFixed(1) || '0.0'}%`}
          icon={TrendingUp}
        />
        <KPICard
          title="Active Employees"
          value={dashboardData?.summary?.employeeCount || '0'}
          icon={Users}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ProductivityTrendChart data={dashboardData?.dailyTrend || []} />
        <ProductivityDonutChart
          productivePercentage={dashboardData?.summary?.productivityPercentage || 0}
          nonProductivePercentage={100 - (dashboardData?.summary?.productivityPercentage || 0)}
        />
      </div>
    </div>
  );
}

export default DashboardPage;
