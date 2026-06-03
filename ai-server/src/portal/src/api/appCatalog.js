/**
 * Application Catalog API (shared, superadmin-managed list of apps)
 */

import apiClient from './client';

export const appCatalogApi = {
  /** List catalog apps (any authenticated portal user). */
  async list(params) {
    const response = await apiClient.get('/api/portal/app-catalog', { params });
    return response.data;
  },

  /** Add an app to the catalog (superadmin). */
  async create(data) {
    const response = await apiClient.post('/api/portal/app-catalog', data);
    return response.data;
  },

  /** Update a catalog app (superadmin). */
  async update(id, data) {
    const response = await apiClient.put(`/api/portal/app-catalog/${id}`, data);
    return response.data;
  },

  /** Delete a catalog app (superadmin). */
  async remove(id) {
    const response = await apiClient.delete(`/api/portal/app-catalog/${id}`);
    return response.data;
  },

  /** Bulk import catalog apps (superadmin). */
  async bulkImport(data) {
    const response = await apiClient.post('/api/portal/app-catalog/bulk-import', { data });
    return response.data;
  },

  /**
   * AI-assisted suggestion for an app name (advisory). Returns
   * { available, suggestions }. available=false when the feature flag is off.
   */
  async aiSuggest(name) {
    const response = await apiClient.post('/api/portal/app-catalog/ai-suggest', { name });
    return response.data;
  },
};

export default appCatalogApi;
