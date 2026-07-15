// UsageController.js
const User = require('./User');

/**
 * GET /api/usage
 * Get real-time usage for the authenticated user
 */
exports.getUsage = async (req, res) => {
    try {
        const userId = req.userId;

        const user = await User.findById(userId).select('usage subscriptionTier');
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const plan = user.subscriptionTier || 'free';
        const usage = user.usage || {};

        // ── Limits from dailyLimitMiddleware.js ──
        const limits = {
            free: {
                chatMessages: 10,
                hints: 3,
                emailsSent: 5,
                followUpSuggestions: 5,
                autoFollowUps: 0,
                assistantMessages: 20,
                leadGeneration: 1
            },
            go: {
                chatMessages: 50,
                hints: 15,
                emailsSent: 200,
                followUpSuggestions: 30,
                autoFollowUps: 15,
                assistantMessages: 70,
                leadGeneration: 50
            },
            pro: {
                chatMessages: 150,
                hints: 70,
                emailsSent: 1000,
                followUpSuggestions: 200,
                autoFollowUps: 100,
                assistantMessages: 200,
                leadGeneration: Infinity
            }
        };

        const planLimits = limits[plan] || limits.free;

        // ── Get current usage values ──
        const currentUsage = {
            chatMessages: usage.dailyCallCount || 0,
            hints: usage.dailyHintCount || 0,
            emailsSent: usage.dailySentCount || 0,
            followUpSuggestions: usage.dailySuggestFollowUpCount || 0,
            autoFollowUps: usage.dailyAutoFollowUpCount || 0,
            assistantMessages: usage.assistantCount || 0,
            leadGeneration: usage.dailyCallCount || 0
        };

        // ── Calculate percentages ──
        const percentages = {
            chatMessages: getPercentage(currentUsage.chatMessages, planLimits.chatMessages),
            hints: getPercentage(currentUsage.hints, planLimits.hints),
            emailsSent: getPercentage(currentUsage.emailsSent, planLimits.emailsSent),
            followUpSuggestions: getPercentage(currentUsage.followUpSuggestions, planLimits.followUpSuggestions),
            autoFollowUps: getPercentage(currentUsage.autoFollowUps, planLimits.autoFollowUps),
            assistantMessages: getPercentage(currentUsage.assistantMessages, planLimits.assistantMessages),
            leadGeneration: getPercentage(currentUsage.leadGeneration, planLimits.leadGeneration)
        };

        // ── Build response ──
        const response = {
            plan: plan,
            limits: planLimits,
            usage: currentUsage,
            percentages: percentages,
            isUnlimited: {
                leadGeneration: planLimits.leadGeneration === Infinity
            },
            isDisabled: {
                autoFollowUps: planLimits.autoFollowUps === 0
            },
            remaining: {
                chatMessages: Math.max(0, planLimits.chatMessages - currentUsage.chatMessages),
                hints: Math.max(0, planLimits.hints - currentUsage.hints),
                emailsSent: Math.max(0, planLimits.emailsSent - currentUsage.emailsSent),
                followUpSuggestions: Math.max(0, planLimits.followUpSuggestions - currentUsage.followUpSuggestions),
                autoFollowUps: planLimits.autoFollowUps === Infinity ? '∞' : Math.max(0, planLimits.autoFollowUps - currentUsage.autoFollowUps),
                assistantMessages: Math.max(0, planLimits.assistantMessages - currentUsage.assistantMessages),
                leadGeneration: planLimits.leadGeneration === Infinity ? '∞' : Math.max(0, planLimits.leadGeneration - currentUsage.leadGeneration)
            }
        };

        console.log(`📊 [Usage] Fetched usage for user ${userId} (${plan} plan)`);
        res.json(response);

    } catch (error) {
        console.error('❌ [Usage] Error:', error);
        res.status(500).json({ error: 'Failed to fetch usage data' });
    }
};

function getPercentage(used, limit) {
    if (limit === Infinity) return 0;
    if (limit === 0) return 0;
    const pct = (used / limit) * 100;
    return Math.min(Math.round(pct), 100);
              }
