// expiryJob.js
const cron = require('node-cron');
const User = require('./User');

/**
 * ✅ FIXED: Atomic subscription expiry check for all users
 * Uses MongoDB bulk atomic operations for performance
 */
async function processExpiredSubscriptions() {
    const now = new Date();
    console.log(`🔍 [EXPIRY JOB] Checking for expired subscriptions at ${now.toISOString()}`);

    try {
        // ✅ ATOMIC: Bulk update for expired pro users
        const proResult = await User.updateMany(
            {
                subscriptionTier: 'pro',
                subscriptionEndDate: { $lt: now },
                isSuspended: { $ne: true }
            },
            {
                $set: {
                    subscriptionTier: 'free',
                    subscriptionEndDate: null
                }
            }
        );

        // ✅ ATOMIC: Bulk update for expired go users
        const goResult = await User.updateMany(
            {
                subscriptionTier: 'go',
                subscriptionEndDate: { $lt: now },
                isSuspended: { $ne: true }
            },
            {
                $set: {
                    subscriptionTier: 'free',
                    subscriptionEndDate: null
                }
            }
        );

        // ✅ ATOMIC: Also handle any users with null subscriptionEndDate but not free
        const cleanupResult = await User.updateMany(
            {
                subscriptionTier: { $ne: 'free' },
                subscriptionEndDate: { $lte: now }
            },
            {
                $set: {
                    subscriptionTier: 'free',
                    subscriptionEndDate: null
                }
            }
        );

        const totalModified = proResult.modifiedCount + goResult.modifiedCount + cleanupResult.modifiedCount;

        if (totalModified > 0) {
            console.log(`✅ [EXPIRY JOB] Downgraded ${totalModified} users to free tier`);
            console.log(`   📊 Pro downgraded: ${proResult.modifiedCount}`);
            console.log(`   📊 Go downgraded: ${goResult.modifiedCount}`);
            console.log(`   📊 Cleanup: ${cleanupResult.modifiedCount}`);
        } else {
            console.log(`📭 [EXPIRY JOB] No expired subscriptions found`);
        }

    } catch (error) {
        console.error('❌ [EXPIRY JOB] Error:', error.message);
    }
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
    }, 60000); // Wait 1 minute for DB connection

    console.log(`⏰ [EXPIRY JOB] Scheduled to run every hour`);
}

/**
 * ✅ FIXED: Manual expiry check (for testing or admin trigger)
 */
async function checkExpiryForUser(userId) {
    const now = new Date();
    
    const user = await User.findByIdAndUpdate(
        userId,
        [
            {
                $set: {
                    subscriptionTier: {
                        $cond: [
                            {
                                $and: [
                                    { $ne: ['$subscriptionTier', 'free'] },
                                    { $lt: ['$subscriptionEndDate', now] }
                                ]
                            },
                            'free',
                            '$subscriptionTier'
                        ]
                    },
                    subscriptionEndDate: {
                        $cond: [
                            {
                                $or: [
                                    { $eq: ['$subscriptionTier', 'free'] },
                                    { $lt: ['$subscriptionEndDate', now] }
                                ]
                            },
                            null,
                            '$subscriptionEndDate'
                        ]
                    }
                }
            }
        ],
        {
            new: true,
            runValidators: true,
            projection: {
                subscriptionTier: 1,
                subscriptionEndDate: 1
            }
        }
    );

    return user;
}

module.exports = { 
    startExpiryJob, 
    processExpiredSubscriptions,
    checkExpiryForUser
};
