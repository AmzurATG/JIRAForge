/**
 * Time Logs Page
 * 
 * Displays all employee activity logs with comprehensive filtering.
 */

import { useState, useEffect } from 'react';
import { Search, Filter } from 'lucide-react';
import { timeLogsApi } from '../api/timeLogs';
import { employeesApi } from '../api/employees';
import DataTable from '../components/common/DataTable';
import DateRangePicker from '../components/common/DateRangePicker';
import ErrorBanner from '../components/common/ErrorBanner';
import { formatDate, formatDuration, formatDateTime } from '../utils/formatters';

function TimeLogsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [logs, setLogs] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(true);
  
  // Filters
  const [classification, setClassification] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [appFilter, setAppFilter] = useState('');
  
  // Employee list for filter
  const [employees, setEmployees] = useState([]);
  
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
    loadEmployees();
  }, []);

  useEffect(() => {
    loadTimeLogs();
  }, [page, classification, selectedEmployee, appFilter, dateRange]);

  const loadEmployees = async () => {
    try {
      // Get last 90 days to have good employee list
      const to = new Date();
      const from = new Date();
      from.setDate(to.getDate() - 90);
      
      const response = await employeesApi.getList({
        from: formatDate(from),
        to: formatDate(to),
        page: 1,
        limit: 100,
      });
      setEmployees(response.data || []);
    } catch (err) {
      console.error('Failed to load employees:', err);
    }
  };

  const loadTimeLogs = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await timeLogsApi.getList({
        classification: classification || undefined,
        employee: selectedEmployee || undefined,
        app: appFilter || undefined,
        from: dateRange.from,
        to: dateRange.to,
        page,
        limit: 20,
      });
      
      setLogs(response.data || []);
      setTotalCount(response.pagination?.totalCount || 0);
    } catch (err) {
      console.error('Failed to load time logs:', err);
      setError(err.response?.data?.error || 'Failed to load time logs');
    } finally {
      setLoading(false);
    }
  };

  const handleDateRangeChange = (newRange) => {
    setDateRange(newRange);
    setPage(1);
  };

  const handleFilterChange = () => {
    setPage(1);
  };

  const handleClearFilters = () => {
    setClassification('');
    setSelectedEmployee('');
    setAppFilter('');
    setPage(1);
  };

  const columns = [
    {
      key: 'userName',
      label: 'Employee',
      sortable: true,
    },
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
        <span className="truncate max-w-md block" title={value}>
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

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Time Logs</h1>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center gap-2 px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          <Filter className="w-4 h-4" />
          {showFilters ? 'Hide Filters' : 'Show Filters'}
        </button>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {/* Filters Panel */}
      {showFilters && (
        <div className="card mb-6">
          <h3 className="text-lg font-semibold mb-4">Filters</h3>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            {/* Classification Filter */}
            <div>
              <label className="block text-sm font-medium mb-2">Classification</label>
              <select
                value={classification}
                onChange={(e) => {
                  setClassification(e.target.value);
                  handleFilterChange();
                }}
                className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
              >
                <option value="">All</option>
                <option value="productive">Productive</option>
                <option value="non-productive">Non-Productive</option>
              </select>
            </div>

            {/* Employee Filter */}
            <div>
              <label className="block text-sm font-medium mb-2">Employee</label>
              <select
                value={selectedEmployee}
                onChange={(e) => {
                  setSelectedEmployee(e.target.value);
                  handleFilterChange();
                }}
                className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
              >
                <option value="">All Employees</option>
                {employees.map((emp) => (
                  <option key={emp.userId} value={emp.userId}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Application Filter */}
            <div>
              <label className="block text-sm font-medium mb-2">Application</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Filter by app..."
                  value={appFilter}
                  onChange={(e) => setAppFilter(e.target.value)}
                  onKeyUp={handleFilterChange}
                  className="w-full pl-10 pr-4 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
                />
              </div>
            </div>

            {/* Clear Filters */}
            <div className="flex items-end">
              <button
                onClick={handleClearFilters}
                className="w-full px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Clear Filters
              </button>
            </div>
          </div>

          {/* Date Range */}
          <div>
            <label className="block text-sm font-medium mb-2">Date Range</label>
            <DateRangePicker
              from={dateRange.from}
              to={dateRange.to}
              onChange={handleDateRangeChange}
            />
          </div>
        </div>
      )}

      {/* Results Summary */}
      <div className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Showing {totalCount} total log{totalCount !== 1 ? 's' : ''}
      </div>

      {/* Time Logs Table */}
      <DataTable
        columns={columns}
        data={logs}
        loading={loading}
        emptyMessage="No time logs found"
        pagination={{
          page,
          limit: 20,
          totalCount,
          onPageChange: setPage,
        }}
      />
    </div>
  );
}

export default TimeLogsPage;
