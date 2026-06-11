/**
 * Locations API (WS-B — Employee Location)
 *
 * Managed locations list (read: any portal user; write: superadmin) and
 * per-employee location assignment (superadmin).
 */

import apiClient from './client';

export const locationsApi = {
  /** List locations. Pass { includeInactive: true } for management views. */
  async list(params) {
    const response = await apiClient.get('/api/portal/locations', { params });
    return response.data;
  },

  /** Create a location (superadmin). */
  async create(name) {
    const response = await apiClient.post('/api/portal/locations', { name });
    return response.data;
  },

  /** Rename / activate / deactivate a location (superadmin). */
  async update(id, data) {
    const response = await apiClient.put(`/api/portal/locations/${id}`, data);
    return response.data;
  },

  /** Delete an unused location (superadmin). 409 when assigned to employees. */
  async remove(id) {
    const response = await apiClient.delete(`/api/portal/locations/${id}`);
    return response.data;
  },

  /** Assign (or clear with null) an employee's location (superadmin). */
  async setEmployeeLocation(userId, locationId) {
    const response = await apiClient.put(`/api/portal/employees/${userId}/profile`, { locationId });
    return response.data;
  },
};

export default locationsApi;
