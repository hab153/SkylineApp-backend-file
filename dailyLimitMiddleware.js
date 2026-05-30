const User = require('./User');

// Existing daily limit for chat/dreams
const checkDailyLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (!user.usage) user.usage = { dailyCallCount: 0, lastCallDate: new Date() };
        
        let limit = 7; // Free plan
        if (user.subscriptionTier === 'go')  limit = 30;
        if (user.subscriptionTier === 'pro') limit = 50;
        const todayStr = new Date().toDateString();
        const lastStr  = user.usage.lastCallDate ? new Date(user.usage.lastCallDate).toDateString() : '';
        
        if (lastStr !== todayStr) {
            user.usage.dailyCallCount = 0;
            user.usage.lastCallDate   = new Date();
            await user.save();
        }
        
        if (user.usage.dailyCallCount >= limit) {
            return res.status(429).json({ message: `Daily limit reached (${limit}/${limit}). Upgrade for more.` });
        }
        
        user.usage.dailyCallCount += 1;
        await user.save();
        next();
    } catch (err) {
        console.error('Error checking daily limit:', err);
        res.status(500).json({ message: 'Server Error checking usage limits' });
    }
};

// Hint limit middleware (free:0, go:10, pro:20)
const checkHintLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};
        if (user.usage.dailyHintCount === undefined) user.usage.dailyHintCount = 0;
        if (!user.usage.lastHintDate) user.usage.lastHintDate = null;

        let limit = 0;
        const tier = user.subscriptionTier;
        if (tier === 'free') limit = 0;
        else if (tier === 'go') limit = 10;
        else if (tier === 'pro') limit = 20;

        const today = new Date().toDateString();
        const lastHintDateStr = user.usage.lastHintDate ? new Date(user.usage.lastHintDate).toDateString() : null;
        if (lastHintDateStr !== today) {
            user.usage.dailyHintCount = 0;
            user.usage.lastHintDate = new Date();
            await user.save();
        }

        if (user.usage.dailyHintCount >= limit) {
            return res.status(403).json({
                message: 'Daily hint limit reached. Upgrade your plan for more hints.',
                redirect: '/dashboard'
            });
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

// NEW: Helper to check and increment daily email send limit (used in leadController and nylasInboundWebhook)
const checkAndIncrementSendLimit = async (userId) => {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    if (!user.usage) user.usage = {};
    if (user.usage.dailySentCount === undefined) user.usage.dailySentCount = 0;
    if (!user.usage.lastSentDate) user.usage.lastSentDate = null;

    let limit = 7; // free
    const tier = user.subscriptionTier;
    if (tier === 'go') limit = 30;
    if (tier === 'pro') limit = 50;

    const today = new Date().toDateString();
    const lastSentStr = user.usage.lastSentDate ? new Date(user.usage.lastSentDate).toDateString() : null;
    if (lastSentStr !== today) {
        user.usage.dailySentCount = 0;
        user.usage.lastSentDate = new Date();
        await user.save();
    }

    if (user.usage.dailySentCount >= limit) {
        throw new Error(`Daily email send limit reached (${limit}/${limit}). Upgrade to send more.`);
    }

    user.usage.dailySentCount += 1;
    await user.save();
    return { remaining: limit - user.usage.dailySentCount };
};

module.exports = { checkDailyLimit, checkHintLimit, checkAndIncrementSendLimit };
