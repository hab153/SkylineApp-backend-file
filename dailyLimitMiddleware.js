const User = require('./User');

// Existing Chat Limit Checker
const checkDailyLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (!user.usage) user.usage = { dailyCallCount: 0, lastCallDate: new Date() };
        
        // UPDATED LIMITS
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

// NEW: Hint Limit Checker
const checkHintLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        // Initialize usage object if missing
        if (!user.usage) {
            user.usage = { 
                dailyCallCount: 0, 
                lastCallDate: new Date(),
                dailyHintCount: 0,
                lastHintDate: new Date()
            };
        }
        
        // Initialize hint specific fields if missing
        if (typeof user.usage.dailyHintCount === 'undefined') user.usage.dailyHintCount = 0;
        if (!user.usage.lastHintDate) user.usage.lastHintDate = new Date();

        // Determine Tier and Limit (Lowercase to match DB)
        const tier = (user.subscriptionTier || 'free').toLowerCase();
        let limit = 0; // Free plan gets 0
        if (tier === 'go')  limit = 10;
        if (tier === 'pro') limit = 20;

        // Check Date Reset
        const todayStr = new Date().toDateString();
        const lastHintStr = new Date(user.usage.lastHintDate).toDateString();
        
        if (lastHintStr !== todayStr) {
            user.usage.dailyHintCount = 0;
            user.usage.lastHintDate = new Date();
            await user.save();
        }
        
        // Check Limit
        if (user.usage.dailyHintCount >= limit) {
            return res.status(403).json({ 
                error: 'Daily hint limit reached', 
                tier: tier,
                remaining: 0 
            });
        }
        
        // Increment Count
        user.usage.dailyHintCount += 1;
        await user.save();
        
        // Attach remaining hints to request for frontend use
        req.remainingHints = limit - user.usage.dailyHintCount;
        next();
    } catch (err) {
        console.error('Error checking hint limit:', err);
        res.status(500).json({ error: 'Server Error checking hint limits' });
    }
};

module.exports = { checkDailyLimit, checkHintLimit };
