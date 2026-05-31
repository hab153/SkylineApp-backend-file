const User = require('./User');

// Daily limit for chat/dreams (Free:10, Go:50, Pro:200)
const checkDailyLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (!user.usage) user.usage = { dailyCallCount: 0, lastCallDate: new Date() };
        
        let limit = 10; // Free plan
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 50;
        if (tier === 'pro') limit = 200;
        
        const todayStr = new Date().toDateString();
        const lastStr = user.usage.lastCallDate ? new Date(user.usage.lastCallDate).toDateString() : '';
        
        if (lastStr !== todayStr) {
            user.usage.dailyCallCount = 0;
            user.usage.lastCallDate = new Date();
            await user.save();
        }
        
        if (user.usage.dailyCallCount >= limit) {
            return res.status(429).json({ message: `Daily chat limit reached (${limit}/${limit}). Upgrade for more.` });
        }
        
        user.usage.dailyCallCount += 1;
        await user.save();
        next();
    } catch (err) {
        console.error('Error checking daily limit:', err);
        res.status(500).json({ message: 'Server Error checking usage limits' });
    }
};

// Hint limit middleware (Free:3, Go:20, Pro:Unlimited)
const checkHintLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};
        if (user.usage.dailyHintCount === undefined) user.usage.dailyHintCount = 0;
        if (!user.usage.lastHintDate) user.usage.lastHintDate = null;

        let limit = 3; // Free
        const tier = user.subscriptionTier;
        if (tier === 'go') limit = 20;
        if (tier === 'pro') limit = Infinity; // Unlimited
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

        // Only increment if limit is finite
        if (limit !== Infinity) {
            user.usage.dailyHintCount += 1;
            await user.save();
        }

        req.remainingHints = (limit === Infinity) ? Infinity : limit - user.usage.dailyHintCount;
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
        throw new Error(`Daily email send limit reached (${limit}/${limit}). Upgrade to send more.`);
    }

    user.usage.dailySentCount += 1;
    await user.save();
    return { remaining: limit - user.usage.dailySentCount };
};

module.exports = { checkDailyLimit, checkHintLimit, checkAndIncrementSendLimit };
