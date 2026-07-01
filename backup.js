const { exec } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const dotenv = require('dotenv');

dotenv.config();

// Configuration
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const MONGO_URI = process.env.MONGODB_URI || process.env.BACKUP_MONGO_URI;
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS) || 30;
const ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY || null;

// Ensure backup directory exists
fs.ensureDirSync(BACKUP_DIR);

/**
 * Perform a complete backup
 */
async function performBackup() {
    console.log(`🔄 [BACKUP] Starting backup at ${new Date().toISOString()}`);
    
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFolder = path.join(BACKUP_DIR, `backup-${timestamp}`);
        fs.ensureDirSync(backupFolder);

        // 1. Backup MongoDB
        await backupMongoDB(backupFolder);
        
        // 2. Backup environment variables
        await backupEnvFile(backupFolder);
        
        // 3. Backup static files (if any)
        await backupStaticFiles(backupFolder);
        
        // 4. Create metadata file
        await createMetadata(backupFolder);
        
        // 5. Compress and encrypt
        const backupFile = await compressBackup(backupFolder, timestamp);
        
        // 6. Clean up temporary folder
        fs.removeSync(backupFolder);
        
        // 7. Clean old backups
        await cleanupOldBackups();
        
        console.log(`✅ [BACKUP] Backup completed: ${path.basename(backupFile)}`);
        return backupFile;
        
    } catch (error) {
        console.error('❌ [BACKUP] Backup failed:', error);
        throw error;
    }
}

/**
 * Backup MongoDB using mongodump
 */
async function backupMongoDB(backupFolder) {
    return new Promise((resolve, reject) => {
        console.log('📦 [BACKUP] Backing up MongoDB...');
        
        if (!MONGO_URI) {
            console.warn('⚠️ [BACKUP] No MongoDB URI found, skipping database backup');
            resolve();
            return;
        }
        
        // Extract database name from URI
        const dbName = MONGO_URI.split('/').pop().split('?')[0];
        const mongodumpPath = 'mongodump';
        
        const cmd = `${mongodumpPath} --uri="${MONGO_URI}" --out="${path.join(backupFolder, 'mongodb')}"`;
        
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ [BACKUP] MongoDB backup failed:', stderr);
                reject(error);
                return;
            }
            console.log('✅ [BACKUP] MongoDB backup completed');
            resolve();
        });
    });
}

/**
 * Backup .env file
 */
async function backupEnvFile(backupFolder) {
    console.log('📄 [BACKUP] Backing up environment file...');
    
    const envPath = path.join(process.cwd(), '.env');
    const backupPath = path.join(backupFolder, 'env-backup.txt');
    
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const maskedContent = maskSensitiveValues(envContent);
        fs.writeFileSync(backupPath, maskedContent);
        console.log('✅ [BACKUP] Environment file backed up (sensitive values masked)');
    } else {
        console.log('⚠️ [BACKUP] No .env file found');
    }
}

/**
 * Mask sensitive values in environment file
 */
function maskSensitiveValues(content) {
    const lines = content.split('\n');
    return lines.map(line => {
        const match = line.match(/^([^=]+)=(.+)$/);
        if (match) {
            const key = match[1].trim();
            const value = match[2].trim();
            if (key.includes('SECRET') || key.includes('KEY') || key.includes('PASSWORD') || key.includes('PASS') || key.includes('TOKEN')) {
                return `${key}=***MASKED***`;
            }
            return line;
        }
        return line;
    }).join('\n');
}

/**
 * Backup static files (frontend, uploads)
 */
async function backupStaticFiles(backupFolder) {
    console.log('📁 [BACKUP] Backing up static files...');
    
    const staticDirs = ['public', 'uploads', 'static', 'dist'];
    let count = 0;
    
    for (const dir of staticDirs) {
        const sourcePath = path.join(process.cwd(), dir);
        if (fs.existsSync(sourcePath)) {
            const destPath = path.join(backupFolder, dir);
            fs.copySync(sourcePath, destPath);
            console.log(`✅ [BACKUP] Copied ${dir}`);
            count++;
        }
    }
    
    if (count === 0) {
        console.log('⚠️ [BACKUP] No static directories found to backup');
    }
}

