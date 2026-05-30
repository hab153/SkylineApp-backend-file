const User = require('./User');

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

module.exports = { checkDailyLimit };
