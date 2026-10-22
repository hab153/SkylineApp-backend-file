// ============================================================
// researchLimitService.js
// Dedicated service for RESEARCH limits only
// Handles: 24h reset, verification, increment, save
// ============================================================

const User = require('./User');

// ─── LIMITS PER TIER ───
const RESEARCH_LIMITS = {
    free: 4,
    go:   10,
    pro:  20
};

// ─── WINDOW: 24 hours in milliseconds ───
const RESET_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Check if 24h have passed since last reset
 * Returns TRUE if reset should happen
 */
function shouldReset(lastLimitReset) {
    if (!lastLimitReset) return true;  // Never set → needs reset
    const now = Date.now();
    const last = new Date(lastLimitReset).getTime();
    return (now - last) >= RESET_WINDOW_MS;
}

/**
 * Verify and increment research counter
 * @param {string} userId - User's ObjectId
 * @returns {object} { allowed, remaining, limit, used, tier, error? }
 */
async function verifyAndIncrement(userId) {
    try {
        const user = await User.findById(userId);
        if (!user) {
            return { allowed: false, error: 'User not found', remaining: 0, limit: 0, used: 0 };
        }

        // ─── Ensure usage object exists ───
        if (!user.usage) user.usage = {};

        const now = new Date();

        // ─── Reset counters if 24h passed OR first-ever use ───
        const resetNeeded = shouldReset(user.usage.lastLimitReset);
        if (resetNeeded) {
            console.log(`🔄 [RESEARCH LIMIT] Resetting counters for user ${userId}`);
            user.usage.dailyResearchCount = 0;
            user.usage.lastLimitReset = now;
            // Only reset research counter — leave emails/chats alone
            // (they have their own reset logic elsewhere)
        }

        // ─── Get limit for tier ───
        const tier = user.subscriptionTier || 'free';
        const limit = RESEARCH_LIMITS[tier] || RESEARCH_LIMITS.free;
        const currentUsed = user.usage.dailyResearchCount || 0;

        // ─── Check if limit reached ───
        if (currentUsed >= limit) {
            console.log(`🚫 [RESEARCH LIMIT] User ${userId} reached limit (${currentUsed}/${limit})`);
            // Save in case we reset counters
            if (resetNeeded) {
                user.markModified('usage');
                await user.save();
            }
            return {
                allowed: false,
                remaining: 0,
                limit: limit,
                used: currentUsed,
                tier: tier,
                error: 'Daily research limit reached'
            };
        }

        // ─── Increment counter ───
        const newCount = currentUsed + 1;
        user.usage.dailyResearchCount = newCount;

        // ─── CRITICAL: Tell Mongoose nested field changed ───
        user.markModified('usage');

        // ─── Save to MongoDB ───
        await user.save();

        // ─── Verify save worked (read back from DB) ───
        const verified = await User.findById(userId).select('usage.dailyResearchCount').lean();
        const verifiedCount = verified?.usage?.dailyResearchCount || 0;

        console.log(`✅ [RESEARCH LIMIT] User ${userId}: ${verifiedCount}/${limit} (remaining: ${limit - verifiedCount})`);

        if (verifiedCount !== newCount) {
            console.error(`❌ [RESEARCH LIMIT] SAVE FAILED! Expected ${newCount}, got ${verifiedCount}`);
            return {
                allowed: false,
                error: 'Failed to save limit',
                remaining: limit - currentUsed,
                limit: limit,
                used: currentUsed,
                tier: tier
            };
        }

        return {
            allowed: true,
            remaining: limit - newCount,
            limit: limit,
            used: newCount,
            tier: tier
        };

    } catch (err) {
        console.error('❌ [RESEARCH LIMIT] verifyAndIncrement error:', err.message);
        return {
            allowed: false,
            error: 'Server error: ' + err.message,
            remaining: 0,
            limit: 0,
            used: 0
        };
    }
}

/**
 * Get remaining research limit WITHOUT incrementing
 * @param {string} userId
 * @returns {object} { research: number, limit: number, used: number, tier: string }
 */
async function getRemaining(userId) {
    try {
        const user = await User.findById(userId).select('usage subscriptionTier').lean();
        if (!user) {
            return { research: 0, limit: 0, used: 0, tier: 'free' };
        }

        const tier = user.subscriptionTier || 'free';
        const limit = RESEARCH_LIMITS[tier] || RESEARCH_LIMITS.free;

        // If reset needed, show full limit
        if (shouldReset(user.usage?.lastLimitReset)) {
            return {
                research: limit,
                limit: limit,
                used: 0,
                tier: tier
            };
        }

        const used = user.usage?.dailyResearchCount || 0;
        return {
            research: Math.max(0, limit - used),
            limit: limit,
            used: used,
            tier: tier
        };

    } catch (err) {
        console.error('❌ [RESEARCH LIMIT] getRemaining error:', err.message);
        return { research: 0, limit: 0, used: 0, tier: 'free' };
    }
}

/**
 * Get full usage details (all tiers)
 * @param {string} userId
 */
async function getFullDetails(userId) {
    const research = await getRemaining(userId);
    return {
        research: research,
        limits: RESEARCH_LIMITS,
        resetWindowHours: 24
    };
}

module.exports = {
    verifyAndIncrement,
    getRemaining,
    getFullDetails,
    RESEARCH_LIMITS
};
