// dailyLimitMiddleware.js
const User = require('./User');

// Helper to get chat limit message based on tier
function getChatLimitMessage(tier, limit) {
    if (tier === 'free') return `Daily chat limit reached (10/10). Upgrade to Go (50/day) or Pro (150/day) for more conversations.`;
    if (tier === 'go') return `Daily chat limit reached (50/50). Upgrade to Pro for 150 chats per day.`;
    return `Daily chat limit reached (150/150). Please continue tomorrow.`;
}

// Helper to get hint limit message (Free:3, Go:15, Pro:70)
function getHintLimitMessage(tier, limit) {
    if (tier === 'free') return `You've used all your free hints (3/3). Upgrade to Go (15/day) or Pro (70/day) for more AI suggestions.`;
    if (tier === 'go') return `Daily hint limit reached (15/15). Upgrade to Pro for 70 hints per day.`;
    return `Daily hint limit reached (70/70). Please try again tomorrow.`;
}

// Helper to get email send limit message (Free:5, Go:200, Pro:1000)
function getSendLimitMessage(tier, limit) {
    if (tier === 'free') return `Daily email send limit reached (5/5). Upgrade to Go (200/day) or Pro (1000/day) to send more emails.`;
    if (tier === 'go') return `Daily email send limit reached (200/200). Upgrade to Pro for 1000 emails per day.`;
    return `Daily email send limit reached (1000/1000). Please try again tomorrow.`;
}

// Helper to get assistant limit message (Free:20, Go:70, Pro:200)
function getAssistantLimitMessage(tier, limit) {
    if (tier === 'free') return `Daily assistant limit reached (20/20). Upgrade to Go (70/day) or Pro (200/day) for more assistance.`;
    if (tier === 'go') return `Daily assistant limit reached (70/70). Upgrade to Pro for 200 assistant messages per day.`;
    return `Daily assistant limit reached (200/200). Please try again tomorrow.`;
}

// ✅ ATOMIC HELPER: Reset counter if date changed
async function atomicResetIfNeeded(userId, countField, dateField) {
    const todayStr = new Date().toDateString();
    
    // Atomically reset ONLY if the stored date doesn't match today
    // This prevents race conditions during midnight rollover
    await User.updateOne(
        { 
            _id: userId,
            $expr: { 
                $ne: [
                    { $dateToString: { format: "%Y-%m-%d", date: `$${dateField}` } },
                    todayStr
                ]
            }
        },
        { 
            $set: { 
                [countField]: 0,
                [dateField]: new Date()
            }
        }
    );
}

// Daily limit for chat/dreams (Free:10, Go:50, Pro:150)
const checkDailyLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        
        // Get user tier first (read-only, safe)
        const user = await User.findById(userId).select('subscriptionTier');
        if (!user) return res.status(404).json({ message: 'User not found' });
        
        let limit = 10;
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 50;
        if (tier === 'pro') limit = 150;
        
        // ✅ ATOMIC: Reset counter if needed
        await atomicResetIfNeeded(userId, 'usage.dailyCallCount', 'usage.lastCallDate');
        
        // ✅ ATOMIC: Check limit AND increment in ONE operation
        const updatedUser = await User.findOneAndUpdate(
            { 
                _id: userId,
                'usage.dailyCallCount': { $lt: limit }
            },
            { $inc: { 'usage.dailyCallCount': 1 } },
            { new: true, select: 'usage.dailyCallCount subscriptionTier' }
        );
        
        if (!updatedUser) {
            // Either user doesn't exist OR they've hit their limit
            const currentUser = await User.findById(userId).select('subscriptionTier usage.dailyCallCount');
            const message = getChatLimitMessage(currentUser?.subscriptionTier || 'free', limit);
            return res.status(429).json({ message });
        }
        
        next();
    } catch (err) {
        console.error('Error checking daily limit:', err);
        res.status(500).json({ message: 'Server Error checking usage limits' });
    }
};

