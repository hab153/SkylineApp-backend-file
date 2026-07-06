const cron = require('node-cron');
const User = require('./User');
const { refreshAccessToken } = require('./gmailService');

/**
 * Refresh all Gmail tokens that are about to expire
 * Runs every 10 minutes and checks tokens expiring within 30 minutes
 */
async function refreshAllGmailTokens() {
    console.log('🔄 [GMAIL REFRESH] Checking for tokens to refresh...');

    try {
        // Find users with Gmail connected and token expiring within 30 minutes
        const thirtyMinutesFromNow = new Date(Date.now() + 30 * 60 * 1000);

        const users = await User.find({
            'gmailIntegration.isConnected': true,
            'gmailIntegration.expiresAt': { $lt: thirtyMinutesFromNow }
        });

        console.log(`🔄 [GMAIL REFRESH] Found ${users.length} tokens to refresh`);

        let refreshed = 0;
        let failed = 0;

        for (const user of users) {
            try {
                await refreshAccessToken(user._id);
                refreshed++;
                console.log(`✅ [GMAIL REFRESH] Refreshed token for ${user.email}`);
            } catch (err) {
                failed++;
                console.error(`❌ [GMAIL REFRESH] Failed to refresh token for ${user.email}:`, err.message);
                
                // If refresh fails, mark as disconnected
                try {
                    user.gmailIntegration.isConnected = false;
                    await user.save();
                    console.log(`🔌 [GMAIL REFRESH] Disconnected Gmail for ${user.email} due to refresh failure`);
                } catch (saveErr) {
                    console.error(`❌ [GMAIL REFRESH] Failed to update user ${user.email}:`, saveErr.message);
                }
            }
        }

        console.log(`✅ [GMAIL REFRESH] Completed - ${refreshed} refreshed, ${failed} failed`);

    } catch (error) {
        console.error('❌ [GMAIL REFRESH] Job error:', error.message);
    }
}

/**
 * Start the Gmail token refresh job
 * Runs every 10 minutes
 */
function startGmailTokenRefreshJob() {
    console.log('🔄 [GMAIL REFRESH] Scheduled to run every 10 minutes');
    
    // Run immediately on startup (after 5 seconds delay)
    setTimeout(() => {
        refreshAllGmailTokens();
    }, 5000);

    // Schedule every 10 minutes
    const job = cron.schedule('*/10 * * * *', () => {
        refreshAllGmailTokens();
    });

    return job;
}

/**
 * Force refresh a specific user's token
 */
async function forceRefreshToken(userId) {
    try {
        const result = await refreshAccessToken(userId);
        console.log(`✅ [GMAIL REFRESH] Force refreshed token for user ${userId}`);
        return result;
    } catch (error) {
        console.error(`❌ [GMAIL REFRESH] Force refresh failed for user ${userId}:`, error.message);
        throw error;
    }
}

module.exports = {
    startGmailTokenRefreshJob,
    refreshAllGmailTokens,
    forceRefreshToken
};
