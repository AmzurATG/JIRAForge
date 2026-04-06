/**
 * Cleanup Old Export Files
 * 
 * Deletes export files from the 'exports' bucket that are older than 7 days.
 * This compensates for lack of lifecycle policy in Supabase UI.
 * 
 * Usage:
 *   node scripts/cleanup-old-exports.js
 * 
 * Schedule this script to run weekly via cron or task scheduler.
 * 
 * Created: April 3, 2026
 */

const { getClient } = require('../src/services/db/supabase-client');
const logger = require('../src/utils/logger');

const BUCKET_NAME = 'exports';
const MAX_AGE_DAYS = 7;

/**
 * Delete files older than specified days from exports bucket
 */
async function cleanupOldExports() {
  const supabase = getClient();
  
  try {
    logger.info('[Cleanup] Starting cleanup of old export files...');
    
    // List all files in exports bucket
    const { data: files, error: listError } = await supabase.storage
      .from(BUCKET_NAME)
      .list('', {
        limit: 1000,
        sortBy: { column: 'created_at', order: 'asc' }
      });
    
    if (listError) {
      throw new Error(`Failed to list files: ${listError.message}`);
    }
    
    if (!files || files.length === 0) {
      logger.info('[Cleanup] No files found in exports bucket');
      return { deleted: 0, skipped: 0, errors: 0 };
    }
    
    logger.info(`[Cleanup] Found ${files.length} files in exports bucket`);
    
    // Calculate cutoff date (7 days ago)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - MAX_AGE_DAYS);
    
    // Filter files older than cutoff
    const oldFiles = files.filter(file => {
      const fileDate = new Date(file.created_at);
      return fileDate < cutoffDate;
    });
    
    if (oldFiles.length === 0) {
      logger.info('[Cleanup] No files older than 7 days found');
      return { deleted: 0, skipped: files.length, errors: 0 };
    }
    
    logger.info(`[Cleanup] Found ${oldFiles.length} files older than ${MAX_AGE_DAYS} days`);
    
    // Delete old files
    let deleted = 0;
    let errors = 0;
    
    for (const file of oldFiles) {
      try {
        const { error: deleteError } = await supabase.storage
          .from(BUCKET_NAME)
          .remove([file.name]);
        
        if (deleteError) {
          logger.error(`[Cleanup] Failed to delete ${file.name}: ${deleteError.message}`);
          errors++;
        } else {
          logger.info(`[Cleanup] Deleted: ${file.name} (age: ${Math.floor((Date.now() - new Date(file.created_at)) / (1000 * 60 * 60 * 24))} days)`);
          deleted++;
        }
      } catch (err) {
        logger.error(`[Cleanup] Error deleting ${file.name}:`, err);
        errors++;
      }
    }
    
    const result = {
      deleted,
      skipped: files.length - oldFiles.length,
      errors
    };
    
    logger.info(`[Cleanup] Cleanup complete: ${deleted} deleted, ${result.skipped} skipped, ${errors} errors`);
    
    return result;
    
  } catch (error) {
    logger.error('[Cleanup] Fatal error during cleanup:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  cleanupOldExports()
    .then(result => {
      console.log('\n✅ Cleanup Summary:');
      console.log(`   Deleted: ${result.deleted} files`);
      console.log(`   Skipped: ${result.skipped} files (< 7 days old)`);
      console.log(`   Errors: ${result.errors} files`);
      
      process.exit(result.errors > 0 ? 1 : 0);
    })
    .catch(err => {
      console.error('\n❌ Cleanup failed:', err.message);
      process.exit(1);
    });
}

module.exports = { cleanupOldExports };
