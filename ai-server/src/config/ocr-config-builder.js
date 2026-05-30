'use strict';

/**
 * OCR / Privacy config builder
 *
 * Builds the OCR engine config and the privacy-filter config from environment
 * variables. Centralized so it can be served to BOTH:
 *   - Atlassian users via POST /api/auth/ocr-config (auth-controller), and
 *   - non-Jira Google users in the /api/auth/desktop-google response
 *     (they have no Atlassian token to call ocr-config, so the config must
 *     travel with the login response — otherwise they'd run OCR with default
 *     privacy settings, which is a privacy gap).
 *
 * The config is global (derived from process.env), not per-user or per-org.
 */

const OCR_RESERVED_PARTS = new Set(['PRIMARY', 'FALLBACK', 'USE', 'MAX', 'PREPROCESSING']);

/**
 * Build the OCR engine configuration from environment variables, dynamically
 * discovering OCR_<ENGINE>_* settings.
 * @returns {Object} OCR config
 */
function buildOcrConfig() {
  const ocrConfig = {
    primary_engine: process.env.OCR_PRIMARY_ENGINE || 'rapidocr',
    fallback_engines: (process.env.OCR_FALLBACK_ENGINES || 'winrtocr').split(',').map(e => e.trim()),
    use_preprocessing: (process.env.OCR_USE_PREPROCESSING || 'true').toLowerCase() === 'true',
    max_image_dimension: Number.parseInt(process.env.OCR_MAX_IMAGE_DIMENSION || '4096', 10),
    preprocessing_target_dpi: Number.parseInt(process.env.OCR_PREPROCESSING_TARGET_DPI || '300', 10),
    engines: {}
  };

  const discoveredEngines = new Set();
  discoveredEngines.add(ocrConfig.primary_engine);
  ocrConfig.fallback_engines.forEach(e => discoveredEngines.add(e));

  // Scan environment for OCR_<ENGINE>_* patterns
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('OCR_') && key.includes('_', 4)) {
      const parts = key.split('_');
      if (parts.length >= 3 && !OCR_RESERVED_PARTS.has(parts[1])) {
        discoveredEngines.add(parts[1].toLowerCase());
      }
    }
  });

  // Build configuration for each discovered engine
  const standardKeys = new Set(['ENABLED', 'MIN_CONFIDENCE', 'USE_GPU', 'LANGUAGE']);
  discoveredEngines.forEach(engineName => {
    const prefix = `OCR_${engineName.toUpperCase()}_`;
    const engineConfig = {
      name: engineName,
      enabled: (process.env[`${prefix}ENABLED`] || 'true').toLowerCase() === 'true',
      min_confidence: Number.parseFloat(process.env[`${prefix}MIN_CONFIDENCE`] || '0.5'),
      use_gpu: (process.env[`${prefix}USE_GPU`] || 'false').toLowerCase() === 'true',
      language: process.env[`${prefix}LANGUAGE`] || 'en',
      extra_params: {}
    };

    Object.keys(process.env).forEach(key => {
      if (key.startsWith(prefix)) {
        const paramName = key.substring(prefix.length).toLowerCase();
        if (!standardKeys.has(paramName.toUpperCase())) {
          engineConfig.extra_params[paramName] = process.env[key];
        }
      }
    });

    ocrConfig.engines[engineName] = engineConfig;
  });

  return ocrConfig;
}

/**
 * Build the privacy-filter configuration from environment variables.
 * @returns {Object} Privacy config
 */
function buildPrivacyConfig() {
  return {
    enabled: (process.env.PRIVACY_FILTER_ENABLED || 'true').toLowerCase() === 'true',
    min_confidence: Number.parseFloat(process.env.PRIVACY_MIN_CONFIDENCE || '0.7'),
    detect_pii: (process.env.PRIVACY_DETECT_PII || 'true').toLowerCase() === 'true',
    detect_secrets: (process.env.PRIVACY_DETECT_SECRETS || 'false').toLowerCase() === 'true',
    detect_custom_patterns: (process.env.PRIVACY_DETECT_CUSTOM_PATTERNS || 'true').toLowerCase() === 'true',
    redaction_strategy: process.env.PRIVACY_REDACTION_STRATEGY || 'mask',
    mask_char: (process.env.PRIVACY_MASK_CHAR || '*').charAt(0) || '*',
    mask_length: Number.parseInt(process.env.PRIVACY_MASK_LENGTH || '8', 10),
    fail_open: (process.env.PRIVACY_FAIL_OPEN || 'false').toLowerCase() === 'true'
  };
}

module.exports = { buildOcrConfig, buildPrivacyConfig };
