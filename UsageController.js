// UsageController.js
const User = require('./User');
const { getLimits } = require('./dailyLimitMiddleware');

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
        const limits = getLimits(plan);

        // ── Current usage values ──
        const currentUsage = {
            chatMessages: usage.dailyCallCount || 0,
            hints: usage.dailyHintCount || 0,
            emailsSent: usage.dailySentCount || 0,
            followUpSuggestions: usage.dailySuggestFollowUpCount || 0,
            autoFollowUps: usage.dailyAutoFollowUpCount || 0,
            assistantMessages: usage.assistantCount || 0,
            leadGeneration: usage.dailyCallCount || 0,
            images: usage.dailyImageCount || 0,
            files: usage.dailyFileCount || 0
        };

        // ── Calculate percentages ──
        const percentages = {
            chatMessages: getPercentage(currentUsage.chatMessages, limits.chat),
            hints: getPercentage(currentUsage.hints, limits.hints),
            emailsSent: getPercentage(currentUsage.emailsSent, limits.emails),
            followUpSuggestions: getPercentage(currentUsage.followUpSuggestions, limits.followUp),
            autoFollowUps: getPercentage(currentUsage.autoFollowUps, limits.autoFollowUp),
            assistantMessages: getPercentage(currentUsage.assistantMessages, limits.assistant),
            leadGeneration: getPercentage(currentUsage.leadGeneration, limits.leadGen),
            images: getPercentage(currentUsage.images, limits.images),
            files: getPercentage(currentUsage.files, limits.files)
        };

        // ── Build response ──
        const response = {
            plan: plan,
            limits: {
                chatMessages: limits.chat,
                hints: limits.hints,
                emailsSent: limits.emails,
                followUpSuggestions: limits.followUp,
                autoFollowUps: limits.autoFollowUp,
                assistantMessages: limits.assistant,
                leadGeneration: limits.leadGen,
                images: limits.images,
                files: limits.files
            },
            usage: currentUsage,
            percentages: percentages,
            isUnlimited: {
                leadGeneration: limits.leadGen === Infinity
            },
            isDisabled: {
                autoFollowUps: limits.autoFollowUp === 0,
                images: limits.images === 0,
                files: limits.files === 0
            },
            remaining: {
                chatMessages: Math.max(0, limits.chat - currentUsage.chatMessages),
                hints: Math.max(0, limits.hints - currentUsage.hints),
                emailsSent: Math.max(0, limits.emails - currentUsage.emailsSent),
                followUpSuggestions: Math.max(0, limits.followUp - currentUsage.followUpSuggestions),
                autoFollowUps: limits.autoFollowUp === Infinity ? '∞' : Math.max(0, limits.autoFollowUp - currentUsage.autoFollowUps),
                assistantMessages: Math.max(0, limits.assistant - currentUsage.assistantMessages),
                leadGeneration: limits.leadGen === Infinity ? '∞' : Math.max(0, limits.leadGen - currentUsage.leadGeneration),
                images: Math.max(0, limits.images - currentUsage.images),
                files: Math.max(0, limits.files - currentUsage.files)
            }
        };

        console.log(`📊 [Usage] User ${userId} (${plan}): ${currentUsage.chatMessages}/${limits.chat} chat used`);
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
