// subscriptionMiddleware.js
const User = require('./User');

/**
 * ✅ FIXED: Atomic subscription expiry check
 * Uses MongoDB atomic operations to prevent race conditions
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

    return user;
};

/**
 * ✅ FIXED: Atomic subscription downgrade
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
