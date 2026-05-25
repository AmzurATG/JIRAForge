/**
 * DataTable Component
 * 
 * Sortable, paginated table with loading states.
 */

import { useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import LoadingSpinner from './LoadingSpinner';

function DataTable({ 
  columns, 
  data, 
  loading, 
  emptyMessage = 'No data available',
  onRowClick,
  pagination 
}) {
  const [sortColumn, setSortColumn] = useState(null);
  const [sortDirection, setSortDirection] = useState('asc');

  const handleSort = (columnKey) => {
    if (sortColumn === columnKey) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(columnKey);
      setSortDirection('asc');
    }
  };

  const sortedData = [...(data || [])].sort((a, b) => {
    if (!sortColumn) return 0;
    
    const aVal = a[sortColumn];
    const bVal = b[sortColumn];
    
    if (aVal === bVal) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    
    const compare = aVal < bVal ? -1 : 1;
    return sortDirection === 'asc' ? compare : -compare;
  });

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="w-16 h-16 mx-auto mb-4 bg-gray-100 dark:bg-gray-700 rounded-2xl flex items-center justify-center">
          <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <p className="text-gray-500 dark:text-gray-400">{emptyMessage}</p>
      </div>
    );
  }

  const totalPages = pagination ? Math.ceil(pagination.totalCount / pagination.limit) : 1;

  return (
    <div className="w-full">
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm">
        <table className="w-full min-w-max">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800/50 border-b border-gray-200 dark:border-gray-700">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider whitespace-nowrap"
                >
                  <div className="flex items-center gap-1">
                    <span>{col.label}</span>
                    {col.sortable && (
                      <button
                        onClick={() => handleSort(col.key)}
                        className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                      >
                        {sortColumn === col.key ? (
                          sortDirection === 'asc' ? (
                            <ChevronUp className="w-3 h-3 text-primary-600" />
                          ) : (
                            <ChevronDown className="w-3 h-3 text-primary-600" />
                          )
                        ) : (
                          <ChevronsUpDown className="w-3 h-3 text-gray-400" />
                        )}
                      </button>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50 bg-white dark:bg-gray-800">
            {sortedData.map((row, idx) => (
              <tr
                key={idx}
                onClick={() => onRowClick && onRowClick(row)}
                className={`transition-colors ${
                  onRowClick 
                    ? 'cursor-pointer hover:bg-primary-50 dark:hover:bg-primary-900/10' 
                    : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                }`}
              >
                {columns.map((col) => (
                  <td key={col.key} className="px-3 py-2 text-xs text-gray-900 dark:text-gray-100">
                    {col.render ? col.render(row[col.key], row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      {pagination && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Showing <span className="font-medium text-gray-900 dark:text-gray-100">{((pagination.page - 1) * pagination.limit) + 1}</span> to <span className="font-medium text-gray-900 dark:text-gray-100">{Math.min(pagination.page * pagination.limit, pagination.totalCount)}</span> of <span className="font-medium text-gray-900 dark:text-gray-100">{pagination.totalCount}</span> results
          </p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => pagination.onPageChange(pagination.page - 1)}
              disabled={pagination.page === 1}
              className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                let pageNum;
                if (totalPages <= 5) {
                  pageNum = i + 1;
                } else if (pagination.page <= 3) {
                  pageNum = i + 1;
                } else if (pagination.page >= totalPages - 2) {
                  pageNum = totalPages - 4 + i;
                } else {
                  pageNum = pagination.page - 2 + i;
                }
                
                return (
                  <button
                    key={pageNum}
                    onClick={() => pagination.onPageChange(pageNum)}
                    className={`w-7 h-7 rounded-lg text-xs font-medium transition-all ${
                      pagination.page === pageNum
                        ? 'bg-primary-600 text-white shadow-sm'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                  >
                    {pageNum}
                  </button>
                );
              })}
            </div>
            
            <button
              onClick={() => pagination.onPageChange(pagination.page + 1)}
              disabled={pagination.page >= totalPages}
              className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DataTable;
