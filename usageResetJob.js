// usageResetJob.js
const cron = require('node-cron');
const User = require('./User');

/**
 * Reset daily usage at midnight
 * Runs every day at 00:00
 */
function startUsageResetJob() {
    cron.schedule('0 0 * * *', async () => {
        console.log('🔄 [USAGE RESET] Running daily reset...');
        try {
            const result = await User.updateMany(
                {},
                {
                    $set: {
                        'usage.dailyCallCount': 0,
                        'usage.lastCallDate': null,
                        'usage.dailyHintCount': 0,
                        'usage.lastHintDate': null,
                        'usage.dailySentCount': 0,
                        'usage.lastSentDate': null,
                        'usage.dailySuggestFollowUpCount': 0,
                        'usage.lastSuggestFollowUpDate': null,
                        'usage.dailyAutoFollowUpCount': 0,
                        'usage.lastAutoFollowUpDate': null,
                        'usage.assistantCount': 0,
                        'usage.assistantLastDate': null,
                        'usage.dailyImageCount': 0,
                        'usage.lastImageUploadDate': null,
                        'usage.dailyFileCount': 0,
                        'usage.lastFileUploadDate': null,
                        'usage.lastResetDate': new Date()
                    }
                }
            );
            console.log(`✅ [USAGE RESET] Reset ${result.modifiedCount} users`);
        } catch (error) {
            console.error('❌ [USAGE RESET] Error:', error);
        }
    });
    console.log('⏰ [USAGE RESET] Scheduled to run daily at midnight');
}

module.exports = { startUsageResetJob };