// Hint limit middleware (Free:3, Go:15, Pro:70)
const checkHintLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        
        const user = await User.findById(userId).select('subscriptionTier');
        if (!user) return res.status(404).json({ message: 'User not found' });

        let limit = 3;
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 15;
        if (tier === 'pro') limit = 70;

        // ✅ ATOMIC: Reset counter if needed
        await atomicResetIfNeeded(userId, 'usage.dailyHintCount', 'usage.lastHintDate');

        // ✅ ATOMIC: Check limit AND increment
        const updatedUser = await User.findOneAndUpdate(
            { 
                _id: userId,
                'usage.dailyHintCount': { $lt: limit }
            },
            { $inc: { 'usage.dailyHintCount': 1 } },
            { new: true, select: 'usage.dailyHintCount subscriptionTier' }
        );

        if (!updatedUser) {
            const currentUser = await User.findById(userId).select('subscriptionTier usage.dailyHintCount');
            const message = getHintLimitMessage(currentUser?.subscriptionTier || 'free', limit);
            return res.status(403).json({ message, redirect: '/dashboard' });
        }

        req.remainingHints = limit - updatedUser.usage.dailyHintCount;
        next();
    } catch (err) {
        console.error('Hint limit error:', err);
        res.status(500).json({ message: 'Server error checking hint limit' });
    }
};

// Helper to check and increment daily email send limit (Free:5, Go:200, Pro:1000)
const checkAndIncrementSendLimit = async (userId) => {
    const user = await User.findById(userId).select('subscriptionTier');
    if (!user) throw new Error('User not found');

    let limit = 5;
    const tier = user.subscriptionTier;
    if (tier === 'go') limit = 200;
    if (tier === 'pro') limit = 1000;

    // ✅ ATOMIC: Reset counter if needed
    await atomicResetIfNeeded(userId, 'usage.dailySentCount', 'usage.lastSentDate');

    // ✅ ATOMIC: Check limit AND increment
    const updatedUser = await User.findOneAndUpdate(
        { 
            _id: userId,
            'usage.dailySentCount': { $lt: limit }
        },
        { $inc: { 'usage.dailySentCount': 1 } },
        { new: true, select: 'usage.dailySentCount subscriptionTier' }
    );

    if (!updatedUser) {
        const currentUser = await User.findById(userId).select('subscriptionTier usage.dailySentCount');
        const message = getSendLimitMessage(currentUser?.subscriptionTier || 'free', limit);
        throw new Error(message);
    }

    return { remaining: limit - updatedUser.usage.dailySentCount };
};

// Suggest follow-up limit (Free:5, Go:30, Pro:200)
const checkSuggestFollowUpLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        
        const user = await User.findById(userId).select('subscriptionTier');
        if (!user) return res.status(404).json({ message: 'User not found' });

        let limit = 5;
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 30;
        if (tier === 'pro') limit = 200;

        // ✅ ATOMIC: Reset counter if needed
        await atomicResetIfNeeded(userId, 'usage.dailySuggestFollowUpCount', 'usage.lastSuggestFollowUpDate');

        // ✅ ATOMIC: Check limit AND increment
        const updatedUser = await User.findOneAndUpdate(
            { 
                _id: userId,
                'usage.dailySuggestFollowUpCount': { $lt: limit }
            },
            { $inc: { 'usage.dailySuggestFollowUpCount': 1 } },
            { new: true, select: 'usage.dailySuggestFollowUpCount subscriptionTier' }
        );

        if (!updatedUser) {
            const currentUser = await User.findById(userId).select('subscriptionTier usage.dailySuggestFollowUpCount');
            let message = '';
            const t = currentUser?.subscriptionTier || 'free';
            if (t === 'free') message = 'Daily suggest follow-up limit reached (5/5). Upgrade to Go (30/day) or Pro (200/day) for more.';
            else if (t === 'go') message = 'Daily suggest follow-up limit reached (30/30). Upgrade to Pro for 200/day.';
            else message = 'Daily suggest follow-up limit reached (200/200). Please try again tomorrow.';
            return res.status(429).json({ message });
        }

        req.userWithSuggestLimit = updatedUser;
        next();
    } catch (err) {
        console.error('Suggest follow-up limit error:', err);
        res.status(500).json({ message: 'Server error checking limit' });
    }
};

