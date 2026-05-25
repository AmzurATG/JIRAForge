/**
 * Time Logs API
 */

import apiClient from './client';

export const timeLogsApi = {
  /**
   * Get time logs with filters.
   * 
   * @param {Object} params - Filters and pagination
   * @returns {Promise<Object>}
   */
  async getList(params) {
    const response = await apiClient.get('/api/portal/time-logs', { params });
    return response.data;
  },
};