/**
 * Create metadata file
 */
async function createMetadata(backupFolder) {
    const metadata = {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        nodeVersion: process.version,
        platform: process.platform,
        mongodbUri: MONGO_URI ? MONGO_URI.replace(/\/\/[^@]+@/, '//***@***') : 'not set',
        totalBackups: countBackups()
    };
    
    fs.writeFileSync(
        path.join(backupFolder, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
    );
    console.log('📋 [BACKUP] Metadata created');
}

/**
 * Count existing backups
 */
function countBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return 0;
    return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.zip')).length;
}

/**
 * Compress backup folder
 */
async function compressBackup(backupFolder, timestamp) {
    console.log('🗜️ [BACKUP] Compressing backup...');
    
    const backupFile = path.join(BACKUP_DIR, `backup-${timestamp}.zip`);
    
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(backupFile);
        const archive = archiver('zip', { zlib: { level: 9 } });
        
        output.on('close', () => {
            const sizeMB = (archive.pointer() / 1024 / 1024).toFixed(2);
            console.log(`✅ [BACKUP] Compressed to ${sizeMB} MB`);
            resolve(backupFile);
        });
        
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(backupFolder, 'backup');
        archive.finalize();
    });
}

/**
 * Clean up old backups
 */
async function cleanupOldBackups() {
    console.log('🧹 [BACKUP] Cleaning old backups...');
    
    if (!fs.existsSync(BACKUP_DIR)) return;
    
    const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.zip') || f.startsWith('backup-'))
        .map(f => ({
            name: f,
            path: path.join(BACKUP_DIR, f),
            stats: fs.statSync(path.join(BACKUP_DIR, f))
        }))
        .filter(f => f.stats.isFile())
        .sort((a, b) => b.stats.mtime - a.stats.mtime);
    
    const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let deleted = 0;
    
    for (const file of files) {
        // Keep at least 3 most recent regardless of age
        if (files.indexOf(file) < 3) continue;
        
        if (now - file.stats.mtime.getTime() > retentionMs) {
            fs.removeSync(file.path);
            deleted++;
            console.log(`🗑️ [BACKUP] Deleted old backup: ${file.name}`);
        }
    }
    
    // Also check total size
    const totalSize = files.reduce((sum, f) => sum + f.stats.size, 0);
    const maxSizeGB = parseFloat(process.env.BACKUP_MAX_SIZE_GB) || 10;
    const maxSizeBytes = maxSizeGB * 1024 * 1024 * 1024;
    
    if (totalSize > maxSizeBytes) {
        console.log(`⚠️ [BACKUP] Backup directory size (${(totalSize/1024/1024/1024).toFixed(2)}GB) exceeds limit (${maxSizeGB}GB)`);
        let currentSize = totalSize;
        for (let i = files.length - 1; i >= 3; i--) {
            if (currentSize <= maxSizeBytes) break;
            fs.removeSync(files[i].path);
            currentSize -= files[i].stats.size;
            deleted++;
            console.log(`🗑️ [BACKUP] Deleted old backup to free space: ${files[i].name}`);
        }
    }
    
    if (deleted > 0) {
        console.log(`✅ [BACKUP] Cleaned up ${deleted} old backups (retention: ${RETENTION_DAYS} days)`);
    } else {
        console.log('✅ [BACKUP] No old backups to clean');
    }
}

/**
 * Restore from backup
 */
