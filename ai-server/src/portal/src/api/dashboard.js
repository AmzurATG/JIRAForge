/**
 * Dashboard API
 */

import apiClient from './client';

export const dashboardApi = {
  /**
   * Get dashboard data.
   * 
   * @param {string} from - Start date (YYYY-MM-DD)
   * @param {string} to - End date (YYYY-MM-DD)
   * @returns {Promise<Object>}
   */
  async getData(from, to) {
    const response = await apiClient.get('/api/portal/dashboard', {
      params: { from, to },
    });
    return response.data;
  },
};
