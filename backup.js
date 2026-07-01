const mongoose = require('mongoose');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const dotenv = require('dotenv');

dotenv.config();

// Configuration
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS) || 30;
const MAX_BACKUPS = 50;

// Ensure backup directory exists
fs.ensureDirSync(BACKUP_DIR);

/**
 * Perform a complete backup using Mongoose (No mongodump needed)
 */
async function performBackup() {
    console.log(`🔄 [BACKUP] Starting backup at ${new Date().toISOString()}`);
    
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFolder = path.join(BACKUP_DIR, `backup-${timestamp}`);
        fs.ensureDirSync(backupFolder);

        // 1. Backup MongoDB using Mongoose
        await backupMongoDBWithMongoose(backupFolder);
        
        // 2. Backup environment variables
        await backupEnvFile(backupFolder);
        
        // 3. Create metadata file
        await createMetadata(backupFolder);
        
        // 4. Compress
        const backupFile = await compressBackup(backupFolder, timestamp);
        
        // 5. Clean up temporary folder
        fs.removeSync(backupFolder);
        
        // 6. Clean old backups
        await cleanupOldBackups();
        
        console.log(`✅ [BACKUP] Backup completed: ${path.basename(backupFile)}`);
        return backupFile;
        
    } catch (error) {
        console.error('❌ [BACKUP] Backup failed:', error);
        throw error;
    }
}

/**
 * Backup MongoDB using Mongoose (No mongodump needed)
 */
async function backupMongoDBWithMongoose(backupFolder) {
    console.log('📦 [BACKUP] Backing up MongoDB using Mongoose...');
    
    try {
        const conn = mongoose.connection;
        
        // Get all collection names
        const collections = await conn.db.listCollections().toArray();
        
        const dataDir = path.join(backupFolder, 'mongodb-data');
        fs.ensureDirSync(dataDir);
        
        let totalDocs = 0;
        let collectionCount = 0;
        
        for (const collection of collections) {
            const name = collection.name;
            // Skip system collections
            if (name.startsWith('system.')) continue;
            
            console.log(`  📄 Backing up collection: ${name}`);
            
            try {
                const docs = await conn.db.collection(name).find({}).toArray();
                const filePath = path.join(dataDir, `${name}.json`);
                fs.writeFileSync(filePath, JSON.stringify(docs, null, 2));
                console.log(`  ✅ ${name}: ${docs.length} documents`);
                totalDocs += docs.length;
                collectionCount++;
            } catch (err) {
                console.log(`  ⚠️ Could not backup ${name}: ${err.message}`);
            }
        }
        
        // Save collection list for restore reference
        const collectionList = {
            collections: collections.map(c => c.name).filter(name => !name.startsWith('system.')),
            totalCollections: collectionCount,
            totalDocuments: totalDocs,
            timestamp: new Date().toISOString()
        };
        
        fs.writeFileSync(
            path.join(dataDir, '_collection_list.json'),
            JSON.stringify(collectionList, null, 2)
        );
        
        console.log(`✅ [BACKUP] MongoDB backup completed (${totalDocs} documents in ${collectionCount} collections)`);
        
    } catch (error) {
        console.error('❌ [BACKUP] MongoDB backup failed:', error);
        throw error;
    }
}

/**
 * Backup .env file (sensitive values masked)
 */
async function backupEnvFile(backupFolder) {
    console.log('📄 [BACKUP] Backing up environment file...');
    
    const envPath = path.join(process.cwd(), '.env');
    const backupPath = path.join(backupFolder, 'env-backup.txt');
    
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const maskedContent = maskSensitiveValues(envContent);
        fs.writeFileSync(backupPath, maskedContent);
        console.log('✅ [BACKUP] Environment file backed up');
    } else {
        console.log('⚠️ [BACKUP] No .env file found');
    }
}

