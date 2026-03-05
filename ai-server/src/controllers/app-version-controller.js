/**
 * App Version Controller
 * Handles version checking and update notifications for the desktop app
 */

const crypto = require('node:crypto');
const https = require('node:https');
const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');

/**
 * Get the latest app version for a platform
 * 
 * GET /api/app-version/latest?platform=windows
 * 
 * Public endpoint - no authentication required
 * Used by desktop app to check for updates
 */
exports.getLatestVersion = async (req, res) => {
  try {
    const platform = req.query.platform || 'windows';
    
    // Validate platform
    const validPlatforms = ['windows', 'macos', 'linux'];
    if (!validPlatforms.includes(platform.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid platform. Must be one of: ${validPlatforms.join(', ')}`
      });
    }

    const supabase = getClient();
    if (!supabase) {
      logger.error('[AppVersion] Supabase client not available');
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    // Get the latest active release for the platform
    const { data: release, error } = await supabase
      .from('app_releases')
      .select('version, download_url, release_notes, is_mandatory, min_supported_version, file_size_bytes, checksum, published_at')
      .eq('platform', platform.toLowerCase())
      .eq('is_latest', true)
      .eq('is_active', true)
      .single();

    if (error) {
      // If no release found, return a default
      if (error.code === 'PGRST116') {
        logger.warn(`[AppVersion] No release found for platform: ${platform}`);
        return res.json({
          success: true,
          data: {
            version: '1.0.0',
            downloadUrl: null,
            releaseNotes: null,
            isMandatory: false,
            minSupportedVersion: null,
            checksum: null
          }
        });
      }
      throw error;
    }

    logger.info(`[AppVersion] Latest version for ${platform}: ${release.version}`);

    res.json({
      success: true,
      data: {
        version: release.version,
        downloadUrl: release.download_url,
        releaseNotes: release.release_notes,
        isMandatory: release.is_mandatory,
        minSupportedVersion: release.min_supported_version,
        fileSizeBytes: release.file_size_bytes,
        checksum: release.checksum,  // SHA256 hash for integrity verification
        publishedAt: release.published_at
      }
    });

  } catch (error) {
    logger.error('[AppVersion] Error getting latest version:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get latest version'
    });
  }
};

/**
 * Check if an update is available for a specific version
 * 
 * GET /api/app-version/check?platform=windows&current=1.0.0
 * 
 * Public endpoint - no authentication required
 * Returns whether an update is available and details
 */
exports.checkForUpdate = async (req, res) => {
  try {
    const platform = req.query.platform || 'windows';
    const currentVersion = req.query.current;

    if (!currentVersion) {
      return res.status(400).json({
        success: false,
        error: 'Current version is required (e.g., ?current=1.0.0)'
      });
    }

    // Validate version format (basic semver check)
    if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid version format. Use semantic versioning (e.g., 1.0.0)'
      });
    }

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    // Get the latest release
    const { data: release, error } = await supabase
      .from('app_releases')
      .select('version, download_url, release_notes, is_mandatory, min_supported_version, file_size_bytes, checksum, published_at')
      .eq('platform', platform.toLowerCase())
      .eq('is_latest', true)
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    // If no release found, no update available
    if (!release) {
      return res.json({
        success: true,
        data: {
          updateAvailable: false,
          currentVersion,
          latestVersion: currentVersion,
          checksum: null
        }
      });
    }

    // Compare versions
    const updateAvailable = isNewerVersion(release.version, currentVersion);
    
    // Check if current version meets minimum requirement
    let canUpdate = true;
    if (release.min_supported_version) {
      canUpdate = !isNewerVersion(release.min_supported_version, currentVersion);
    }

    logger.info(`[AppVersion] Update check: current=${currentVersion}, latest=${release.version}, updateAvailable=${updateAvailable}`);

    res.json({
      success: true,
      data: {
        updateAvailable,
        canUpdate,
        currentVersion,
        latestVersion: release.version,
        downloadUrl: updateAvailable ? release.download_url : null,
        releaseNotes: updateAvailable ? release.release_notes : null,
        isMandatory: updateAvailable ? release.is_mandatory : false,
        fileSizeBytes: release.file_size_bytes,
        checksum: updateAvailable ? release.checksum : null,  // SHA256 for integrity verification
        publishedAt: release.published_at
      }
    });

  } catch (error) {
    logger.error('[AppVersion] Error checking for update:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check for updates'
    });
  }
};

/**
 * Get all releases for a platform (for admin/history view)
 * 
 * GET /api/app-version/releases?platform=windows
 * 
 * Protected endpoint - requires authentication
 */
exports.getAllReleases = async (req, res) => {
  try {
    const platform = req.query.platform || 'windows';
    const includeInactive = req.query.includeInactive === 'true';

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    let query = supabase
      .from('app_releases')
      .select('*')
      .eq('platform', platform.toLowerCase())
      .order('published_at', { ascending: false });

    if (!includeInactive) {
      query = query.eq('is_active', true);
    }

    const { data: releases, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      data: releases || []
    });

  } catch (error) {
    logger.error('[AppVersion] Error getting releases:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get releases'
    });
  }
};

/**
 * Create a new release (admin only)
 * 
 * POST /api/app-version/releases
 * Body: { version, platform, downloadUrl, releaseNotes, isMandatory, minSupportedVersion }
 * 
 * Protected endpoint - requires authentication
 */
exports.createRelease = async (req, res) => {
  try {
    const {
      version,
      platform = 'windows',
      downloadUrl,
      releaseNotes,
      isMandatory = false,
      minSupportedVersion,
      fileSizeBytes,
      checksum  // SHA256 hash (optional - can be computed separately)
    } = req.body;

    // Validate required fields
    if (!version) {
      return res.status(400).json({
        success: false,
        error: 'Version is required'
      });
    }

    if (!downloadUrl) {
      return res.status(400).json({
        success: false,
        error: 'Download URL is required'
      });
    }

    // Validate version format
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid version format. Use semantic versioning (e.g., 1.1.0)'
      });
    }

    // Validate checksum format if provided (should be 64 hex characters for SHA256)
    if (checksum && !/^[a-fA-F0-9]{64}$/.test(checksum)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid checksum format. Must be a 64-character SHA256 hex string'
      });
    }

    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({
        success: false,
        error: 'Database not configured'
      });
    }

    // Insert new release (trigger will auto-update is_latest)
    const { data: release, error } = await supabase
      .from('app_releases')
      .insert({
        version,
        platform: platform.toLowerCase(),
        download_url: downloadUrl,
        release_notes: releaseNotes,
        is_mandatory: isMandatory,
        min_supported_version: minSupportedVersion,
        file_size_bytes: fileSizeBytes,
        checksum: checksum ? checksum.toLowerCase() : null,
        is_latest: true,
        is_active: true
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          success: false,
          error: `Version ${version} already exists for platform ${platform}`
        });
      }
      throw error;
    }

    logger.info(`[AppVersion] Created new release: ${version} for ${platform}`);

    res.status(201).json({
      success: true,
      data: release
    });

  } catch (error) {
    logger.error('[AppVersion] Error creating release:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create release'
    });
  }
};

/**
 * Compute SHA256 checksum for a file at a given URL
 * 
 * POST /api/app-version/compute-checksum
 * Body: { url }
 * 
 * Protected endpoint - requires authentication
 * Useful for admins to compute checksum before creating a release
 */
exports.computeChecksum = async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'URL is required'
      });
    }

    const urlError = validateDownloadUrl(url);
    if (urlError) {
      return res.status(400).json({ success: false, error: urlError });
    }

    logger.info(`[AppVersion] Computing checksum for: ${url}`);

    // Compute checksum by streaming the file
    const checksum = await computeSHA256FromUrl(url);

    res.json({
      success: true,
      data: {
        url,
        checksum,
        algorithm: 'SHA256'
      }
    });

  } catch (error) {
    logger.error('[AppVersion] Error computing checksum:', error);
    res.status(500).json({
      success: false,
      error: `Failed to compute checksum: ${error.message}`
    });
  }
};

// Trusted domains for download URLs.
// Override via comma-separated ALLOWED_DOWNLOAD_DOMAINS env var.
const ALLOWED_DOWNLOAD_DOMAINS = (
  process.env.ALLOWED_DOWNLOAD_DOMAINS ||
  'github.com,objects.githubusercontent.com,releases.githubusercontent.com,' +
  'amazonaws.com,cloudfront.net,supabase.co,blob.core.windows.net,storage.googleapis.com'
).split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

/**
 * Validates a download URL against an allowlist of trusted domains.
 * Only HTTPS URLs whose hostname matches (or is a subdomain of) an allowed
 * domain are accepted — prevents SSRF via private/internal hosts.
 * @param {string} url
 * @returns {string|null} Error message, or null if valid
 */
function validateDownloadUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL format';
  }
  if (parsed.protocol !== 'https:') {
    return 'Only HTTPS URLs are allowed';
  }
  const host = parsed.hostname.toLowerCase();
  const isAllowed = ALLOWED_DOWNLOAD_DOMAINS.some(
    domain => host === domain || host.endsWith(`.${domain}`)
  );
  if (!isAllowed) {
    return `Download domain not in allowed list: ${host}`;
  }
  return null;
}

/**
 * Compute SHA256 hash of a file from URL
 * Streams the file to avoid loading entirely into memory
 *
 * @param {string} url - URL to download and hash (must already be validated)
 * @returns {Promise<string>} SHA256 hash as lowercase hex string
 */
function computeSHA256FromUrl(url) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');

    const request = https.get(url, (response) => {
      // Handle redirects — validate Location header before following
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const redirectError = validateDownloadUrl(response.headers.location);
        if (redirectError) {
          return reject(new Error(`Redirect blocked: ${redirectError}`));
        }
        return computeSHA256FromUrl(response.headers.location)
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
      }

      response.on('data', (chunk) => {
        hash.update(chunk);
      });

      response.on('end', () => {
        resolve(hash.digest('hex'));
      });

      response.on('error', reject);
    });

    request.on('error', reject);
    
    // Set timeout for large files (5 minutes)
    request.setTimeout(5 * 60 * 1000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Compare two semantic versions
 * @param {string} v1 - Version to compare
 * @param {string} v2 - Version to compare against
 * @returns {boolean} True if v1 is newer than v2
 */
function isNewerVersion(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    
    if (p1 > p2) return true;
    if (p1 < p2) return false;
  }
  
  return false; // Versions are equal
}

// Export the version comparison function for testing
exports.isNewerVersion = isNewerVersion;