async function restoreBackup(backupFile) {
    console.log(`🔄 [RESTORE] Starting restore from ${backupFile}`);
    
    const fullPath = path.join(BACKUP_DIR, backupFile);
    if (!fs.existsSync(fullPath)) {
        throw new Error(`Backup file not found: ${backupFile}`);
    }
    
    // Extract backup
    const extractDir = path.join(BACKUP_DIR, 'restore-temp');
    fs.ensureDirSync(extractDir);
    
    // Extract zip
    await extractZip(fullPath, extractDir);
    
    // Check metadata
    const metadataPath = path.join(extractDir, 'backup', 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
        throw new Error('Invalid backup: metadata.json not found');
    }
    
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    console.log(`📋 [RESTORE] Restoring from backup: ${metadata.timestamp}`);
    
    // Restore MongoDB
    const mongoBackupDir = path.join(extractDir, 'backup', 'mongodb');
    if (fs.existsSync(mongoBackupDir)) {
        await restoreMongoDB(mongoBackupDir);
    }
    
    // Clean up
    fs.removeSync(extractDir);
    console.log('✅ [RESTORE] Restore completed');
}

/**
 * Restore MongoDB
 */
function restoreMongoDB(backupDir) {
    return new Promise((resolve, reject) => {
        console.log('📦 [RESTORE] Restoring MongoDB...');
        
        if (!MONGO_URI) {
            console.warn('⚠️ [RESTORE] No MongoDB URI found, skipping database restore');
            resolve();
            return;
        }
        
        const cmd = `mongorestore --uri="${MONGO_URI}" "${backupDir}"`;
        
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                console.error('❌ [RESTORE] MongoDB restore failed:', stderr);
                reject(error);
                return;
            }
            console.log('✅ [RESTORE] MongoDB restored');
            resolve();
        });
    });
}

/**
 * Extract zip file
 */
function extractZip(zipFile, destDir) {
    return new Promise((resolve, reject) => {
        const extract = require('extract-zip');
        extract(zipFile, { dir: destDir })
            .then(() => resolve())
            .catch(reject);
    });
}

// ===== COMMAND LINE INTERFACE =====

const command = process.argv[2];

if (command === 'backup') {
    performBackup().then(() => process.exit(0)).catch(() => process.exit(1));
} else if (command === 'restore') {
    const backupFile = process.argv[3];
    if (!backupFile) {
        console.error('❌ Please specify backup file: node backup.js restore backup-2024-01-01.zip');
        process.exit(1);
    }
    restoreBackup(backupFile).then(() => process.exit(0)).catch(() => process.exit(1));
} else if (command === 'list') {
    listBackups();
} else {
    console.log(`
Skyline AA-1 Backup Tool

Commands:
  node backup.js backup          - Create a new backup
  node backup.js list            - List all backups
  node backup.js restore <file>  - Restore from backup

Configuration:
  BACKUP_DIR         - Backup directory (default: ./backups)
  BACKUP_RETENTION_DAYS - Days to keep backups (default: 30)
  BACKUP_MAX_SIZE_GB - Maximum backup size (default: 10GB)
`);
}

function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) {
        console.log('📂 No backups found');
        return;
    }
    
    const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.zip'))
        .map(f => ({
            name: f,
            size: fs.statSync(path.join(BACKUP_DIR, f)).size,
            modified: fs.statSync(path.join(BACKUP_DIR, f)).mtime
        }))
        .sort((a, b) => b.modified - a.modified);
    
    if (files.length === 0) {
        console.log('📂 No backups found');
        return;
    }
    
    console.log('\n📦 Available Backups:\n');
    console.log('  Name'.padEnd(40) + 'Size'.padEnd(15) + 'Date');
    console.log('  ' + '-'.repeat(60));
    
    for (const file of files) {
        const sizeMB = (file.size / 1024 / 1024).toFixed(2);
        const date = file.modified.toLocaleString();
        console.log(`  ${file.name.padEnd(40)}${sizeMB.padEnd(15)}${date}`);
    }
    console.log(`\n  Total: ${files.length} backups\n`);
}

module.exports = { performBackup, restoreBackup, listBackups };
