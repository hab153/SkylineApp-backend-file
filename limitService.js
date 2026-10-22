// limitService.js
const User = require('./User');

// Define limits per plan tier as specified
const LIMITS = {
    free: { emails: 30, research: 4, chats: 30 },
    go:   { emails: 70, research: 10, chats: 90 },
    pro:  { emails: 120, research: 20, chats: 150 }
};

/**
 * Checks if the user has reached their daily limit and increments the count if allowed.
 */
async function checkAndIncrement(userId, type) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    const now = new Date();
    const lastReset = new Date(user.usage.lastLimitReset || 0);
    const hoursSinceReset = (now - lastReset) / (1000 * 60 * 60);

    // Reset counts if 24 hours have passed
    if (hoursSinceReset >= 24) {
        user.usage.dailyEmailCount = 0;
        user.usage.dailyResearchCount = 0;
        user.usage.dailyChatCount = 0;
        user.usage.lastLimitReset = now;
    }

    const tier = user.subscriptionTier || 'free';
    const limitConfig = LIMITS[tier] || LIMITS.free;
    
    let currentCount = 0;
    if (type === 'email') currentCount = user.usage.dailyEmailCount;
    if (type === 'research') currentCount = user.usage.dailyResearchCount;
    if (type === 'chat') currentCount = user.usage.dailyChatCount;

    const limit = limitConfig[type === 'email' ? 'emails' : type === 'research' ? 'research' : 'chats'];

    if (currentCount >= limit) {
        return { allowed: false, remaining: 0, limit: limit };
    }

    // Increment the specific counter directly on the object
    if (type === 'email') user.usage.dailyEmailCount += 1;
    if (type === 'research') user.usage.dailyResearchCount += 1;
    if (type === 'chat') user.usage.dailyChatCount += 1;
    
    // Save the user document to persist the change
    await user.save();

    return { 
        allowed: true, 
        remaining: limit - (currentCount + 1), 
        limit: limit 
    };
}

/**
 * Gets the remaining limits for the user without incrementing.
 */
async function getRemainingLimits(userId) {
    const user = await User.findById(userId);
    if (!user) return { emails: 0, research: 0, chats: 0 };

    const now = new Date();
    const lastReset = new Date(user.usage.lastLimitReset || 0);
    const tier = user.subscriptionTier || 'free';
    const limitConfig = LIMITS[tier] || LIMITS.free;

    // If reset time has passed, return full limits
    if ((now - lastReset) / (1000 * 60 * 60) >= 24) {
        return {
            emails: limitConfig.emails,
            research: limitConfig.research,
            chats: limitConfig.chats
        };
    }

    return {
        emails: Math.max(0, limitConfig.emails - user.usage.dailyEmailCount),
        research: Math.max(0, limitConfig.research - user.usage.dailyResearchCount),
        chats: Math.max(0, limitConfig.chats - user.usage.dailyChatCount)
    };
}

module.exports = { checkAndIncrement, getRemainingLimits };
