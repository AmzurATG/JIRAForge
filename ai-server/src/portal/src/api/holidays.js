/**
 * Holidays API
 *
 * Company holiday list (read: any portal user; write: superadmin).
 * Plan: plan/2026-06-23_web-productivity-portal_holidays-legal-hours-and-category-percentages.md
 */

import apiClient from './client';

export const holidaysApi = {
  /** List holidays. Pass { year, includeInactive } to filter. */
  async list(params) {
    const response = await apiClient.get('/api/portal/holidays', { params });
    return response.data;
  },

  /** Create a holiday (superadmin). { date: 'YYYY-MM-DD', name }. */
  async create(date, name) {
    const response = await apiClient.post('/api/portal/holidays', { date, name });
    return response.data;
  },

  /** Update a holiday (superadmin). { date?, name?, isActive? }. */
  async update(id, data) {
    const response = await apiClient.put(`/api/portal/holidays/${id}`, data);
    return response.data;
  },

  /** Delete a holiday (superadmin). */
  async remove(id) {
    const response = await apiClient.delete(`/api/portal/holidays/${id}`);
    return response.data;
  },
};

export default holidaysApi;
