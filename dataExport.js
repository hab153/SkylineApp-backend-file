/**
 * Data Export Service
 * Handles exporting all user data in JSON or CSV format
 * GDPR Article 20 – Right to Data Portability
 * 
 * @module dataExport
 */

const User = require('./User');
const Lead = require('./Lead');
const ChatMessage = require('./ChatMessage');
const Notification = require('./Notification');
const EmailAccount = require('./EmailAccount');
const Report = require('./Report');
const Session = require('./Session');
const Company = require('./Company');
const SearchCache = require('./SearchCache');
const fs = require('fs-extra');
const path = require('path');
const archiver = require('archiver');
const { Parser } = require('json2csv');
const crypto = require('crypto');

// Export directory — resolved once at startup
const EXPORT_DIR = path.resolve(__dirname, 'exports');

// Ensure export directory exists
fs.ensureDirSync(EXPORT_DIR);

/**
 * ✅ SECURITY: Generate a safe filename from an export ID.
 * Only allows the exact pattern: export_<digits>_<16 hex chars>.<ext>
 * Returns null if the input doesn't match — no fallback, no guessing.
 */
function buildSafeFileName(exportId, extension) {
    if (!exportId || typeof exportId !== 'string') return null;
    if (!extension || typeof extension !== 'string') return null;
    
    // Strict pattern: export_1234567890_abcdef0123456789.json
    const validPattern = /^export_\d+_[a-fA-F0-9]{16}$/;
    if (!validPattern.test(exportId)) return null;
    
    // Extension must be one of the allowed types
    const allowedExtensions = ['json', 'zip', 'csv'];
    const ext = extension.replace(/^\./, '').toLowerCase();
    if (!allowedExtensions.includes(ext)) return null;
    
    return `${exportId}.${ext}`;
}

/**
 * ✅ SECURITY: Resolve a filename safely within EXPORT_DIR.
 * Uses path.resolve and verifies the result starts with EXPORT_DIR.
 * Returns null if anything is wrong — never returns a path outside EXPORT_DIR.
 */
function resolveInExportDir(fileName) {
    if (!fileName || typeof fileName !== 'string') return null;
    
    // Strip any path separators from the filename itself
    const baseName = path.basename(fileName);
    if (!baseName || baseName === '.' || baseName === '..') return null;
    
    // Only allow safe characters
    if (!/^[a-zA-Z0-9._-]+$/.test(baseName)) return null;
    
    const resolved = path.resolve(EXPORT_DIR, baseName);
    
    // Double-check: resolved path MUST start with EXPORT_DIR + separator
    if (!resolved.startsWith(EXPORT_DIR + path.sep) && resolved !== EXPORT_DIR) {
        return null;
    }
    
    return resolved;
}

/**
 * ✅ SECURITY: Build a safe temp directory path within EXPORT_DIR.
 */
function resolveTempDir(exportId) {
    if (!exportId || typeof exportId !== 'string') return null;
    const validPattern = /^export_\d+_[a-fA-F0-9]{16}$/;
    if (!validPattern.test(exportId)) return null;
    
    const dirName = `temp_${exportId}`;
    const resolved = path.resolve(EXPORT_DIR, dirName);
    
    if (!resolved.startsWith(EXPORT_DIR + path.sep)) return null;
    
    return resolved;
}

/**
 * Generate a unique export ID
 * @returns {string} - Unique export ID
 */
