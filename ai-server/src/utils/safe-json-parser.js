/**
 * Safe JSON Parser
 * Provides size-validated JSON parsing to prevent CPU exhaustion attacks
 * 
 * DDoS Protection: Prevents parsing of excessively large JSON strings
 * that could cause CPU exhaustion or memory exhaustion attacks
 */

const logger = require('./logger');

// Default maximum JSON size: 1MB (same as express.json limit)
const DEFAULT_MAX_SIZE = 1 * 1024 * 1024;

// Maximum JSON size for specific use cases
const MAX_SIZES = {
  'user-assigned-issues': 100 * 1024,      // 100KB - user issue lists
  'ai-response': 500 * 1024,               // 500KB - AI/LLM responses
  'metadata': 50 * 1024,                   // 50KB - metadata objects
  'config': 10 * 1024,                     // 10KB - configuration objects
  'default': DEFAULT_MAX_SIZE              // 1MB - general purpose
};

/**
 * Safely parse JSON string with size validation
 * 
 * @param {string} str - JSON string to parse
 * @param {Object} options - Parsing options
 * @param {number} options.maxSize - Maximum allowed size in bytes (default: 1MB)
 * @param {string} options.context - Context for logging (e.g., 'user-assigned-issues')
 * @param {boolean} options.throwOnError - Throw error instead of returning null (default: false)
 * @returns {Object|Array|null} Parsed JSON object or null if parsing fails
 * @throws {Error} If size exceeds limit and throwOnError is true
 */
function safeJSONParse(str, options = {}) {
  const {
    maxSize = DEFAULT_MAX_SIZE,
    context = 'unknown',
    throwOnError = false
  } = options;

  // Validate input
  if (!str) {
    return null;
  }

  if (typeof str !== 'string') {
    logger.warn('[SafeJSONParse] Invalid input type - expected string', { 
      context, 
      type: typeof str 
    });
    return throwOnError ? (() => { throw new Error('Input must be a string'); })() : null;
  }

  // Check size before parsing (prevents CPU exhaustion)
  const byteSize = Buffer.byteLength(str, 'utf8');
  
  if (byteSize > maxSize) {
    const errorMsg = `JSON string exceeds maximum size of ${formatBytes(maxSize)} (actual: ${formatBytes(byteSize)})`;
    
    logger.warn('[SafeJSONParse] Size limit exceeded', {
      context,
      maxSize: formatBytes(maxSize),
      actualSize: formatBytes(byteSize),
      exceeded: formatBytes(byteSize - maxSize)
    });

    if (throwOnError) {
      throw new Error(errorMsg);
    }
    
    return null;
  }

  // Attempt to parse
  try {
    const parsed = JSON.parse(str);
    
    // Log successful parse for large objects (debugging)
    if (byteSize > 100 * 1024) { // Log if > 100KB
      logger.debug('[SafeJSONParse] Large JSON parsed successfully', {
        context,
        size: formatBytes(byteSize)
      });
    }
    
    return parsed;
  } catch (error) {
    logger.warn('[SafeJSONParse] JSON parse failed', {
      context,
      error: error.message,
      size: formatBytes(byteSize),
      preview: str.substring(0, 100) + (str.length > 100 ? '...' : '')
    });

    if (throwOnError) {
      throw error;
    }
    
    return null;
  }
}

/**
 * Parse JSON with automatic size limit based on context
 * 
 * @param {string} str - JSON string to parse
 * @param {string} context - Context key from MAX_SIZES
 * @param {boolean} throwOnError - Throw error instead of returning null
 * @returns {Object|Array|null} Parsed JSON or null
 */
function safeJSONParseByContext(str, context = 'default', throwOnError = false) {
  const maxSize = MAX_SIZES[context] || MAX_SIZES.default;
  return safeJSONParse(str, { maxSize, context, throwOnError });
}

/**
 * Safely stringify JSON with circular reference detection
 * 
 * @param {*} obj - Object to stringify
 * @param {Object} options - Stringify options
 * @param {number} options.maxDepth - Maximum nesting depth (default: 10)
 * @param {number} options.space - Indentation spaces (default: 0)
 * @returns {string|null} JSON string or null if failed
 */
function safeJSONStringify(obj, options = {}) {
  const {
    maxDepth = 10,
    space = 0
  } = options;

  // Track seen objects to detect circular references
  const seen = new WeakSet();
  let depth = 0;

  try {
    return JSON.stringify(obj, (key, value) => {
      // Check nesting depth
      if (key && depth++ > maxDepth) {
        return '[Max Depth Exceeded]';
      }

      // Check for circular references
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular Reference]';
        }
        seen.add(value);
      }

      // Reset depth on new object
      if (!key) {
        depth = 0;
      }

      return value;
    }, space);
  } catch (error) {
    logger.error('[SafeJSONStringify] Stringify failed', {
      error: error.message
    });
    return null;
  }
}

/**
 * Format bytes to human-readable string
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted string (e.g., "1.5 MB")
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Validate that a parsed object doesn't exceed complexity limits
 * Helps prevent JSON bomb attacks (deeply nested or extremely large objects)
 * 
 * @param {*} obj - Parsed object to validate
 * @param {Object} options - Validation options
 * @param {number} options.maxDepth - Maximum nesting depth (default: 20)
 * @param {number} options.maxKeys - Maximum number of keys (default: 10000)
 * @returns {boolean} True if valid, false otherwise
 */
function validateJSONComplexity(obj, options = {}) {
  const {
    maxDepth = 20,
    maxKeys = 10000
  } = options;

  let totalKeys = 0;
  
  function checkDepth(value, depth = 0) {
    if (depth > maxDepth) {
      logger.warn('[ValidateJSONComplexity] Max depth exceeded', { depth });
      return false;
    }

    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      totalKeys += keys.length;

      if (totalKeys > maxKeys) {
        logger.warn('[ValidateJSONComplexity] Max keys exceeded', { totalKeys });
        return false;
      }

      for (const key of keys) {
        if (!checkDepth(value[key], depth + 1)) {
          return false;
        }
      }
    }

    return true;
  }

  return checkDepth(obj);
}

module.exports = {
  safeJSONParse,
  safeJSONParseByContext,
  safeJSONStringify,
  validateJSONComplexity,
  formatBytes,
  MAX_SIZES
};
