/**
 * Per-LOB App Classifications API
 *
 * Each LOB classifies catalog apps (productive / non_productive / private /
 * neutral). Allowed for superadmin (any LOB) or the head of the LOB.
 */

import apiClient from './client';

export const lobAppClassificationsApi = {
  /** Catalog apps merged with this LOB's classification + effective label. */
  async list(lobId, params) {
    const response = await apiClient.get(`/api/portal/lobs/${lobId}/app-classifications`, { params });
    return response.data;
  },

  /** Set/override this LOB's classification for one app (upsert). */
  async set(lobId, appId, classification) {
    const response = await apiClient.put(`/api/portal/lobs/${lobId}/app-classifications`, { appId, classification });
    return response.data;
  },

  /** Clear this LOB's classification for an app (falls back to default/neutral). */
  async clear(lobId, appId) {
    const response = await apiClient.delete(`/api/portal/lobs/${lobId}/app-classifications/${appId}`);
    return response.data;
  },

  /** Bulk set classifications for this LOB. */
  async bulkSet(lobId, items) {
    const response = await apiClient.post(`/api/portal/lobs/${lobId}/app-classifications/bulk`, { items });
    return response.data;
  },
};

export default lobAppClassificationsApi;
