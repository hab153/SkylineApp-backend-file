const cron = require('node-cron');
const { performBackup } = require('./backup');
const fs = require('fs-extra');
const path = require('path');

// Configuration
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const BACKUP_SCHEDULE = process.env.BACKUP_SCHEDULE || '*/30 * * * *';
const MAX_BACKUPS = 50;

// Track if backup is currently running
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
    }, 5000);

    // Schedule recurring backups
    cron.schedule(BACKUP_SCHEDULE, async () => {
        console.log(`⏰ [BACKUP JOB] Scheduled backup triggered at ${new Date().toISOString()}`);
        await runBackupSafely();
    });
}

/**
 * Run backup safely (prevent overlaps)
 */
async function runBackupSafely() {
    if (isBackupRunning) {
        console.log('⚠️ [BACKUP JOB] Backup already running, skipping this cycle');
        return;
    }

    try {
        isBackupRunning = true;
        const startTime = Date.now();
        
        console.log(`📦 [BACKUP JOB] Starting backup at ${new Date().toISOString()}`);
        const result = await performBackup();
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ [BACKUP JOB] Backup completed in ${duration}s`);
        
        lastBackupTime = new Date();
        backupCount++;
        
        await updateBackupStatus({
            lastBackup: lastBackupTime.toISOString(),
            backupCount: backupCount,
            duration: duration,
            file: result
        });
        
    } catch (error) {
        console.error('❌ [BACKUP JOB] Backup failed:', error.message);
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
            // File corrupted, start fresh
        }
        
        const status = {
            ...existing,
            ...data,
            lastChecked: new Date().toISOString()
        };
        
        fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
    } catch (error) {
        // Don't fail if status update fails
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
}

module.exports = { 
    startBackupJob, 
    forceBackup, 
    getBackupStatus,
    runBackupSafely
};
