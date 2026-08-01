// subscriptionMiddleware.js
const User = require('./User');
const Lead = require('./Lead');

/**
 * ✅ FIXED: Atomic subscription expiry check with pending email cancellation
 */
const checkSubscriptionExpiry = async (req, res, next) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        // ✅ ATOMIC: Single atomic operation to check and update expiry
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
                                        { $lt: ['$subscriptionEndDate', new Date()] }
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
                                        { $lt: ['$subscriptionEndDate', new Date()] }
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
                    subscriptionEndDate: 1,
                    isSuspended: 1
                }
            }
        );

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.isSuspended) {
            return res.status(403).json({ 
                message: 'Account suspended', 
                suspensionEnds: user.suspensionEnds 
            });
        }

        // ✅ CRITICAL: If user was downgraded to free, cancel pending emails
        if (user.subscriptionTier === 'free' && !user.subscriptionEndDate) {
            // Cancel all pending auto-follow-ups for this user
            const result = await Lead.updateMany(
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

            if (result.modifiedCount > 0) {
                console.log(`⚠️ [SUBSCRIPTION] Cancelled ${result.modifiedCount} pending leads for user ${userId} due to downgrade`);
            }
        }

        // Attach subscription info to request
        req.subscriptionTier = user.subscriptionTier || 'free';
        req.subscriptionEndDate = user.subscriptionEndDate;
        req.userSubscription = user;

        next();

    } catch (error) {
        console.error('❌ [SUBSCRIPTION] Error:', error.message);
        res.status(500).json({ message: 'Server error checking subscription' });
    }
};

/**
 * ✅ FIXED: Atomic subscription upgrade
 */
const upgradeSubscription = async (userId, tier, durationDays = 30) => {
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + durationDays);

    // ✅ ATOMIC: Single atomic operation for upgrade
    const user = await User.findByIdAndUpdate(
        userId,
        {
            $set: {
                subscriptionTier: tier,
                subscriptionEndDate: endDate
            }
        },
        {
            new: true,
            runValidators: true,
            projection: {
                subscriptionTier: 1,
                subscriptionEndDate: 1
            }
        }
    );

    // ✅ If user was upgraded to pro/go, re-enable any pending leads?
    if (user && tier !== 'free') {
        console.log(`🔄 [SUBSCRIPTION] User ${userId} upgraded to ${tier}`);
    }

    return user;
};

/**
 * ✅ FIXED: Atomic subscription downgrade with cleanup
 */
const downgradeSubscription = async (userId) => {
    // ✅ ATOMIC: Single atomic operation for downgrade
    const user = await User.findByIdAndUpdate(
        userId,
        {
            $set: {
                subscriptionTier: 'free',
                subscriptionEndDate: null
            }
        },
        {
            new: true,
            runValidators: true,
            projection: {
                subscriptionTier: 1,
                subscriptionEndDate: 1
            }
        }
    );

    // ✅ CRITICAL: Cancel all pending leads on downgrade
    if (user) {
        const result = await Lead.updateMany(
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
        console.log(`⚠️ [SUBSCRIPTION] Cancelled ${result.modifiedCount} pending leads for user ${userId} on downgrade`);
    }

    return user;
};

/**
 * ✅ FIXED: Get current subscription status (atomic read)
 */
const getSubscriptionStatus = async (userId) => {
    const user = await User.findById(userId)
        .select('subscriptionTier subscriptionEndDate isSuspended')
        .lean();

    if (!user) return null;

    const now = new Date();
    const isExpired = user.subscriptionEndDate && new Date(user.subscriptionEndDate) < now;
    const tier = user.subscriptionTier || 'free';

    return {
        tier: tier,
        endDate: user.subscriptionEndDate,
        isExpired: isExpired,
        isActive: tier !== 'free' && !isExpired,
        isSuspended: user.isSuspended || false
    };
};

module.exports = { 
    checkSubscriptionExpiry,
    upgradeSubscription,
    downgradeSubscription,
    getSubscriptionStatus
};
