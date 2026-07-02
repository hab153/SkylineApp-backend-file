/**
 * Account Deletion Service
 * Handles complete user account deletion with cascading cleanup
 * GDPR Article 17 – Right to Be Forgotten
 * 
 * @module deleteAccount
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
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const fs = require('fs-extra');
const path = require('path');

/**
 * Log deletion for audit purposes
 * @param {string} userId - The deleted user's ID
 * @param {string} email - The deleted user's email
 * @param {string} username - The deleted user's username
 * @param {string} reason - Reason for deletion (optional)
 * @param {string} ip - IP address of request
 */
async function logDeletion(userId, email, username, reason = 'User requested permanent deletion', ip = null) {
    const logEntry = {
        userId,
        email,
        username,
        reason,
        deletedAt: new Date().toISOString(),
        ip: ip || 'unknown'
    };
    
    // Log to console for visibility
    console.log('🗑️ [ACCOUNT DELETION]', JSON.stringify(logEntry, null, 2));
    
    // Also write to a log file
    try {
        const logDir = path.join(__dirname, 'logs');
        await fs.ensureDir(logDir);
        const logFile = path.join(logDir, 'deletions.log');
        const logLine = JSON.stringify(logEntry) + '\n';
        await fs.appendFile(logFile, logLine);
    } catch (err) {
        console.error('❌ Failed to write deletion log:', err.message);
    }
}

/**
 * Permanently delete user account and ALL associated data
 * This is the nuclear option – cannot be undone
 * 
 * @param {string} userId - The user ID to delete
 * @param {string} password - User's password for verification
 * @param {object} req - Express request object (for IP logging)
 * @returns {object} - Result object
 */
async function deleteAccount(userId, password, req = null) {
    // Start a MongoDB transaction for atomicity
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        // 1. Verify user exists
        const user = await User.findById(userId).session(session);
        if (!user) {
            throw new Error('User not found');
        }

        // 2. Verify password
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            throw new Error('Invalid password');
        }

        const userEmail = user.email;
        const userUsername = user.username;
        const userIdStr = userId.toString();

        // Get IP for logging
        const ip = req ? (req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown') : 'unknown';

        // 3. Log deletion BEFORE deleting (for audit)
        await logDeletion(userIdStr, userEmail, userUsername, 'User requested permanent deletion', ip);

        // 4. Delete ALL associated data (cascading)
        console.log(`🗑️ [ACCOUNT DELETION] Deleting all data for user: ${userEmail} (${userUsername})`);

        // Delete Leads
        const leadResult = await Lead.deleteMany({ userId: userId }).session(session);
        console.log(`   ✅ Deleted ${leadResult.deletedCount} leads`);

        // Delete Chat Messages
        const chatResult = await ChatMessage.deleteMany({ userId: userId }).session(session);
        console.log(`   ✅ Deleted ${chatResult.deletedCount} chat messages`);

        // Delete Notifications
        const notifResult = await Notification.deleteMany({ userId: userId }).session(session);
        console.log(`   ✅ Deleted ${notifResult.deletedCount} notifications`);

        // Delete Email Accounts (Nylas tokens)
        const emailResult = await EmailAccount.deleteMany({ userId: userId }).session(session);
        console.log(`   ✅ Deleted ${emailResult.deletedCount} email accounts`);

        // Delete Reports
        const reportResult = await Report.deleteMany({ userId: userId }).session(session);
        console.log(`   ✅ Deleted ${reportResult.deletedCount} reports`);

        // Delete Sessions
        const sessionResult = await Session.deleteMany({ userId: userId }).session(session);
        console.log(`   ✅ Deleted ${sessionResult.deletedCount} sessions`);

        // 5. Clean up orphaned companies (if no other users reference them)
        const leadsWithCompany = await Lead.find({ userId: userId, companyId: { $ne: null } })
            .select('companyId')
            .session(session);
        
        if (leadsWithCompany && leadsWithCompany.length > 0) {
            const companyIds = [...new Set(leadsWithCompany.map(l => l.companyId.toString()))];
            const orphanCompanies = [];
            
            for (const companyId of companyIds) {
                const otherUsers = await Lead.countDocuments({
                    companyId: companyId,
                    userId: { $ne: userId }
                }).session(session);
                if (otherUsers === 0) {
                    orphanCompanies.push(companyId);
                }
            }
            
            if (orphanCompanies.length > 0) {
                const companyResult = await Company.deleteMany({
                    _id: { $in: orphanCompanies }
                }).session(session);
                console.log(`   ✅ Deleted ${companyResult.deletedCount} orphan companies`);
            }
        }

        // 6. Clean up search caches
        const cacheResult = await SearchCache.deleteMany({ userId: userId }).session(session);
        console.log(`   ✅ Deleted ${cacheResult.deletedCount} search caches`);

        // 7. Finally, delete the user itself
        await User.deleteOne({ _id: userId }).session(session);
        console.log(`   ✅ Deleted user account: ${userEmail}`);

        // 8. Commit the transaction
        await session.commitTransaction();
        session.endSession();

        return {
            success: true,
            message: 'Account permanently deleted. All data has been removed.'
        };

    } catch (error) {
        // Rollback transaction on error
        await session.abortTransaction();
        session.endSession();
        console.error('❌ [ACCOUNT DELETION] Error:', error);
        throw error;
    }
}

