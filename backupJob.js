const cron = require('node-cron');
const { performBackup } = require('./backup');
const fs = require('fs-extra');
const path = require('path');

// Configuration
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const BACKUP_SCHEDULE = process.env.BACKUP_SCHEDULE || '*/30 * * * *'; // Every 30 minutes
const MAX_BACKUP_SIZE_GB = parseFloat(process.env.BACKUP_MAX_SIZE_GB) || 10;
const MAX_BACKUPS = 50; // Maximum number of backups to keep

// Track if backup is currently running (prevent overlaps)
let isBackupRunning = false;
let lastBackupTime = null;
let backupCount = 0;

/**
 * Start the automatic backup job
 */
function startBackupJob() {
    console.log(`⏰ [BACKUP JOB] Scheduled to run every 30 minutes (schedule: ${BACKUP_SCHEDULE})`);
    
    // Run first backup immediately on startup
    setTimeout(() => {
        console.log('🔄 [BACKUP JOB] Running initial backup on startup...');
        runBackupSafely();
    }, 5000); // Wait 5 seconds for server to fully start

    // Schedule recurring backups
    cron.schedule(BACKUP_SCHEDULE, async () => {
        console.log(`⏰ [BACKUP JOB] Scheduled backup triggered at ${new Date().toISOString()}`);
        await runBackupSafely();
    });
}

/**
 * Run backup safely (prevent overlapping)
 */
async function runBackupSafely() {
    // Prevent overlapping backups
    if (isBackupRunning) {
        console.log('⚠️ [BACKUP JOB] Backup already running, skipping this cycle');
        return;
    }

    // Check if backup directory is too large
    if (await isBackupDirectoryTooLarge()) {
        console.log('⚠️ [BACKUP JOB] Backup directory too large, cleaning up...');
        await cleanupOldBackups();
    }

    // Check if we have too many backups
    const backupCount = await countBackupFiles();
    if (backupCount >= MAX_BACKUPS) {
        console.log(`⚠️ [BACKUP JOB] Too many backups (${backupCount}), cleaning up...`);
        await cleanupOldBackups();
    }

    try {
        isBackupRunning = true;
        const startTime = Date.now();
        
        console.log(`📦 [BACKUP JOB] Starting backup at ${new Date().toISOString()}`);
        
        // Run the backup
        const result = await performBackup();
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ [BACKUP JOB] Backup completed in ${duration}s`);
        
        lastBackupTime = new Date();
        backupCount++;
        
        // Update status file
        await updateBackupStatus({
            lastBackup: lastBackupTime.toISOString(),
            backupCount: backupCount,
            duration: duration,
            file: result
        });
        
    } catch (error) {
        console.error('❌ [BACKUP JOB] Backup failed:', error.message);
        
        // Log error to status file
        await updateBackupStatus({
            lastBackup: lastBackupTime ? lastBackupTime.toISOString() : 'never',
            backupCount: backupCount,
            lastError: error.message,
            errorTime: new Date().toISOString()
        });
        
    } finally {
        isBackupRunning = false;
    }
}

/**
 * Check if backup directory is too large
 */
async function isBackupDirectoryTooLarge() {
    try {
        if (!fs.existsSync(BACKUP_DIR)) return false;
        
        const files = fs.readdirSync(BACKUP_DIR);
        let totalSize = 0;
        
        for (const file of files) {
            const filePath = path.join(BACKUP_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                if (stats.isFile()) {
                    totalSize += stats.size;
                }
            } catch (err) {
                // Skip files we can't read
            }
        }
        
        const maxSizeBytes = MAX_BACKUP_SIZE_GB * 1024 * 1024 * 1024;
        return totalSize > maxSizeBytes;
        
    } catch (error) {
        console.error('❌ [BACKUP JOB] Error checking directory size:', error.message);
        return false;
    }
}

/**
 * Count backup files
 */
async function countBackupFiles() {
    try {
        if (!fs.existsSync(BACKUP_DIR)) return 0;
        return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.zip')).length;
    } catch {
        return 0;
    }
}

/**
 * Clean up old backups (keep only 10 most recent)
 */
async function cleanupOldBackups() {
    try {
        if (!fs.existsSync(BACKUP_DIR)) return;
        
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.endsWith('.zip'))
            .map(f => ({
                name: f,
                path: path.join(BACKUP_DIR, f),
                mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime);
        
        // Keep only 10 most recent
        const toDelete = files.slice(10);
        
        for (const file of toDelete) {
            fs.removeSync(file.path);
            console.log(`🗑️ [BACKUP JOB] Deleted old backup: ${file.name}`);
        }
        
        if (toDelete.length > 0) {
            console.log(`✅ [BACKUP JOB] Cleaned up ${toDelete.length} old backups`);
        }
        
    } catch (error) {
        console.error('❌ [BACKUP JOB] Error cleaning up:', error.message);
    }
}

/**
 * Update backup status file
 */
async function updateBackupStatus(data) {
    try {
        const statusFile = path.join(BACKUP_DIR, 'status.json');
        let existing = {};
        
        try {
            if (fs.existsSync(statusFile)) {
                existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
            }
        } catch (parseError) {
            // If file is corrupted, start fresh
            console.log('⚠️ [BACKUP JOB] Status file corrupted, creating new one');
        }
        
        const status = {
            ...existing,
            ...data,
            lastChecked: new Date().toISOString()
        };
        
        fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
        
    } catch (error) {
        // Don't fail if status update fails
        console.error('⚠️ [BACKUP JOB] Could not update status:', error.message);
    }
}

/**
 * Get backup status
 */
function getBackupStatus() {
    try {
        const statusFile = path.join(BACKUP_DIR, 'status.json');
        if (!fs.existsSync(statusFile)) {
            return { status: 'No backups yet' };
        }
        return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    } catch {
        return { status: 'Error reading status' };
    }
}

/**
 * Force a backup immediately
 */
async function forceBackup() {
    console.log('🔄 [BACKUP JOB] Force backup triggered manually');
    await runBackupSafely();
}

// ===== COMMAND LINE INTERFACE =====

const command = process.argv[2];

if (command === 'force') {
    forceBackup().then(() => process.exit(0)).catch(() => process.exit(1));
} else if (command === 'status') {
    console.log('\n📊 [BACKUP JOB] Status:');
    console.log(JSON.stringify(getBackupStatus(), null, 2));
    console.log('');
} else {
    console.log(`
Skyline AA-1 Automatic Backup Job

Commands:
  node backupJob.js force    - Force an immediate backup
  node backupJob.js status   - Show backup status

This job runs automatically every 30 minutes.
`);
}

module.exports = { 
    startBackupJob, 
    forceBackup, 
    getBackupStatus,
    runBackupSafely
};
