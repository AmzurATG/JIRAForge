/**
 * Time Logs Page
 * 
 * Displays all employee activity logs with comprehensive filtering.
 */

import { useState, useEffect, useRef } from 'react';
import { Search, Filter, Columns } from 'lucide-react';
import { timeLogsApi } from '../api/timeLogs';
import { employeesApi } from '../api/employees';
import DataTable from '../components/common/DataTable';
import DateRangePicker from '../components/common/DateRangePicker';
import LobFilter from '../components/common/LobFilter';
import LocationFilter from '../components/common/LocationFilter';
import EmployeeSelect from '../components/common/EmployeeSelect';
import CategoryBadge from '../components/common/CategoryBadge';
import ErrorBanner from '../components/common/ErrorBanner';
import { formatDate, formatDuration, formatDateTime } from '../utils/formatters';
import { useDebounce } from '../hooks/useDebounce';

function TimeLogsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [logs, setLogs] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(true);
  const [showColumnSelector, setShowColumnSelector] = useState(false);
  
  // Ref for click-outside detection
  const columnSelectorRef = useRef(null);
  
  // Filters
  const [classification, setClassification] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [appFilter, setAppFilter] = useState('');
  const debouncedAppFilter = useDebounce(appFilter, 500);
  const [durationMax, setDurationMax] = useState('');
  const [lobId, setLobId] = useState('');
  const [locationId, setLocationId] = useState('');
  
  // Column visibility
  const [visibleColumns, setVisibleColumns] = useState({
    userName: true,
    startTime: true,
    endTime: true,
    application: true,
    windowTitle: true,
    durationSeconds: true,
    classification: true,
  });
  
  // Employee list for filter
  const [employees, setEmployees] = useState([]);
  
  // Default to today (shown as the "Today" preset in the picker)
  const [dateRange, setDateRange] = useState(() => {
    const today = formatDate(new Date());
    return { from: today, to: today };
  });

  useEffect(() => {
    loadEmployees();
  }, [lobId, locationId]);

  useEffect(() => {
    loadTimeLogs();
  }, [page, classification, selectedEmployee, debouncedAppFilter, durationMax, dateRange, lobId, locationId]);

  // Close column selector when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (columnSelectorRef.current && !columnSelectorRef.current.contains(event.target)) {
        setShowColumnSelector(false);
      }
    }

    if (showColumnSelector) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showColumnSelector]);

  const loadEmployees = async () => {
    try {
      const response = await employeesApi.getSimpleList(undefined, lobId || undefined, locationId || undefined);
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
        app: debouncedAppFilter || undefined,
        lobId: lobId || undefined,
        locationId: locationId || undefined,
        durationMax: durationMax ? parseInt(durationMax, 10) * 60 : undefined, // Convert minutes to seconds
        from: dateRange.from,
        to: dateRange.to,
        page,
        limit: 10,
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
    setDurationMax('');
    setLocationId('');
    setPage(1);
  };

  const toggleColumnVisibility = (columnKey) => {
    setVisibleColumns(prev => ({
      ...prev,
      [columnKey]: !prev[columnKey]
    }));
  };

  const columnLabels = {
    userName: 'Employee',
    startTime: 'Start Time',
    endTime: 'End Time',
    application: 'Application',
    windowTitle: 'Window Title',
    durationSeconds: 'Duration',
    classification: 'Classification',
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
      render: (value, row) => <CategoryBadge value={row.category || value} />,
    },
  ].filter(col => visibleColumns[col.key]);

  return (
    <div className="space-y-3">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <div>
          <h1 className="page-title">Time Logs</h1>
          <p className="text-gray-500 dark:text-gray-400 text-xs">View and filter employee activity logs</p>
        </div>
        <div className="flex gap-2">
          {/* Column Visibility Toggle */}
          <div className="relative" ref={columnSelectorRef}>
            <button
              onClick={() => setShowColumnSelector(!showColumnSelector)}
              className="btn-secondary flex items-center gap-1.5"
            >
              <Columns className="w-3.5 h-3.5" />
              Columns
            </button>
            {showColumnSelector && (
              <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 z-20 overflow-hidden">
                <div className="p-2 border-b border-gray-100 dark:border-gray-700">
                  <h4 className="text-xs font-semibold text-gray-900 dark:text-gray-100">Show/Hide Columns</h4>
                </div>
                <div className="p-1 max-h-48 overflow-y-auto">
                  {Object.keys(columnLabels).map((key) => (
                    <label key={key} className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded transition-colors">
                      <input
                        type="checkbox"
                        checked={visibleColumns[key]}
                        onChange={() => toggleColumnVisibility(key)}
                        className="w-3.5 h-3.5 rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                      />
                      <span className="text-xs text-gray-700 dark:text-gray-300">{columnLabels[key]}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`btn-secondary flex items-center gap-1.5 ${showFilters ? 'bg-primary-50 dark:bg-primary-900/20 border-primary-200 dark:border-primary-800' : ''}`}
          >
            <Filter className="w-3.5 h-3.5" />
            {showFilters ? 'Hide Filters' : 'Show Filters'}
          </button>
        </div>
      </div>

      {error && (
        <ErrorBanner message={error} onClose={() => setError(null)} />
      )}

      {/* Filters Panel */}
      {showFilters && (
        <div className="card-elevated">
          <div className="flex items-center justify-between mb-3">
            <h3 className="section-title">
              <div className="p-1 bg-primary-100 dark:bg-primary-900/30 rounded">
                <Filter className="w-3 h-3 text-primary-600 dark:text-primary-400" />
              </div>
              Filters
            </h3>
            <button
              onClick={handleClearFilters}
              className="text-xs text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 font-medium"
            >
              Clear All
            </button>
          </div>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
            {/* Classification Filter */}
            <div>
              <label className="filter-label text-xs">Classification</label>
              <select
                value={classification}
                onChange={(e) => {
                  setClassification(e.target.value);
                  handleFilterChange();
                }}
                className="select-field"
              >
                <option value="">All Classifications</option>
                <option value="productive">Productive</option>
                <option value="non-productive">Non-Productive</option>
                <option value="neutral">Neutral</option>
              </select>
            </div>

            {/* Employee Filter — searchable (type to filter as you go) */}
            <div>
              <label className="filter-label text-xs">Employee</label>
              <EmployeeSelect
                employees={employees}
                value={selectedEmployee}
                onChange={(v) => {
                  setSelectedEmployee(v);
                  handleFilterChange();
                }}
              />
            </div>

            {/* Application Filter */}
            <div>
              <label className="filter-label text-xs">Application</label>
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search applications..."
                  value={appFilter}
                  onChange={(e) => setAppFilter(e.target.value)}
                  onKeyUp={handleFilterChange}
                  className="input-field pl-10"
                />
              </div>
            </div>

            {/* Duration Filter */}
            <div>
              <label className="filter-label text-xs">Duration</label>
              <select
                value={durationMax}
                onChange={(e) => {
                  setDurationMax(e.target.value);
                  handleFilterChange();
                }}
                className="select-field"
              >
                <option value="">All Durations</option>
                <option value="5">5 mins</option>
                <option value="10">10 mins</option>
                <option value="15">15 mins</option>
                <option value="30">30 mins</option>
                <option value="60">1 hr</option>
                <option value="120">2 hrs</option>
                <option value="300">5 hrs</option>
              </select>
            </div>

            {/* Date Range */}
            <div>
              <label className="filter-label text-xs">Date Range</label>
              <DateRangePicker
                from={dateRange.from}
                to={dateRange.to}
                onChange={handleDateRangeChange}
              />
            </div>

            {/* LOB Filter */}
            <LobFilter value={lobId} onChange={(v) => { setLobId(v); setSelectedEmployee(''); setPage(1); }} />

            {/* Location Filter */}
            <LocationFilter value={locationId} onChange={(v) => { setLocationId(v); setSelectedEmployee(''); setPage(1); }} />
          </div>
        </div>
      )}

      {/* Results Summary */}
      <div className="card">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h3 className="section-title">Activity Records</h3>
            <span className="badge-info">{totalCount} total</span>
          </div>
        </div>

        {/* Time Logs Table */}
        <DataTable
          columns={columns}
          data={logs}
          loading={loading}
          emptyMessage="No time logs found"
          pagination={{
            page,
            limit: 10,
            totalCount,
            onPageChange: setPage,
          }}
        />
      </div>
    </div>
  );
}

export default TimeLogsPage;