function generateExportId() {
    return `export_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Get all user data for export
 * @param {string} userId - The user ID
 * @returns {object} - Complete user data object
 */
async function getUserData(userId) {
    console.log(`📤 [DATA EXPORT] Collecting data for user: ${userId}`);

    const user = await User.findById(String(userId)).select('-password -resetToken -resetTokenExpiry -adminAns_dish -adminAns_pn -adminAns_mum -adminAns_dm -adminAns_dad -adminAns_friend -adminAns_enemy -adminAns_app');
    if (!user) {
        throw new Error('User not found');
    }

    const [leads, chatMessages, notifications, emailAccounts, reports, sessions] = await Promise.all([
        Lead.find({ userId: String(userId) }).lean(),
        ChatMessage.find({ userId: String(userId) }).lean(),
        Notification.find({ userId: String(userId) }).lean(),
        EmailAccount.find({ userId: String(userId) }).lean(),
        Report.find({ userId: String(userId) }).lean(),
        Session.find({ userId: String(userId) }).lean()
    ]);

    const companyIds = leads.map(l => l.companyId).filter(id => id);
    let companies = [];
    if (companyIds.length > 0) {
        companies = await Company.find({ _id: { $in: companyIds } }).lean();
    }

    const searchCaches = await SearchCache.find({ userId: String(userId) }).lean();

    const exportData = {
        exportMetadata: {
            exportedAt: new Date().toISOString(),
            exporterVersion: '1.0.0',
            userId: user._id.toString(),
            username: user.username,
            email: user.email
        },
        profile: {
            fullName: user.fullName || null,
            primaryGoal: user.primaryGoal || null,
            skillLevel: user.skillLevel || null,
            interests: user.interests || null,
            country: user.country || null,
            bio: user.bio || null,
            profilePicture: user.profilePicture || null,
            subscriptionTier: user.subscriptionTier || null,
            subscriptionEndDate: user.subscriptionEndDate || null,
            createdAt: user.createdAt || null,
            updatedAt: user.updatedAt || null
        },
        paymentHistory: user.paymentHistory || [],
        leads: leads.map(lead => ({
            id: lead._id,
            name: lead.name,
            email: lead.email,
            company: lead.company,
            jobTitle: lead.jobTitle,
            linkedinUrl: lead.linkedinUrl,
            status: lead.status,
            sequenceStep: lead.sequenceStep,
            lastContactDate: lead.lastContactDate,
            nextActionDate: lead.nextActionDate,
            sentiment: lead.sentiment,
            confidenceScore: lead.confidenceScore,
            confidenceTier: lead.confidenceTier,
            autoReplyEnabled: lead.autoReplyEnabled,
            autoReplyInstructions: lead.autoReplyInstructions,
            autoFollowUpEnabled: lead.autoFollowUpEnabled,
            followUpScheduledDate: lead.followUpScheduledDate,
            followUpCount: lead.followUpCount,
            replies: lead.replies || [],
            createdAt: lead.createdAt,
            updatedAt: lead.updatedAt
        })),
        chatMessages: chatMessages.map(msg => ({
            sessionId: msg.sessionId,
            role: msg.role,
            content: msg.content,
            title: msg.title,
            feedback: msg.feedback,
            createdAt: msg.createdAt
        })),
        notifications: notifications.map(notif => ({
            type: notif.type,
            content: notif.content,
            leadId: notif.leadId,
            isRead: notif.isRead,
            createdAt: notif.createdAt
        })),
        sessions: sessions.map(session => ({
            sessionId: session.sessionId,
            type: session.type,
            name: session.name,
            pinned: session.pinned,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt
        })),
        emailAccounts: emailAccounts.map(account => ({
            emailAddress: account.emailAddress,
            provider: account.provider,
            isConnected: account.isConnected,
            connectedAt: account.createdAt
        })),
        companies: companies.map(company => ({
            domain: company.domain,
            name: company.name,
            industry: company.industry,
            country: company.country,
            employeeCount: company.employeeCount,
            leadScore: company.leadScore,
            confidenceTier: company.confidenceTier,
            researchSummary: company.researchSummary,
            emails: company.emails || [],
            lastUpdated: company.lastUpdated
        })),
        searchCaches: searchCaches.map(cache => ({
            queryHash: cache.queryHash,
            queryParams: cache.queryParams,
            companyIds: cache.companyIds,
            expiresAt: cache.expiresAt,
            createdAt: cache.createdAt
        }))
    };

    console.log(`✅ [DATA EXPORT] Collected data: ${leads.length} leads, ${chatMessages.length} messages, ${notifications.length} notifications`);

    return exportData;
}

/**
 * Export user data as JSON
 * @param {string} userId - The user ID
 * @returns {object} - { exportId, filePath, fileName, fileSize }
 */
async function exportAsJSON(userId) {
    const exportId = generateExportId();
    const exportData = await getUserData(userId);

    // ✅ FIX #4: Build safe filename using strict pattern matching — no user input involved
    const fileName = buildSafeFileName(exportId, 'json');
    if (!fileName) {
        throw new Error('Invalid file path generated');
    }
    
    const filePath = resolveInExportDir(fileName);
    if (!filePath) {
        throw new Error('Invalid file path resolved');
    }
    
    await fs.writeJson(filePath, exportData, { spaces: 2 });

    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    return {
        exportId,
        filePath,
        fileName,
        fileSize,
        format: 'json'
    };
}

/**
 * Export user data as CSV (multiple files in a zip)
 * @param {string} userId - The user ID
 * @returns {object} - { exportId, filePath, fileName, fileSize }
 */
async function exportAsCSV(userId) {
    const exportId = generateExportId();
    const exportData = await getUserData(userId);

    // ✅ FIX #5: Use resolveTempDir which validates exportId pattern and resolves safely
    const tempDir = resolveTempDir(exportId);
    if (!tempDir) {
        throw new Error('Invalid temp directory path generated');
    }
    
    await fs.ensureDir(tempDir);

    try {
        const csvConfigs = [
            {
                name: 'profile',
                data: [exportData.profile],
                fields: ['fullName', 'primaryGoal', 'skillLevel', 'interests', 'country', 'bio', 'subscriptionTier', 'createdAt']
            },
            {
                name: 'leads',
                data: exportData.leads,
                fields: ['id', 'name', 'email', 'company', 'jobTitle', 'status', 'confidenceScore', 'confidenceTier', 'createdAt']
            },
            {
                name: 'chat_messages',
                data: exportData.chatMessages,
                fields: ['sessionId', 'role', 'content', 'title', 'feedback', 'createdAt']
            },
            {
                name: 'notifications',
                data: exportData.notifications,
                fields: ['type', 'content', 'isRead', 'createdAt']
            },
            {
                name: 'sessions',
                data: exportData.sessions,
                fields: ['sessionId', 'type', 'name', 'pinned', 'createdAt']
            },
            {
                name: 'payment_history',
                data: exportData.paymentHistory,
                fields: ['txRef', 'amount', 'currency', 'status', 'paidAt']
            },
            {
                name: 'email_accounts',
                data: exportData.emailAccounts,
                fields: ['emailAddress', 'provider', 'isConnected', 'connectedAt']
            },
            {
                name: 'companies',
                data: exportData.companies,
                fields: ['domain', 'name', 'industry', 'country', 'employeeCount', 'leadScore', 'confidenceTier', 'lastUpdated']
            }
        ];

        // Write each CSV file — use only hardcoded safe names, no user input
        for (const config of csvConfigs) {
            // ✅ Config names are hardcoded constants — safe to use directly
            const safeName = config.name.replace(/[^a-zA-Z0-9_-]/g, '');
            const csvFileName = `${safeName}.csv`;
            const csvPath = path.resolve(tempDir, csvFileName);
            
            // Verify csvPath is inside tempDir
            if (!csvPath.startsWith(tempDir + path.sep)) continue;
            
            if (config.data && config.data.length > 0) {
                try {
                    const parser = new Parser({ fields: config.fields });
                    const csv = parser.parse(config.data);
                    await fs.writeFile(csvPath, csv);
                } catch (err) {
                    console.warn(`⚠️ [CSV Export] Could not export ${config.name}:`, err.message);
                }
            } else {
                await fs.writeFile(csvPath, config.fields.join(',') + '\n');
            }
        }

        // Add metadata file — hardcoded name
        const metadataPath = path.resolve(tempDir, 'metadata.json');
        if (metadataPath.startsWith(tempDir + path.sep)) {
            await fs.writeJson(metadataPath, {
                exportedAt: new Date().toISOString(),
                exporterVersion: '1.0.0',
                userId: exportData.exportMetadata.userId,
                username: exportData.exportMetadata.username,
                email: exportData.exportMetadata.email,
                totalLeads: exportData.leads.length,
                totalMessages: exportData.chatMessages.length,
                totalNotifications: exportData.notifications.length,
                format: 'csv'
            }, { spaces: 2 });
        }

        // ✅ FIX #6: Build safe zip filename using strict pattern — no user input
        const zipFileName = buildSafeFileName(exportId, 'zip');
        if (!zipFileName) {
            throw new Error('Invalid zip file path generated');
        }
        
        const zipPath = resolveInExportDir(zipFileName);
        if (!zipPath) {
            throw new Error('Invalid zip file path resolved');
        }
        
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        return new Promise((resolve, reject) => {
            output.on('close', async () => {
                const stats = await fs.stat(zipPath);
                await fs.remove(tempDir);
                resolve({
                    exportId,
                    filePath: zipPath,
                    fileName: zipFileName,
                    fileSize: stats.size,
                    format: 'csv'
                });
            });

            output.on('error', reject);
            archive.on('error', reject);

            archive.pipe(output);
            archive.directory(tempDir, false);
            archive.finalize();
        });

    } catch (error) {
        await fs.remove(tempDir).catch(() => {});
        throw error;
    }
}

/**
 * Create a data export for a user
 */
async function createExport(userId, format = 'json', ip = null, userAgent = null) {
    const user = await User.findById(String(userId));
    if (!user) {
        throw new Error('User not found');
    }

    const recentExports = user.dataExports || [];
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = recentExports.filter(e => new Date(e.createdAt) > oneHourAgo);
    if (recent.length >= 3) {
        throw new Error('Rate limit exceeded. Please wait 1 hour before requesting another export.');
    }

    console.log(`📤 [DATA EXPORT] Starting export for user ID: ${userId} (${format})`);

    let result;
    if (format === 'csv') {
        result = await exportAsCSV(userId);
    } else {
        result = await exportAsJSON(userId);
    }

    const exportRecord = {
        exportId: result.exportId,
        format: result.format,
        status: 'completed',
        fileName: result.fileName,
        fileSize: result.fileSize,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        ip: ip || 'unknown',
        userAgent: userAgent || 'unknown'
    };

    if (!user.dataExports) {
        user.dataExports = [];
    }

    if (user.dataExports.length >= 20) {
        const oldExports = user.dataExports.slice(0, user.dataExports.length - 19);
        for (const old of oldExports) {
            try {
                const oldFileName = buildSafeFileName(old.exportId, old.format === 'csv' ? 'zip' : 'json');
                if (oldFileName) {
                    const oldPath = resolveInExportDir(oldFileName);
                    if (oldPath && await fs.pathExists(oldPath)) {
                        await fs.remove(oldPath);
                    }
                }
            } catch (err) {
                console.warn(`⚠️ [DATA EXPORT] Could not delete old file:`, err.message);
            }
        }
        user.dataExports = user.dataExports.slice(-19);
    }

    user.dataExports.push(exportRecord);
    await user.save();

    console.log(`✅ [DATA EXPORT] Export completed: ${result.fileName} (${(result.fileSize / 1024).toFixed(2)} KB)`);

    return {
        exportId: result.exportId,
        fileName: result.fileName,
        fileSize: result.fileSize,
        format: result.format,
        status: 'completed',
        createdAt: exportRecord.createdAt,
        expiresAt: exportRecord.expiresAt,
        downloadUrl: `/api/data/export/${result.exportId}`
    };
}

/**
 * Get export by ID
 */
async function getExport(userId, exportId) {
    if (!exportId || typeof exportId !== 'string') {
        throw new Error('Invalid export ID');
    }
    if (!/^export_\d+_[a-fA-F0-9]{16}$/.test(exportId)) {
        throw new Error('Invalid export ID format');
    }
    
    const user = await User.findById(String(userId));
    if (!user) {
        throw new Error('User not found');
    }

    const exportRecord = user.dataExports.find(e => e.exportId === exportId);
    if (!exportRecord) {
        throw new Error('Export not found');
    }

    const ext = exportRecord.format === 'csv' ? 'zip' : 'json';
    const fileName = buildSafeFileName(exportId, ext);
    const filePath = fileName ? resolveInExportDir(fileName) : null;
    const fileExists = filePath ? await fs.pathExists(filePath) : false;

    return {
        ...exportRecord.toObject ? exportRecord.toObject() : exportRecord,
        fileExists,
        downloadUrl: fileExists ? `/api/data/export/${exportId}` : null
    };
}

/**
 * List all exports for a user
 */
async function listExports(userId) {
    const user = await User.findById(String(userId));
    if (!user) {
        throw new Error('User not found');
    }

    const exports = user.dataExports || [];
    
    const results = [];
    for (const exp of exports) {
        const ext = exp.format === 'csv' ? 'zip' : 'json';
        const fileName = buildSafeFileName(exp.exportId, ext);
        const filePath = fileName ? resolveInExportDir(fileName) : null;
        const fileExists = filePath ? await fs.pathExists(filePath) : false;
        results.push({
            ...exp.toObject ? exp.toObject() : exp,
            fileExists,
            downloadUrl: fileExists ? `/api/data/export/${exp.exportId}` : null
        });
    }

    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return results;
}

/**
 * Delete an export
 */
async function deleteExport(userId, exportId) {
    if (!exportId || typeof exportId !== 'string') {
        throw new Error('Invalid export ID');
    }
    if (!/^export_\d+_[a-fA-F0-9]{16}$/.test(exportId)) {
        throw new Error('Invalid export ID format');
    }
    
    const user = await User.findById(String(userId));
    if (!user) {
        throw new Error('User not found');
    }

    const index = user.dataExports.findIndex(e => e.exportId === exportId);
    if (index === -1) {
        throw new Error('Export not found');
    }

    const exportRecord = user.dataExports[index];
    const ext = exportRecord.format === 'csv' ? 'zip' : 'json';
    const fileName = buildSafeFileName(exportId, ext);
    const filePath = fileName ? resolveInExportDir(fileName) : null;
    
    if (filePath && await fs.pathExists(filePath)) {
        await fs.remove(filePath);
    }

    user.dataExports.splice(index, 1);
    await user.save();

    return true;
}

/**
 * Clean up expired exports (run by cron job)
 */
async function cleanupExpiredExports() {
    console.log('🧹 [DATA EXPORT] Cleaning up expired exports...');
    const now = new Date();
    const users = await User.find({ 'dataExports.0': { $exists: true } });

    let totalDeleted = 0;
    for (const user of users) {
        const toDelete = [];
        const toKeep = [];

        for (const exp of user.dataExports) {
            if (new Date(exp.expiresAt) < now) {
                const ext = exp.format === 'csv' ? 'zip' : 'json';
                const fileName = buildSafeFileName(exp.exportId, ext);
                const filePath = fileName ? resolveInExportDir(fileName) : null;
                if (filePath && await fs.pathExists(filePath)) {
                    await fs.remove(filePath);
                }
                toDelete.push(exp.exportId);
                totalDeleted++;
            } else {
                toKeep.push(exp);
            }
        }

        if (toDelete.length > 0) {
            user.dataExports = toKeep;
            await user.save();
        }
    }

    console.log(`✅ [DATA EXPORT] Cleaned up ${totalDeleted} expired exports`);
    return totalDeleted;
}

module.exports = {
    createExport,
    getExport,
    listExports,
    deleteExport,
    cleanupExpiredExports,
    generateExportId,
    EXPORT_DIR
};
