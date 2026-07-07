const axios = require('axios');
const User = require('./User');
const Lead = require('./Lead');
const Notification = require('./Notification');
const { getNylasClient, isNylasConnected } = require('./nylasService');

// Configuration
const API_URI = process.env.NYLAS_API_URI || 'https://api.us.nylas.com/v3';

/**
 * Get Nylas API headers with user's access token
 */
function getHeaders(accessToken) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };
}

/**
 * Sync emails for a user from Nylas
 * @param {string} userId - User ID
 * @param {number} limit - Number of messages to sync (default: 50)
 */
async function syncNylasEmails(userId, limit = 50) {
    try {
        console.log(`📧 [NYLAS SYNC] Syncing emails for user ${userId}`);

        const isConnected = await isNylasConnected(userId);
        if (!isConnected) {
            console.log(`⚠️ [NYLAS SYNC] User ${userId} has no Nylas connection`);
            return { success: false, error: 'Nylas not connected' };
        }

        const { accessToken, grantId } = await getNylasClient(userId);

        // Fetch recent messages
        const response = await axios.get(
            `${API_URI}/grants/${grantId}/messages`,
            {
                headers: getHeaders(accessToken),
                params: {
                    limit: Math.min(limit, 100),
                    view: 'expanded'
                }
            }
        );

        const messages = response.data.data || [];
        console.log(`📧 [NYLAS SYNC] Found ${messages.length} messages`);

        let processedCount = 0;
        let errorCount = 0;

        for (const message of messages) {
            try {
                const result = await processSyncedMessage(userId, message);
                if (result) processedCount++;
            } catch (err) {
                errorCount++;
                console.error(`❌ [NYLAS SYNC] Error processing message ${message.id}:`, err.message);
            }
        }

        console.log(`✅ [NYLAS SYNC] Completed: ${processedCount} processed, ${errorCount} errors`);
        return { success: true, processed: processedCount, errors: errorCount };

    } catch (error) {
        console.error('❌ [NYLAS SYNC] Error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Process a synced message
 */
async function processSyncedMessage(userId, message) {
    try {
        // Only process emails that are replies
        const subject = message.subject || '';
        if (!subject.startsWith('Re:') && !subject.startsWith('RE:')) {
            return false; // Not a reply
        }

        // Get sender email
        const from = message.from?.[0]?.email;
        if (!from) return false;

        // Check if this is a lead
        const lead = await Lead.findOne({
            userId: userId,
            email: from
        });

        if (!lead) return false;

        // Check if this message already exists in lead replies
        const exists = lead.replies?.some(r => r.messageId === message.id);
        if (exists) return false;

        // Build sender name
        const senderName = message.from?.[0]?.name || from;

        // Add reply to lead
        lead.replies = lead.replies || [];
        lead.replies.push({
            from: `${senderName} <${from}>`,
            subject: subject,
            content: message.body || '',
            receivedAt: new Date(message.date),
            isRead: false,
            messageId: message.id
        });
        lead.lastContactDate = new Date(message.date);
        lead.status = 'Replied';
        await lead.save();

        // Create notification
        await Notification.create({
            userId: userId,
            type: 'lead_reply',
            content: `New reply from ${senderName}: ${subject.substring(0, 50)}`,
            leadId: lead._id,
            isRead: false,
            createdAt: new Date()
        });

        console.log(`✅ [NYLAS SYNC] Synced reply from ${from} for lead ${lead.name}`);
        return true;

    } catch (error) {
        console.error('❌ [NYLAS SYNC] Process message error:', error.message);
        throw error;
    }
}

/**
 * Sync emails for all users (for cron job)
 */
async function syncAllUsersEmails(limit = 10) {
    try {
        console.log(`🔄 [NYLAS SYNC] Starting sync for all users...`);

        // Find all users with Nylas connected
        const users = await User.find({
            'nylasIntegration.isConnected': true
        });

        console.log(`🔄 [NYLAS SYNC] Found ${users.length} users with Nylas connected`);

        let totalProcessed = 0;
        let totalErrors = 0;

        for (const user of users) {
            try {
                const result = await syncNylasEmails(user._id, limit);
                if (result.success) {
                    totalProcessed += result.processed || 0;
                }
            } catch (err) {
                totalErrors++;
                console.error(`❌ [NYLAS SYNC] Failed to sync user ${user.email}:`, err.message);
            }
        }

        console.log(`✅ [NYLAS SYNC] All users synced: ${totalProcessed} messages processed, ${totalErrors} errors`);
        return { success: true, totalProcessed, totalErrors };

    } catch (error) {
        console.error('❌ [NYLAS SYNC] Sync all users error:', error.message);
        throw error;
    }
}

module.exports = {
    syncNylasEmails,
    syncAllUsersEmails,
    processSyncedMessage
};
