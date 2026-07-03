/**
 * Data Export Background Job
 * Processes large exports asynchronously
 * 
 * @module dataExportJob
 */

const cron = require('node-cron');
const { cleanupExpiredExports } = require('./dataExport');

/**
 * Start the data export cleanup job
 * Runs every hour to clean up expired exports
 */
function startDataExportCleanupJob() {
    // Run every hour
    cron.schedule('0 * * * *', async () => {
        console.log('🕐 [DATA EXPORT JOB] Running cleanup...');
        try {
            await cleanupExpiredExports();
        } catch (error) {
            console.error('❌ [DATA EXPORT JOB] Error:', error.message);
        }
    });

    console.log('✅ [DATA EXPORT JOB] Cleanup job started (every hour)');
}

/**
 * Process a batch export request (for future use)
 * @param {string} userId - The user ID
 * @param {string} format - 'json' or 'csv'
 * @param {string} exportId - The export ID
 * @param {object} options - Additional options
 */
async function processBatchExport(userId, format, exportId, options = {}) {
    console.log(`📤 [DATA EXPORT] Processing batch export: ${exportId} for user ${userId}`);
    // This would be implemented for very large exports (>1000 leads)
    // For now, we process synchronously in dataExport.js
    return true;
}

module.exports = {
    startDataExportCleanupJob,
    processBatchExport
};
