// expiryJob.js
const cron = require('node-cron');
const User = require('./User');
const Lead = require('./Lead');

/**
 * ✅ FIXED: Atomic subscription expiry check for all users
 * Also cancels pending follow-ups and emails on downgrade
 */
async function processExpiredSubscriptions() {
    const now = new Date();
    console.log(`🔍 [EXPIRY JOB] Checking for expired subscriptions at ${now.toISOString()}`);

    try {
        // ─── ✅ FIND EXPIRED USERS ───
        const expiredUsers = await User.find({
            subscriptionTier: { $ne: 'free' },
            subscriptionEndDate: { $lt: now },
            isSuspended: { $ne: true }
        }).select('_id email subscriptionTier');

        if (expiredUsers.length === 0) {
            console.log(`📭 [EXPIRY JOB] No expired subscriptions found`);
            return;
        }

        console.log(`📋 [EXPIRY JOB] Found ${expiredUsers.length} users with expired subscriptions`);

        // ─── ✅ PROCESS EACH EXPIRED USER ───
        let totalDowngraded = 0;
        let totalEmailsCancelled = 0;
        let totalFollowUpsCancelled = 0;

        for (const user of expiredUsers) {
            try {
                console.log(`🔄 [EXPIRY JOB] Processing user: ${user.email} (${user._id})`);

                // ✅ 1. CANCEL ALL PENDING LEADS / FOLLOW-UPS
                const leadResult = await Lead.updateMany(
                    { 
                        userId: user._id,
                        $or: [
                            { autoFollowUpEnabled: true },
                            { followUpScheduledDate: { $ne: null } },
                            { status: 'Queued' }
                        ]
                    },
                    { 
                        $set: {
                            autoFollowUpEnabled: false,
                            followUpScheduledDate: null,
                            status: 'Cancelled'
                        }
                    }
                );

                if (leadResult.modifiedCount > 0) {
                    console.log(`   📧 Cancelled ${leadResult.modifiedCount} pending emails/follow-ups for ${user.email}`);
                    totalEmailsCancelled += leadResult.modifiedCount;
                }

                // ✅ 2. CANCEL ALL AUTO-REPLY CONFIGURATIONS
                const autoReplyResult = await Lead.updateMany(
                    { 
                        userId: user._id,
                        autoReplyEnabled: true
                    },
                    { 
                        $set: {
                            autoReplyEnabled: false
                        }
                    }
                );

                if (autoReplyResult.modifiedCount > 0) {
                    console.log(`   🤖 Disabled auto-reply for ${autoReplyResult.modifiedCount} leads for ${user.email}`);
                }

                // ✅ 3. RESET ALL USAGE COUNTERS TO FREE TIER
                const userUpdateResult = await User.updateOne(
                    { _id: user._id },
                    {
                        $set: {
                            subscriptionTier: 'free',
                            subscriptionEndDate: null,
                            'usage.dailyCallCount': 0,
                            'usage.dailyHintCount': 0,
                            'usage.dailySentCount': 0,
                            'usage.dailySuggestFollowUpCount': 0,
                            'usage.dailyAutoFollowUpCount': 0,
                            'usage.dailyAssistantCount': 0
                        }
                    }
                );

                if (userUpdateResult.modifiedCount > 0) {
                    console.log(`   ✅ Downgraded ${user.email} to free tier`);
                    totalDowngraded++;
                }

                // ✅ 4. SEND NOTIFICATION TO USER (Optional)
                try {
                    const Notification = require('./Notification');
                    await Notification.create({
                        userId: user._id,
                        type: 'subscription',
                        title: 'Subscription Expired',
                        message: `Your ${user.subscriptionTier.toUpperCase()} subscription has expired. You have been downgraded to the Free plan. All pending emails have been cancelled. Upgrade to continue using premium features.`,
                        read: false,
                        createdAt: new Date()
                    });
                    console.log(`   🔔 Sent notification to ${user.email}`);
                } catch (notifErr) {
                    console.log(`   ⏭️ Could not send notification: ${notifErr.message}`);
                }

            } catch (userErr) {
                console.error(`❌ [EXPIRY JOB] Error processing user ${user.email}:`, userErr.message);
            }
        }

        // ─── ✅ SUMMARY ───
        console.log(`✅ [EXPIRY JOB] Completed processing`);
        console.log(`   📊 Users downgraded: ${totalDowngraded}`);
        console.log(`   📧 Emails/follow-ups cancelled: ${totalEmailsCancelled}`);

    } catch (error) {
        console.error('❌ [EXPIRY JOB] Fatal error:', error.message);
    }
}

/**
 * ✅ FIXED: Manual expiry check for a specific user (admin trigger)
 */
async function checkExpiryForUser(userId) {
    const now = new Date();
    
    // ✅ Find user
    const user = await User.findById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    if (user.subscriptionTier === 'free' || !user.subscriptionEndDate || user.subscriptionEndDate > now) {
        return { success: true, message: 'User subscription is still active or already free' };
    }

    // ✅ Cancel all pending leads
    const leadResult = await Lead.updateMany(
        { 
            userId: userId,
            $or: [
                { autoFollowUpEnabled: true },
                { followUpScheduledDate: { $ne: null } }
            ]
        },
        { 
            $set: {
                autoFollowUpEnabled: false,
                followUpScheduledDate: null,
                status: 'Cancelled'
            }
        }
    );

    // ✅ Downgrade user
    await User.updateOne(
        { _id: userId },
        {
            $set: {
                subscriptionTier: 'free',
                subscriptionEndDate: null
            }
        }
    );

    return {
        success: true,
        message: `User downgraded to free. ${leadResult.modifiedCount} pending leads cancelled.`,
        cancelledLeads: leadResult.modifiedCount
    };
}

/**
 * ✅ FIXED: Start the expiry cron job
 */
function startExpiryJob() {
    // Run every hour
    cron.schedule('0 * * * *', () => {
        processExpiredSubscriptions();
    });

    // Also run once at startup
    setTimeout(() => {
        processExpiredSubscriptions();
    }, 60000);

    console.log(`⏰ [EXPIRY JOB] Scheduled to run every hour`);
}

module.exports = { 
    startExpiryJob, 
    processExpiredSubscriptions,
    checkExpiryForUser
};
