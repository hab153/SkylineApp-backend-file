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

// Daily limit for chat/dreams (Free:10, Go:50, Pro:150)
const checkDailyLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (!user.usage) user.usage = { dailyCallCount: 0, lastCallDate: new Date() };
        
        let limit = 10; // Free plan
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 50;
        if (tier === 'pro') limit = 150;
        
        const todayStr = new Date().toDateString();
        const lastStr = user.usage.lastCallDate ? new Date(user.usage.lastCallDate).toDateString() : '';
        
        if (lastStr !== todayStr) {
            user.usage.dailyCallCount = 0;
            user.usage.lastCallDate = new Date();
            await user.save();
        }
        
        if (user.usage.dailyCallCount >= limit) {
            const message = getChatLimitMessage(tier, limit);
            return res.status(429).json({ message });
        }
        
        user.usage.dailyCallCount += 1;
        await user.save();
        next();
    } catch (err) {
        console.error('Error checking daily limit:', err);
        res.status(500).json({ message: 'Server Error checking usage limits' });
    }
};

// Hint limit middleware (Free:3, Go:15, Pro:70)
const checkHintLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};
        if (user.usage.dailyHintCount === undefined) user.usage.dailyHintCount = 0;
        if (!user.usage.lastHintDate) user.usage.lastHintDate = null;

        let limit = 3; // Free plan
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 15;
        if (tier === 'pro') limit = 70;

        const today = new Date().toDateString();
        const lastHintDateStr = user.usage.lastHintDate ? new Date(user.usage.lastHintDate).toDateString() : null;
        if (lastHintDateStr !== today) {
            user.usage.dailyHintCount = 0;
            user.usage.lastHintDate = new Date();
            await user.save();
        }

        if (user.usage.dailyHintCount >= limit) {
            const message = getHintLimitMessage(tier, limit);
            return res.status(403).json({ message, redirect: '/dashboard' });
        }

        user.usage.dailyHintCount += 1;
        await user.save();

        req.remainingHints = limit - user.usage.dailyHintCount;
        next();
    } catch (err) {
        console.error('Hint limit error:', err);
        res.status(500).json({ message: 'Server error checking hint limit' });
    }
};

// Helper to check and increment daily email send limit (Free:5, Go:200, Pro:1000)
const checkAndIncrementSendLimit = async (userId) => {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    if (!user.usage) user.usage = {};
    if (user.usage.dailySentCount === undefined) user.usage.dailySentCount = 0;
    if (!user.usage.lastSentDate) user.usage.lastSentDate = null;

    let limit = 5; // Free
    const tier = user.subscriptionTier;
    if (tier === 'go') limit = 200;
    if (tier === 'pro') limit = 1000;

    const today = new Date().toDateString();
    const lastSentStr = user.usage.lastSentDate ? new Date(user.usage.lastSentDate).toDateString() : null;
    if (lastSentStr !== today) {
        user.usage.dailySentCount = 0;
        user.usage.lastSentDate = new Date();
        await user.save();
    }

    if (user.usage.dailySentCount >= limit) {
        const message = getSendLimitMessage(tier, limit);
        throw new Error(message);
    }

    user.usage.dailySentCount += 1;
    await user.save();
    return { remaining: limit - user.usage.dailySentCount };
};

// Suggest follow-up limit (Free:5, Go:30, Pro:200)
const checkSuggestFollowUpLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};
        if (user.usage.dailySuggestFollowUpCount === undefined) user.usage.dailySuggestFollowUpCount = 0;
        if (!user.usage.lastSuggestFollowUpDate) user.usage.lastSuggestFollowUpDate = null;

        let limit = 5; // Free
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 30;
        if (tier === 'pro') limit = 200;

        const today = new Date().toDateString();
        const lastDateStr = user.usage.lastSuggestFollowUpDate ? new Date(user.usage.lastSuggestFollowUpDate).toDateString() : null;
        if (lastDateStr !== today) {
            user.usage.dailySuggestFollowUpCount = 0;
            user.usage.lastSuggestFollowUpDate = new Date();
            await user.save();
        }

        if (user.usage.dailySuggestFollowUpCount >= limit) {
            let message = '';
            if (tier === 'free') message = 'Daily suggest follow-up limit reached (5/5). Upgrade to Go (30/day) or Pro (200/day) for more.';
            else if (tier === 'go') message = 'Daily suggest follow-up limit reached (30/30). Upgrade to Pro for 200/day.';
            else message = 'Daily suggest follow-up limit reached (200/200). Please try again tomorrow.';
            return res.status(429).json({ message });
        }

        req.userWithSuggestLimit = user;
        next();
    } catch (err) {
        console.error('Suggest follow-up limit error:', err);
        res.status(500).json({ message: 'Server error checking limit' });
    }
};

// Auto follow-up enable limit (Free:0, Go:15, Pro:100)
const checkAutoFollowUpLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};
        if (user.usage.dailyAutoFollowUpCount === undefined) user.usage.dailyAutoFollowUpCount = 0;
        if (!user.usage.lastAutoFollowUpDate) user.usage.lastAutoFollowUpDate = null;

        let limit = 0; // Free
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 15;
        if (tier === 'pro') limit = 100;

        if (limit === 0) {
            return res.status(403).json({
                message: 'Auto follow-up is not available on the Free plan. Upgrade to Go (15/day) or Pro (100/day).'
            });
        }

        const today = new Date().toDateString();
        const lastDateStr = user.usage.lastAutoFollowUpDate ? new Date(user.usage.lastAutoFollowUpDate).toDateString() : null;
        if (lastDateStr !== today) {
            user.usage.dailyAutoFollowUpCount = 0;
            user.usage.lastAutoFollowUpDate = new Date();
            await user.save();
        }

        if (user.usage.dailyAutoFollowUpCount >= limit) {
            let message = '';
            if (tier === 'go') message = 'Daily auto follow-up limit reached (15/15). Upgrade to Pro for 100/day.';
            else message = 'Daily auto follow-up limit reached (100/100). Please try again tomorrow.';
            return res.status(429).json({ message });
        }

        req.userWithAutoLimit = user;
        next();
    } catch (err) {
        console.error('Auto follow-up limit error:', err);
        res.status(500).json({ message: 'Server error checking limit' });
    }
};

// NEW: Assistant limit middleware (Free:20, Go:70, Pro:200)
const checkAssistantLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};
        if (user.usage.assistantCount === undefined) user.usage.assistantCount = 0;
        if (!user.usage.assistantLastDate) user.usage.assistantLastDate = null;

        let limit = 20; // Free plan
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 70;
        if (tier === 'pro') limit = 200;

        const today = new Date().toDateString();
        const lastDateStr = user.usage.assistantLastDate ? new Date(user.usage.assistantLastDate).toDateString() : null;
        if (lastDateStr !== today) {
            user.usage.assistantCount = 0;
            user.usage.assistantLastDate = new Date();
            await user.save();
        }

        if (user.usage.assistantCount >= limit) {
            const message = getAssistantLimitMessage(tier, limit);
            return res.status(429).json({ message });
        }

        // Store user and remaining count in req for later use
        req.userDoc = user;
        req.assistantLimit = limit;
        req.assistantRemaining = limit - user.usage.assistantCount;

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
    checkAssistantLimit  // <-- NEW
};