/**
 * Soft deactivate account (recovery possible within 30 days)
 * @param {string} userId - The user ID to deactivate
 * @param {string} reason - Reason for deactivation
 * @param {object} req - Express request object (for IP logging)
 * @returns {object} - Result object
 */
async function deactivateAccount(userId, reason = 'User requested deactivation', req = null) {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    // Get IP for logging
    const ip = req ? (req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown') : 'unknown';

    // Log deactivation
    await logDeletion(
        user._id.toString(),
        user.email,
        user.username,
        `Soft deactivation - ${reason}`,
        ip
    );

    // Mark as deleted but keep data for recovery period (30 days)
    user.isSuspended = true;
    user.suspensionEnds = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    user.deletedAt = new Date();
    user.deletionReason = reason;
    
    // Anonymize personal data
    user.email = `deleted_${user._id}@deleted.user`;
    user.username = `deleted_${user._id}`;
    user.fullName = 'Deleted User';
    user.profilePicture = null;
    user.bio = '';
    user.primaryGoal = '';
    user.interests = '';
    user.country = '';
    user.dateOfBirth = null;
    user.nylasIntegration = {
        accessToken: null,
        emailAddress: null,
        isConnected: false
    };
    await user.save();

    return {
        success: true,
        message: 'Account deactivated. Data retained for 30 days for recovery.',
        recoveryDeadline: user.suspensionEnds
    };
}

/**
 * Restore a deactivated account (within recovery window)
 * @param {string} userId - The user ID to restore
 * @param {string} reason - Reason for restoration
 * @returns {object} - Result object
 */
async function restoreAccount(userId, reason = 'User requested restoration') {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    if (!user.isSuspended || !user.deletedAt) {
        throw new Error('Account is not deactivated');
    }

    // Check if recovery window has passed
    if (user.suspensionEnds && new Date() > user.suspensionEnds) {
        throw new Error('Recovery window has expired. Account cannot be restored.');
    }

    // Restore account
    user.isSuspended = false;
    user.suspensionEnds = null;
    user.deletedAt = null;
    user.deletionReason = null;
    await user.save();

    console.log(`🔄 [ACCOUNT RESTORATION] Restored account: ${user.email}`);

    return {
        success: true,
        message: 'Account restored successfully.'
    };
}

/**
 * Get deletion status for a user
 * @param {string} userId - The user ID
 * @returns {object} - Status object
 */
async function getDeletionStatus(userId) {
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    return {
        isSuspended: user.isSuspended || false,
        deletedAt: user.deletedAt || null,
        deletionReason: user.deletionReason || null,
        suspensionEnds: user.suspensionEnds || null,
        isRecoverable: user.isSuspended && user.suspensionEnds && new Date() < user.suspensionEnds
    };
}

module.exports = {
    deleteAccount,
    deactivateAccount,
    restoreAccount,
    getDeletionStatus,
    logDeletion
};
