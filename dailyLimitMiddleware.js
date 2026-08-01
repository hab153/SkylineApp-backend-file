// dailyLimitMiddleware.js
const User = require('./User');

// ─── TIER CONFIG ───
const TIER_LIMITS = {
    free: {
        chat: 10,
        hint: 3,
        suggestFollowUp: 3,
        autoFollowUp: 0,
        assistant: 20,
        send: 5
    },
    go: {
        chat: 50,
        hint: 15,
        suggestFollowUp: 30,
        autoFollowUp: 15,
        assistant: 70,
        send: 200
    },
    pro: {
        chat: 150,
        hint: 70,
        suggestFollowUp: 200,
        autoFollowUp: 100,
        assistant: 200,
        send: 1000
    }
};

// ─── HELPER: Get limit message ───
function getLimitMessage(tier, limit, type) {
    const messages = {
        chat: `Daily chat limit reached (${limit}/${limit}). Upgrade to Go (50/day) or Pro (150/day).`,
        hint: `Daily hint limit reached (${limit}/${limit}). Upgrade to Go (15/day) or Pro (70/day).`,
        suggestFollowUp: `Daily suggest follow-up limit reached (${limit}/${limit}). Upgrade to Go (30/day) or Pro (200/day).`,
        autoFollowUp: `Auto follow-up is not available on Free plan. Upgrade to Go (15/day) or Pro (100/day).`,
        assistant: `Daily assistant limit reached (${limit}/${limit}). Upgrade to Go (70/day) or Pro (200/day).`,
        send: `Daily email send limit reached (${limit}/${limit}). Upgrade to Go (200/day) or Pro (1000/day).`
    };
    return messages[type] || 'Daily limit reached.';
}

// ─── ATOMIC HELPER: Reset and increment in one operation ───
async function atomicIncrement(userId, countField, dateField, limit) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // ✅ FIXED: Correct MongoDB update with aggregation pipeline
    const result = await User.findOneAndUpdate(
        { _id: userId },
        [
            {
                $set: {
                    [countField]: {
                        $cond: [
                            { $ne: [`$${dateField}`, today] },
                            0,
                            `$${countField}`
                        ]
                    },
                    [dateField]: today
                }
            },
            {
                $set: {
                    [countField]: { $add: [`$${countField}`, 1] }
                }
            }
        ],
        {
            new: true,
            runValidators: true,
            projection: { usage: 1, subscriptionTier: 1 }
        }
    );
    
    return result;
}

// ─── ATOMIC HELPER: Check and increment if under limit ───
async function atomicCheckAndIncrement(userId, countField, dateField, limit) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // ✅ FIXED: Correct MongoDB update with aggregation pipeline
    // Step 1: Reset counter if date changed
    // Step 2: Check if under limit
    // Step 3: Increment
    const result = await User.findOneAndUpdate(
        {
            _id: userId,
            $or: [
                { [countField]: { $lt: limit } },
                { [dateField]: { $ne: today } }
            ]
        },
        [
            {
                $set: {
                    [countField]: {
                        $cond: [
                            { $ne: [`$${dateField}`, today] },
                            0,
                            `$${countField}`
                        ]
                    },
                    [dateField]: today
                }
            },
            {
                $set: {
                    [countField]: { $add: [`$${countField}`, 1] }
                }
            }
        ],
        {
            new: true,
            runValidators: true,
            projection: { usage: 1, subscriptionTier: 1 }
        }
    );
    
    return result;
}

// ─── CHECK DAILY LIMIT (Chat/Dreams) ───
const checkDailyLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const user = await User.findById(userId).select('subscriptionTier isSuspended');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.isSuspended) {
            return res.status(403).json({ 
                message: 'Account suspended', 
                suspensionEnds: user.suspensionEnds 
            });
        }

        const tier = user.subscriptionTier || 'free';
        const limit = TIER_LIMITS[tier].chat;

        const updatedUser = await atomicCheckAndIncrement(
            userId,
            'usage.dailyCallCount',
            'usage.lastCallDate',
            limit
        );

        if (!updatedUser) {
            return res.status(429).json({ 
                message: getLimitMessage(tier, limit, 'chat'),
                limit: limit,
                used: limit,
                remaining: 0,
                tier: tier
            });
        }

        const newCount = updatedUser.usage?.dailyCallCount || 0;
        req.remainingLimit = limit - newCount;
        req.limitType = 'chat';
        req.usage = updatedUser.usage;
        
        next();

    } catch (error) {
        console.error('❌ [DAILY LIMIT] Error:', error.message);
        res.status(500).json({ message: 'Server error checking daily limit' });
    }
};

// ─── CHECK HINT LIMIT ───
const checkHintLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const user = await User.findById(userId).select('subscriptionTier isSuspended');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.isSuspended) {
            return res.status(403).json({ 
                message: 'Account suspended', 
                suspensionEnds: user.suspensionEnds 
            });
        }

        const tier = user.subscriptionTier || 'free';
        const limit = TIER_LIMITS[tier].hint;

        const updatedUser = await atomicCheckAndIncrement(
            userId,
            'usage.dailyHintCount',
            'usage.lastHintDate',
            limit
        );

        if (!updatedUser) {
            return res.status(429).json({ 
                message: getLimitMessage(tier, limit, 'hint'),
                limit: limit,
                used: limit,
                remaining: 0,
                tier: tier
            });
        }

        const newCount = updatedUser.usage?.dailyHintCount || 0;
        req.remainingHints = limit - newCount;
        req.usage = updatedUser.usage;
        
        next();

    } catch (error) {
        console.error('❌ [HINT LIMIT] Error:', error.message);
        res.status(500).json({ message: 'Server error checking hint limit' });
    }
};