// ✅ FIXED: Auto follow-up enable limit (Free:0, Go:15, Pro:100)
const checkAutoFollowUpLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        
        const user = await User.findById(userId).select('subscriptionTier');
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        let limit = 0;
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 15;
        if (tier === 'pro') limit = 100;

        // ✅ FIX: Free users get a helpful message instead of error
        if (limit === 0) {
            return res.status(403).json({
                success: false,
                message: 'Auto follow-up is not available on the Free plan. Upgrade to Go (15/day) or Pro (100/day).',
                upgradeNeeded: true
            });
        }

        // ✅ ATOMIC: Reset counter if needed
        await atomicResetIfNeeded(userId, 'usage.dailyAutoFollowUpCount', 'usage.lastAutoFollowUpDate');

        // ✅ ATOMIC: Check limit AND increment
        const updatedUser = await User.findOneAndUpdate(
            { 
                _id: userId,
                'usage.dailyAutoFollowUpCount': { $lt: limit }
            },
            { $inc: { 'usage.dailyAutoFollowUpCount': 1 } },
            { new: true, select: 'usage.dailyAutoFollowUpCount subscriptionTier' }
        );

        if (!updatedUser) {
            const currentUser = await User.findById(userId).select('subscriptionTier usage.dailyAutoFollowUpCount');
            let message = '';
            const t = currentUser?.subscriptionTier || 'go';
            if (t === 'go') message = 'Daily auto follow-up limit reached (15/15). Upgrade to Pro for 100/day.';
            else message = 'Daily auto follow-up limit reached (100/100). Please try again tomorrow.';
            return res.status(429).json({ success: false, message });
        }

        req.userWithAutoLimit = updatedUser;
        next();
    } catch (err) {
        console.error('Auto follow-up limit error:', err);
        res.status(500).json({ success: false, message: 'Server error checking limit' });
    }
};

// Assistant limit middleware (Free:20, Go:70, Pro:200)
const checkAssistantLimit = async (req, res, next) => {
    try {
        const userId = req.userId;
        
        const user = await User.findById(userId).select('subscriptionTier');
        if (!user) return res.status(404).json({ message: 'User not found' });

        let limit = 20;
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 70;
        if (tier === 'pro') limit = 200;

        // ✅ ATOMIC: Reset counter if needed
        await atomicResetIfNeeded(userId, 'usage.assistantCount', 'usage.assistantLastDate');

        // ✅ ATOMIC: Check limit AND increment
        const updatedUser = await User.findOneAndUpdate(
            { 
                _id: userId,
                'usage.assistantCount': { $lt: limit }
            },
            { $inc: { 'usage.assistantCount': 1 } },
            { new: true, select: 'usage.assistantCount subscriptionTier' }
        );

        if (!updatedUser) {
            const currentUser = await User.findById(userId).select('subscriptionTier usage.assistantCount');
            const message = getAssistantLimitMessage(currentUser?.subscriptionTier || 'free', limit);
            return res.status(429).json({ message });
        }

        req.userDoc = updatedUser;
        req.assistantLimit = limit;
        req.assistantRemaining = limit - updatedUser.usage.assistantCount;

        next();
    } catch (err) {
        console.error('Assistant limit error:', err);
        res.status(500).json({ message: 'Server error checking assistant limit' });
    }
};

module.exports = { 
    checkDailyLimit, 
    checkHintLimit, 
    checkAndIncrementSendLimit,
    checkSuggestFollowUpLimit,
    checkAutoFollowUpLimit,
    checkAssistantLimit
};
