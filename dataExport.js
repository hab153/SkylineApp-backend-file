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

// Export directory
const EXPORT_DIR = path.join(__dirname, 'exports');

// Ensure export directory exists
fs.ensureDirSync(EXPORT_DIR);

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

    // Get user profile (exclude sensitive fields)
    const user = await User.findById(userId).select('-password -resetToken -resetTokenExpiry -adminAns_dish -adminAns_pn -adminAns_mum -adminAns_dm -adminAns_dad -adminAns_friend -adminAns_enemy -adminAns_app');
    if (!user) {
        throw new Error('User not found');
    }

    // Get all associated data in parallel
    const [leads, chatMessages, notifications, emailAccounts, reports, sessions] = await Promise.all([
        Lead.find({ userId }).lean(),
        ChatMessage.find({ userId }).lean(),
        Notification.find({ userId }).lean(),
        EmailAccount.find({ userId }).lean(),
        Report.find({ userId }).lean(),
        Session.find({ userId }).lean()
    ]);

    // Get company data for leads
    const companyIds = leads.map(l => l.companyId).filter(id => id);
    let companies = [];
    if (companyIds.length > 0) {
        companies = await Company.find({ _id: { $in: companyIds } }).lean();
    }

    // Get search caches
    const searchCaches = await SearchCache.find({ userId }).lean();

    // Format user data for export
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

    const filePath = path.join(EXPORT_DIR, `${exportId}.json`);
    await fs.writeJson(filePath, exportData, { spaces: 2 });

    const stats = await fs.stat(filePath);
    const fileSize = stats.size;

    return {
        exportId,
        filePath,
        fileName: `${exportId}.json`,
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

    const tempDir = path.join(EXPORT_DIR, `temp_${exportId}`);
    await fs.ensureDir(tempDir);

    try {
        // Define CSV fields for each data type
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

        // Write each CSV file
        for (const config of csvConfigs) {
            if (config.data && config.data.length > 0) {
                try {
                    const parser = new Parser({ fields: config.fields });
                    const csv = parser.parse(config.data);
                    const csvPath = path.join(tempDir, `${config.name}.csv`);
                    await fs.writeFile(csvPath, csv);
                } catch (err) {
                    console.warn(`⚠️ [CSV Export] Could not export ${config.name}:`, err.message);
                }
            } else {
                // Create empty file with headers
                const emptyPath = path.join(tempDir, `${config.name}.csv`);
                await fs.writeFile(emptyPath, config.fields.join(',') + '\n');
            }
        }

        // Add metadata file
        const metadataPath = path.join(tempDir, 'metadata.json');
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

        // Create zip file
        const zipPath = path.join(EXPORT_DIR, `${exportId}.zip`);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        return new Promise((resolve, reject) => {
            output.on('close', async () => {
                const stats = await fs.stat(zipPath);
                // Clean up temp directory
                await fs.remove(tempDir);
                resolve({
                    exportId,
                    filePath: zipPath,
                    fileName: `${exportId}.zip`,
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
        // Clean up temp directory on error
        await fs.remove(tempDir).catch(() => {});
        throw error;
    }
}

/**
 * Create a data export for a user
 * @param {string} userId - The user ID
 * @param {string} format - 'json' or 'csv'
 * @param {string} ip - User's IP for logging
 * @param {string} userAgent - User's browser for logging
 * @returns {object} - Export result
 */
async function createExport(userId, format = 'json', ip = null, userAgent = null) {
    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    // Rate limit: check if user has requested export within the last hour
    const recentExports = user.dataExports || [];
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = recentExports.filter(e => new Date(e.createdAt) > oneHourAgo);
    if (recent.length >= 3) {
        throw new Error('Rate limit exceeded. Please wait 1 hour before requesting another export.');
    }

    console.log(`📤 [DATA EXPORT] Starting export for user: ${user.email} (${format})`);

    let result;
    if (format === 'csv') {
        result = await exportAsCSV(userId);
    } else {
        result = await exportAsJSON(userId);
    }

    // Save export record to user
    const exportRecord = {
        exportId: result.exportId,
        format: result.format,
        status: 'completed',
        fileName: result.fileName,
        fileSize: result.fileSize,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        ip: ip || 'unknown',
        userAgent: userAgent || 'unknown'
    };

    // Initialize dataExports if not exists
    if (!user.dataExports) {
        user.dataExports = [];
    }

    // Keep only last 20 exports
    if (user.dataExports.length >= 20) {
        // Delete old files
        const oldExports = user.dataExports.slice(0, user.dataExports.length - 19);
        for (const old of oldExports) {
            try {
                const oldPath = path.join(EXPORT_DIR, old.fileName || `${old.exportId}.json`);
                if (await fs.pathExists(oldPath)) {
                    await fs.remove(oldPath);
                    console.log(`🗑️ [DATA EXPORT] Deleted old export: ${old.fileName}`);
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
 * @param {string} userId - The user ID
 * @param {string} exportId - The export ID
 * @returns {object} - Export record
 */
async function getExport(userId, exportId) {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    const exportRecord = user.dataExports.find(e => e.exportId === exportId);
    if (!exportRecord) {
        throw new Error('Export not found');
    }

    // Check if file exists
    const filePath = path.join(EXPORT_DIR, exportRecord.fileName || `${exportId}.json`);
    const fileExists = await fs.pathExists(filePath);

    return {
        ...exportRecord.toObject ? exportRecord.toObject() : exportRecord,
        fileExists,
        downloadUrl: fileExists ? `/api/data/export/${exportId}` : null
    };
}

/**
 * List all exports for a user
 * @param {string} userId - The user ID
 * @returns {array} - List of export records
 */
async function listExports(userId) {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    const exports = user.dataExports || [];
    
    // Check which files still exist
    const results = [];
    for (const exp of exports) {
        const filePath = path.join(EXPORT_DIR, exp.fileName || `${exp.exportId}.json`);
        const fileExists = await fs.pathExists(filePath);
        results.push({
            ...exp.toObject ? exp.toObject() : exp,
            fileExists,
            downloadUrl: fileExists ? `/api/data/export/${exp.exportId}` : null
        });
    }

    // Sort by createdAt descending
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return results;
}

/**
 * Delete an export
 * @param {string} userId - The user ID
 * @param {string} exportId - The export ID
 * @returns {boolean} - Success
 */
async function deleteExport(userId, exportId) {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    const index = user.dataExports.findIndex(e => e.exportId === exportId);
    if (index === -1) {
        throw new Error('Export not found');
    }

    const exportRecord = user.dataExports[index];
    
    // Delete file
    const filePath = path.join(EXPORT_DIR, exportRecord.fileName || `${exportId}.json`);
    if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
    }

    // Remove from record
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
                // Delete file
                const filePath = path.join(EXPORT_DIR, exp.fileName || `${exp.exportId}.json`);
                if (await fs.pathExists(filePath)) {
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