// ─── CHECK SUGGEST FOLLOW-UP LIMIT ───
const checkSuggestFollowUpLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const user = await User.findById(userId).select('subscriptionTier isSuspended');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.isSuspended) {
            return res.status(403).json({ 
                message: 'Account suspended', 
                suspensionEnds: user.suspensionEnds 
            });
        }

        const tier = user.subscriptionTier || 'free';
        const limit = TIER_LIMITS[tier].suggestFollowUp;

        const updatedUser = await atomicCheckAndIncrement(
            userId,
            'usage.dailySuggestFollowUpCount',
            'usage.lastSuggestFollowUpDate',
            limit
        );

        if (!updatedUser) {
            return res.status(429).json({ 
                message: getLimitMessage(tier, limit, 'suggestFollowUp'),
                limit: limit,
                used: limit,
                remaining: 0,
                tier: tier
            });
        }

        req.userWithSuggestLimit = updatedUser;
        req.usage = updatedUser.usage;
        
        next();

    } catch (error) {
        console.error('❌ [SUGGEST FOLLOW-UP LIMIT] Error:', error.message);
        res.status(500).json({ message: 'Server error checking suggest follow-up limit' });
    }
};

// ─── CHECK AUTO FOLLOW-UP LIMIT ───
const checkAutoFollowUpLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const user = await User.findById(userId).select('subscriptionTier isSuspended');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.isSuspended) {
            return res.status(403).json({ 
                message: 'Account suspended', 
                suspensionEnds: user.suspensionEnds 
            });
        }

        const tier = user.subscriptionTier || 'free';
        const limit = TIER_LIMITS[tier].autoFollowUp;

        if (limit === 0) {
            return res.status(403).json({
                success: false,
                message: getLimitMessage(tier, limit, 'autoFollowUp'),
                upgradeNeeded: true
            });
        }

        const updatedUser = await atomicCheckAndIncrement(
            userId,
            'usage.dailyAutoFollowUpCount',
            'usage.lastAutoFollowUpDate',
            limit
        );

        if (!updatedUser) {
            return res.status(429).json({ 
                success: false,
                message: getLimitMessage(tier, limit, 'autoFollowUp'),
                limit: limit,
                used: limit,
                remaining: 0,
                tier: tier
            });
        }

        req.userWithAutoLimit = updatedUser;
        req.usage = updatedUser.usage;
        
        next();

    } catch (error) {
        console.error('❌ [AUTO FOLLOW-UP LIMIT] Error:', error.message);
        res.status(500).json({ success: false, message: 'Server error checking auto follow-up limit' });
    }
};

// ─── CHECK ASSISTANT LIMIT ───
const checkAssistantLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const user = await User.findById(userId).select('subscriptionTier isSuspended');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (user.isSuspended) {
            return res.status(403).json({ 
                message: 'Account suspended', 
                suspensionEnds: user.suspensionEnds 
            });
        }

        const tier = user.subscriptionTier || 'free';
        const limit = TIER_LIMITS[tier].assistant;

        const updatedUser = await atomicCheckAndIncrement(
            userId,
            'usage.dailyAssistantCount',
            'usage.lastAssistantDate',
            limit
        );

        if (!updatedUser) {
            return res.status(429).json({ 
                message: getLimitMessage(tier, limit, 'assistant'),
                limit: limit,
                used: limit,
                remaining: 0,
                tier: tier
            });
        }

        const newCount = updatedUser.usage?.dailyAssistantCount || 0;
        req.assistantRemaining = limit - newCount;
        req.usage = updatedUser.usage;
        req.userDoc = updatedUser;
        
        next();

    } catch (error) {
        console.error('❌ [ASSISTANT LIMIT] Error:', error.message);
        res.status(500).json({ message: 'Server error checking assistant limit' });
    }
};

// ─── CHECK AND INCREMENT SEND LIMIT (For emails) ───
const checkAndIncrementSendLimit = async (userId) => {
    try {
        const user = await User.findById(userId).select('subscriptionTier isSuspended');
        if (!user) throw new Error('User not found');

        if (user.isSuspended) {
            throw new Error('Account suspended');
        }

        const tier = user.subscriptionTier || 'free';
        const limit = TIER_LIMITS[tier].send;

        const updatedUser = await atomicCheckAndIncrement(
            userId,
            'usage.dailySentCount',
            'usage.lastSentDate',
            limit
        );

        if (!updatedUser) {
            throw new Error(getLimitMessage(tier, limit, 'send'));
        }

        const newCount = updatedUser.usage?.dailySentCount || 0;
        return { 
            remaining: limit - newCount,
            usage: updatedUser.usage
        };

    } catch (error) {
        throw error;
    }
};

module.exports = { 
    checkDailyLimit, 
    checkHintLimit, 
    checkSuggestFollowUpLimit,
    checkAutoFollowUpLimit,
    checkAssistantLimit,
    checkAndIncrementSendLimit,
    TIER_LIMITS
};
