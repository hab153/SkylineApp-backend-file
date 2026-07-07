const cron = require('node-cron');
const User = require('./User');
const { refreshNylasToken } = require('./nylasService');

/**
 * Refresh all Nylas tokens that are about to expire
 */
async function refreshAllNylasTokens() {
    console.log('🔄 [NYLAS REFRESH] Checking for tokens to refresh...');

    try {
        // Find users with Nylas connected and token expiring within 30 minutes
        const thirtyMinutesFromNow = new Date(Date.now() + 30 * 60 * 1000);

        const users = await User.find({
            'nylasIntegration.isConnected': true,
            'nylasIntegration.tokenExpiry': { $lt: thirtyMinutesFromNow }
        });

        console.log(`🔄 [NYLAS REFRESH] Found ${users.length} tokens to refresh`);

        let refreshed = 0;
        let failed = 0;

        for (const user of users) {
            try {
                await refreshNylasToken(user._id);
                refreshed++;
                console.log(`✅ [NYLAS REFRESH] Refreshed token for ${user.email}`);
            } catch (err) {
                failed++;
                console.error(`❌ [NYLAS REFRESH] Failed to refresh token for ${user.email}:`, err.message);
                
                // Mark as disconnected if refresh fails
                try {
                    user.nylasIntegration.isConnected = false;
                    await user.save();
                } catch (saveErr) {
                    console.error(`❌ [NYLAS REFRESH] Failed to update user ${user.email}:`, saveErr.message);
                }
            }
        }

        console.log(`✅ [NYLAS REFRESH] Completed - ${refreshed} refreshed, ${failed} failed`);

    } catch (error) {
        console.error('❌ [NYLAS REFRESH] Job error:', error.message);
    }
}

/**
 * Force refresh a specific user's token
 */
async function forceRefreshToken(userId) {
    try {
        const result = await refreshNylasToken(userId);
        console.log(`✅ [NYLAS REFRESH] Force refreshed token for user ${userId}`);
        return result;
    } catch (error) {
        console.error(`❌ [NYLAS REFRESH] Force refresh failed for user ${userId}:`, error.message);
        throw error;
    }
}

/**
 * Start the Nylas token refresh job
 */
function startNylasTokenRefreshJob() {
    console.log('🔄 [NYLAS REFRESH] Scheduled to run every 10 minutes');
    
    // Run immediately on startup (after 5 seconds delay)
    setTimeout(() => {
        refreshAllNylasTokens();
    }, 5000);

    // Schedule every 10 minutes
    const job = cron.schedule('*/10 * * * *', () => {
        refreshAllNylasTokens();
    });

    return job;
}

/**
 * Get token refresh status
 */
async function getTokenRefreshStatus() {
    try {
        const users = await User.find({
            'nylasIntegration.isConnected': true
        });

        const now = new Date();
        const thirtyMinutesFromNow = new Date(Date.now() + 30 * 60 * 1000);

        const expiringSoon = users.filter(u => 
            u.nylasIntegration?.tokenExpiry && 
            new Date(u.nylasIntegration.tokenExpiry) < thirtyMinutesFromNow
        );

        return {
            totalConnected: users.length,
            expiringSoon: expiringSoon.length,
            users: expiringSoon.map(u => ({
                email: u.email,
                expiresAt: u.nylasIntegration?.tokenExpiry
            }))
        };
    } catch (error) {
        console.error('❌ [NYLAS REFRESH] Status error:', error.message);
        return { error: error.message };
    }
}

module.exports = {
    startNylasTokenRefreshJob,
    refreshAllNylasTokens,
    forceRefreshToken,
    getTokenRefreshStatus
};