function maskSensitiveValues(content) {
    const lines = content.split('\n');
    return lines.map(line => {
        const match = line.match(/^([^=]+)=(.+)$/);
        if (match) {
            const key = match[1].trim();
            if (key.includes('SECRET') || key.includes('KEY') || key.includes('PASSWORD') || key.includes('PASS') || key.includes('TOKEN')) {
                return `${key}=***MASKED***`;
            }
            return line;
        }
        return line;
    }).join('\n');
}

/**
 * Create metadata file
 */
async function createMetadata(backupFolder) {
    const metadata = {
        timestamp: new Date().toISOString(),
        version: require('./package.json').version || '1.0.0',
        nodeVersion: process.version,
        platform: process.platform,
        totalBackups: countBackups()
    };
    fs.writeFileSync(
        path.join(backupFolder, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
    );
    console.log('📋 [BACKUP] Metadata created');
}

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
        .filter(f => f.endsWith('.zip'))
        .map(f => ({
            name: f,
            path: path.join(BACKUP_DIR, f),
            mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
    
    const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let deleted = 0;
    
    for (const file of files) {
        // Keep at least 5 most recent regardless of age
        if (files.indexOf(file) < 5) continue;
        
        if (now - file.mtime.getTime() > retentionMs) {
            fs.removeSync(file.path);
            deleted++;
            console.log(`🗑️ [BACKUP] Deleted old backup: ${file.name}`);
        }
    }
    
    // Also enforce max number of backups
    if (files.length > MAX_BACKUPS) {
        const toDelete = files.slice(MAX_BACKUPS);
        for (const file of toDelete) {
            fs.removeSync(file.path);
            deleted++;
            console.log(`🗑️ [BACKUP] Deleted excess backup: ${file.name}`);
        }
    }
    
    if (deleted > 0) {
        console.log(`✅ [BACKUP] Cleaned up ${deleted} old backups`);
    } else {
        console.log('✅ [BACKUP] No old backups to clean');
    }
}

/**
 * Restore from backup (JSON-based restore)
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
    
    // Restore MongoDB from JSON files
    const dataDir = path.join(extractDir, 'backup', 'mongodb-data');
    if (fs.existsSync(dataDir)) {
        await restoreMongoDBFromJSON(dataDir);
    }
    
    // Clean up
    fs.removeSync(extractDir);
    console.log('✅ [RESTORE] Restore completed');
}

/**
 * Restore MongoDB from JSON files
 */
async function restoreMongoDBFromJSON(dataDir) {
    console.log('📦 [RESTORE] Restoring MongoDB from JSON files...');
    
    try {
        const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== '_collection_list.json');
        const conn = mongoose.connection;
        
        for (const file of files) {
            const collectionName = file.replace('.json', '');
            console.log(`  📄 Restoring collection: ${collectionName}`);
            
            const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
            
            if (data.length === 0) {
                console.log(`  ⚠️ ${collectionName}: no documents to restore`);
                continue;
            }
            
            // Drop existing collection (optional - use with caution)
            // await conn.db.collection(collectionName).drop().catch(() => {});
            
            // Insert documents
            const result = await conn.db.collection(collectionName).insertMany(data);
            console.log(`  ✅ ${collectionName}: ${result.insertedCount} documents restored`);
        }
        
        console.log('✅ [RESTORE] MongoDB restore completed');
        
    } catch (error) {
        console.error('❌ [RESTORE] MongoDB restore failed:', error);
        throw error;
    }
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

/**
 * List all backups
 */
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
    console.log('  Name'.padEnd(45) + 'Size'.padEnd(15) + 'Date');
    console.log('  ' + '-'.repeat(65));
    
    for (const file of files) {
        const sizeMB = (file.size / 1024 / 1024).toFixed(2);
        const date = file.modified.toLocaleString();
        console.log(`  ${file.name.padEnd(45)}${sizeMB.padEnd(15)}${date}`);
    }
    console.log(`\n  Total: ${files.length} backups\n`);
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
Skyline AA-1 Backup Tool (No mongodump required)

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

module.exports = { performBackup, restoreBackup, listBackups };
