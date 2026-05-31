const User = require('./User');

// Helper to get chat limit message based on tier
function getChatLimitMessage(tier, limit) {
    if (tier === 'free') return `Daily chat limit reached (10/10). Upgrade to Go (50/day) or Pro (150/day) for more conversations.`;
    if (tier === 'go') return `Daily chat limit reached (50/50). Upgrade to Pro for 150 chats per day.`;
    return `Daily chat limit reached (150/150). Please continue tomorrow.`;
}

// Helper to get hint limit message
function getHintLimitMessage(tier, limit) {
    if (tier === 'free') return `You've used all your free hints (3/3). Upgrade to Go (20/day) or Pro (300/day) for more AI suggestions.`;
    if (tier === 'go') return `Daily hint limit reached (20/20). Upgrade to Pro for 300 hints per day.`;
    return `Daily hint limit reached (300/300). Please try again tomorrow.`;
}

// Helper to get email send limit message
function getSendLimitMessage(tier, limit) {
    if (tier === 'free') return `Daily email send limit reached (5/5). Upgrade to Go (25/day) or Pro (100/day) to send more emails.`;
    if (tier === 'go') return `Daily email send limit reached (25/25). Upgrade to Pro for 100 emails per day.`;
    return `Daily email send limit reached (100/100). Please try again tomorrow.`;
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

// Hint limit middleware (Free:3, Go:20, Pro:300)
const checkHintLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};
        if (user.usage.dailyHintCount === undefined) user.usage.dailyHintCount = 0;
        if (!user.usage.lastHintDate) user.usage.lastHintDate = null;

        let limit = 3; // Free plan
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 20;
        if (tier === 'pro') limit = 300;

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

// Helper to check and increment daily email send limit (Free:5, Go:25, Pro:100)
const checkAndIncrementSendLimit = async (userId) => {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    if (!user.usage) user.usage = {};
    if (user.usage.dailySentCount === undefined) user.usage.dailySentCount = 0;
    if (!user.usage.lastSentDate) user.usage.lastSentDate = null;

    let limit = 5; // Free
    const tier = user.subscriptionTier;
    if (tier === 'go') limit = 25;
    if (tier === 'pro') limit = 100;

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

module.exports = { checkDailyLimit, checkHintLimit, checkAndIncrementSendLimit };
