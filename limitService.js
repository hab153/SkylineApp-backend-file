// limitService.js
const User = require('./User');

// Define limits per plan tier
const LIMITS = {
    free: { emails: 30, research: 4, chats: 30 },
    go:   { emails: 70, research: 10, chats: 90 },
    pro:  { emails: 120, research: 20, chats: 150 }
};

// ─── Helper: check if 24h have passed since last reset ───
function needsReset(lastLimitReset) {
    if (!lastLimitReset) return true; // never set → reset needed
    const now = new Date();
    const last = new Date(lastLimitReset);
    const hoursSinceReset = (now - last) / (1000 * 60 * 60);
    return hoursSinceReset >= 24;
}

/**
 * Checks if the user has reached their daily limit and increments the count if allowed.
 */
async function checkAndIncrement(userId, type) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    const now = new Date();

    // ─── Ensure usage object exists ───
    if (!user.usage) user.usage = {};

    // ✅ FIX: If no lastLimitReset OR 24h passed → reset counters
    if (needsReset(user.usage.lastLimitReset)) {
        user.usage.dailyEmailCount = 0;
        user.usage.dailyResearchCount = 0;
        user.usage.dailyChatCount = 0;
        user.usage.lastLimitReset = now;
        console.log(`🔄 [LIMITS] Reset counters for user ${userId} (24h window)`);
    }

    const tier = user.subscriptionTier || 'free';
    const limitConfig = LIMITS[tier] || LIMITS.free;

    // ─── Read current count for this type ───
    let currentCount = 0;
    if (type === 'email')    currentCount = user.usage.dailyEmailCount    || 0;
    if (type === 'research') currentCount = user.usage.dailyResearchCount || 0;
    if (type === 'chat')     currentCount = user.usage.dailyChatCount     || 0;

    const limitKey = type === 'email' ? 'emails' : type === 'research' ? 'research' : 'chats';
    const limit = limitConfig[limitKey];

    // ─── Check limit reached ───
    if (currentCount >= limit) {
        console.log(`🚫 [LIMITS] ${type} limit reached for user ${userId} (${currentCount}/${limit})`);
        // Still save to persist any reset
        await user.save();
        return { allowed: false, remaining: 0, limit: limit, used: currentCount };
    }

    // ─── Increment counter ───
    if (type === 'email')    user.usage.dailyEmailCount    = currentCount + 1;
    if (type === 'research') user.usage.dailyResearchCount = currentCount + 1;
    if (type === 'chat')     user.usage.dailyChatCount     = currentCount + 1;

    // ✅ Mark as modified (Mongoose sometimes misses nested updates)
    user.markModified('usage');

    await user.save();

    const remaining = limit - (currentCount + 1);
    console.log(`✅ [LIMITS] ${type} incremented for user ${userId}: ${currentCount + 1}/${limit} (remaining: ${remaining})`);

    return {
        allowed: true,
        remaining: remaining,
        limit: limit,
        used: currentCount + 1
    };
}

/**
 * Gets the remaining limits for the user WITHOUT incrementing.
 */
async function getRemainingLimits(userId) {
    const user = await User.findById(userId);
    if (!user) return { emails: 0, research: 0, chats: 0 };

    const tier = user.subscriptionTier || 'free';
    const limitConfig = LIMITS[tier] || LIMITS.free;

    // ✅ FIX: If no lastLimitReset OR 24h passed → user has full limits
    if (needsReset(user.usage?.lastLimitReset)) {
        return {
            emails: limitConfig.emails,
            research: limitConfig.research,
            chats: limitConfig.chats
        };
    }

    // ✅ Return remaining = limit - used (never negative)
    return {
        emails:   Math.max(0, limitConfig.emails   - (user.usage?.dailyEmailCount    || 0)),
        research: Math.max(0, limitConfig.research - (user.usage?.dailyResearchCount || 0)),
        chats:    Math.max(0, limitConfig.chats    - (user.usage?.dailyChatCount     || 0))
    };
}

/**
 * Returns full usage breakdown for a user.
 */
async function getUsageDetails(userId) {
    const user = await User.findById(userId).select('usage subscriptionTier').lean();
    if (!user) return null;

    const tier = user.subscriptionTier || 'free';
    const limitConfig = LIMITS[tier] || LIMITS.free;

    if (needsReset(user.usage?.lastLimitReset)) {
        return {
            tier,
            limits: {
                email:    { used: 0, max: limitConfig.emails,   remaining: limitConfig.emails },
                research: { used: 0, max: limitConfig.research, remaining: limitConfig.research },
                chat:     { used: 0, max: limitConfig.chats,    remaining: limitConfig.chats }
            }
        };
    }

    const usedEmails   = user.usage?.dailyEmailCount    || 0;
    const usedResearch = user.usage?.dailyResearchCount || 0;
    const usedChats    = user.usage?.dailyChatCount     || 0;

    return {
        tier,
        limits: {
            email:    { used: usedEmails,   max: limitConfig.emails,   remaining: Math.max(0, limitConfig.emails   - usedEmails) },
            research: { used: usedResearch, max: limitConfig.research, remaining: Math.max(0, limitConfig.research - usedResearch) },
            chat:     { used: usedChats,    max: limitConfig.chats,    remaining: Math.max(0, limitConfig.chats    - usedChats) }
        }
    };
}

module.exports = { checkAndIncrement, getRemainingLimits, getUsageDetails, LIMITS };
