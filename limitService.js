// limitService.js
// UPDATED: Added AI Suggestion limits with plan-based daily caps

const User = require('./User');

// Define limits per plan tier
const LIMITS = {
    free: { emails: 30, research: 4, chats: 30, aiSuggestions: 7 },
    go:   { emails: 70, research: 10, chats: 90, aiSuggestions: 15 },
    pro:  { emails: 120, research: 20, chats: 150, aiSuggestions: 35 }
};

// ─ WINDOW: 24 hours in milliseconds ──
const RESET_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Check if 24h have passed since last reset
 * Returns TRUE if reset should happen
 */
function shouldReset(lastLimitReset) {
    if (!lastLimitReset) return true;
    const now = Date.now();
    const last = new Date(lastLimitReset).getTime();
    return (now - last) >= RESET_WINDOW_MS;
}

/**
 * Checks if the user has reached their daily limit and increments the count if allowed.
 */
async function checkAndIncrement(userId, type) {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    // ── Ensure usage object exists ──
    if (!user.usage) user.usage = {};

    const now = new Date();

    // ─── Reset counters if 24h passed OR first-ever use ──
    if (shouldReset(user.usage.lastLimitReset)) {
        console.log(`🔄 [LIMITS] Resetting counters for user ${userId}`);
        user.usage.dailyEmailCount = 0;
        user.usage.dailyResearchCount = 0;
        user.usage.dailyChatCount = 0;
        user.usage.dailyAiSuggestionCount = 0; // ⭐ NEW
        user.usage.lastLimitReset = now;
    }

    const tier = user.subscriptionTier || 'free';
    const limitConfig = LIMITS[tier] || LIMITS.free;

    let currentCount = 0;
    if (type === 'email')         currentCount = user.usage.dailyEmailCount          || 0;
    if (type === 'research')      currentCount = user.usage.dailyResearchCount       || 0;
    if (type === 'chat')          currentCount = user.usage.dailyChatCount           || 0;
    if (type === 'aiSuggestion')  currentCount = user.usage.dailyAiSuggestionCount   || 0; // ⭐ NEW

    const limitKey = type === 'email' ? 'emails' 
                   : type === 'research' ? 'research' 
                   : type === 'chat' ? 'chats' 
                   : 'aiSuggestions'; // ⭐ NEW
    
    const limit = limitConfig[limitKey];

    if (currentCount >= limit) {
        console.log(`🚫 [LIMITS] ${type} limit reached for user ${userId} (${currentCount}/${limit})`);
        user.markModified('usage');
        await user.save();
        return { allowed: false, remaining: 0, limit: limit, used: currentCount };
    }

    // ─── Increment counter ───
    if (type === 'email')         user.usage.dailyEmailCount          = currentCount + 1;
    if (type === 'research')      user.usage.dailyResearchCount       = currentCount + 1;
    if (type === 'chat')          user.usage.dailyChatCount           = currentCount + 1;
    if (type === 'aiSuggestion')  user.usage.dailyAiSuggestionCount   = currentCount + 1; // ⭐ NEW

    // ─── CRITICAL: Tell Mongoose nested field changed ───
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
    if (!user) return { emails: 0, research: 0, chats: 0, aiSuggestions: 0 };

    const tier = user.subscriptionTier || 'free';
    const limitConfig = LIMITS[tier] || LIMITS.free;

    // ✅ FIX: If reset needed OR no lastLimitReset → full limits
    if (shouldReset(user.usage?.lastLimitReset)) {
        return {
            emails: limitConfig.emails,
            research: limitConfig.research,
            chats: limitConfig.chats,
            aiSuggestions: limitConfig.aiSuggestions // ⭐ NEW
        };
    }

    return {
        emails:         Math.max(0, limitConfig.emails         - (user.usage?.dailyEmailCount        || 0)),
        research:       Math.max(0, limitConfig.research       - (user.usage?.dailyResearchCount     || 0)),
        chats:          Math.max(0, limitConfig.chats          - (user.usage?.dailyChatCount         || 0)),
        aiSuggestions:  Math.max(0, limitConfig.aiSuggestions  - (user.usage?.dailyAiSuggestionCount || 0)) // ⭐ NEW
    };
}

module.exports = { checkAndIncrement, getRemainingLimits, LIMITS };
