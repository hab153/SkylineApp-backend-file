const User = require('./User');

// ── Daily Limits per plan ──
const LIMITS = {
    free: {
        chat: 10,
        hints: 3,
        emails: 5,
        followUp: 5,
        autoFollowUp: 0,
        assistant: 20,
        leadGen: 1,
        images: 0,
        files: 0
    },
    go: {
        chat: 50,
        hints: 15,
        emails: 200,
        followUp: 30,
        autoFollowUp: 15,
        assistant: 70,
        leadGen: 50,
        images: 5,
        files: 5
    },
    pro: {
        chat: 150,
        hints: 70,
        emails: 1000,
        followUp: 200,
        autoFollowUp: 100,
        assistant: 200,
        leadGen: Infinity,
        images: 20,
        files: 20
    }
};

// ── Helper to get limits for a tier ──
function getLimits(tier) {
    return LIMITS[tier] || LIMITS.free;
}

// ── Helper to reset daily usage ──
async function resetDailyUsageIfNeeded(user) {
    const today = new Date().toDateString();
    const lastReset = user.usage?.lastResetDate ? new Date(user.usage.lastResetDate).toDateString() : null;
    
    if (lastReset !== today) {
        user.usage = {
            ...user.usage,
            dailyCallCount: 0,
            lastCallDate: null,
            dailyHintCount: 0,
            lastHintDate: null,
            dailySentCount: 0,
            lastSentDate: null,
            dailySuggestFollowUpCount: 0,
            lastSuggestFollowUpDate: null,
            dailyAutoFollowUpCount: 0,
            lastAutoFollowUpDate: null,
            assistantCount: 0,
            assistantLastDate: null,
            dailyImageCount: 0,
            lastImageUploadDate: null,
            dailyFileCount: 0,
            lastFileUploadDate: null,
            lastResetDate: new Date()
        };
        await user.save();
        return true;
    }
    return false;
}

// ── Helper to get chat limit message ──
function getChatLimitMessage(tier, limit) {
    if (tier === 'free') return `Daily chat limit reached (10/10). Upgrade to Go (50/day) or Pro (150/day) for more conversations.`;
    if (tier === 'go') return `Daily chat limit reached (50/50). Upgrade to Pro for 150 chats per day.`;
    return `Daily chat limit reached (150/150). Please continue tomorrow.`;
}

// ── Helper to get hint limit message ──
function getHintLimitMessage(tier, limit) {
    if (tier === 'free') return `You've used all your free hints (3/3). Upgrade to Go (15/day) or Pro (70/day) for more AI suggestions.`;
    if (tier === 'go') return `Daily hint limit reached (15/15). Upgrade to Pro for 70 hints per day.`;
    return `Daily hint limit reached (70/70). Please try again tomorrow.`;
}

// ── Helper to get email send limit message ──
function getSendLimitMessage(tier, limit) {
    if (tier === 'free') return `Daily email send limit reached (5/5). Upgrade to Go (200/day) or Pro (1000/day) to send more emails.`;
    if (tier === 'go') return `Daily email send limit reached (200/200). Upgrade to Pro for 1000 emails per day.`;
    return `Daily email send limit reached (1000/1000). Please try again tomorrow.`;
}

// ── Helper to get assistant limit message ──
function getAssistantLimitMessage(tier, limit) {
    if (tier === 'free') return `Daily assistant limit reached (20/20). Upgrade to Go (70/day) or Pro (200/day) for more assistance.`;
    if (tier === 'go') return `Daily assistant limit reached (70/70). Upgrade to Pro for 200 assistant messages per day.`;
    return `Daily assistant limit reached (200/200). Please try again tomorrow.`;
}

// ── Helper to get follow-up suggestion limit message ──
function getFollowUpLimitMessage(tier, limit) {
    if (tier === 'free') return `Daily follow-up suggestion limit reached (5/5). Upgrade to Go (30/day) or Pro (200/day) for more.`;
    if (tier === 'go') return `Daily follow-up suggestion limit reached (30/30). Upgrade to Pro for 200/day.`;
    return `Daily follow-up suggestion limit reached (200/200). Please try again tomorrow.`;
}

// ── Helper to get auto follow-up limit message ──
function getAutoFollowUpLimitMessage(tier, limit) {
    if (tier === 'free') return `Auto follow-up is not available on the Free plan. Upgrade to Go (15/day) or Pro (100/day).`;
    if (tier === 'go') return `Daily auto follow-up limit reached (15/15). Upgrade to Pro for 100/day.`;
    return `Daily auto follow-up limit reached (100/100). Please try again tomorrow.`;
}

// ── Daily limit for chat/dreams/lead gen ──
const checkDailyLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        if (!user.usage) user.usage = {};

        await resetDailyUsageIfNeeded(user);

        const tier = user.subscriptionTier || 'free';
        const limit = getLimits(tier).chat;
        const used = user.usage.dailyCallCount || 0;

        if (used >= limit) {
            const message = getChatLimitMessage(tier, limit);
            return res.status(429).json({ message });
        }

        user.usage.dailyCallCount = (user.usage.dailyCallCount || 0) + 1;
        user.usage.lastCallDate = new Date();
        await user.save();
        next();
    } catch (err) {
        console.error('❌ Daily limit error:', err);
        res.status(500).json({ message: 'Server Error checking usage limits' });
    }
};

// ── Hint limit middleware ──
const checkHintLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};

        await resetDailyUsageIfNeeded(user);

        const tier = user.subscriptionTier || 'free';
        const limit = getLimits(tier).hints;
        const used = user.usage.dailyHintCount || 0;

        if (used >= limit) {
            const message = getHintLimitMessage(tier, limit);
            return res.status(403).json({ message, redirect: '/dashboard' });
        }

        user.usage.dailyHintCount = (user.usage.dailyHintCount || 0) + 1;
        user.usage.lastHintDate = new Date();
        await user.save();

        req.remainingHints = limit - user.usage.dailyHintCount;
        next();
    } catch (err) {
        console.error('❌ Hint limit error:', err);
        res.status(500).json({ message: 'Server error checking hint limit' });
    }
};

// ── Email send limit ──
const checkAndIncrementSendLimit = async (userId) => {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');
    if (!user.usage) user.usage = {};

    await resetDailyUsageIfNeeded(user);

    const tier = user.subscriptionTier || 'free';
    const limit = getLimits(tier).emails;
    const used = user.usage.dailySentCount || 0;

    if (used >= limit) {
        const message = getSendLimitMessage(tier, limit);
        throw new Error(message);
    }

    user.usage.dailySentCount = (user.usage.dailySentCount || 0) + 1;
    user.usage.lastSentDate = new Date();
    await user.save();

    return { remaining: limit - user.usage.dailySentCount };
};

// ── Suggest follow-up limit ──
const checkSuggestFollowUpLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};

        await resetDailyUsageIfNeeded(user);

        const tier = user.subscriptionTier || 'free';
        const limit = getLimits(tier).followUp;
        const used = user.usage.dailySuggestFollowUpCount || 0;

        if (used >= limit) {
            const message = getFollowUpLimitMessage(tier, limit);
            return res.status(429).json({ message });
        }

        user.usage.dailySuggestFollowUpCount = (user.usage.dailySuggestFollowUpCount || 0) + 1;
        user.usage.lastSuggestFollowUpDate = new Date();
        await user.save();

        next();
    } catch (err) {
        console.error('❌ Follow-up limit error:', err);
        res.status(500).json({ message: 'Server error checking follow-up limit' });
    }
};

// ── Auto follow-up limit ──
const checkAutoFollowUpLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};

        await resetDailyUsageIfNeeded(user);

        const tier = user.subscriptionTier || 'free';
        const limit = getLimits(tier).autoFollowUp;

        if (limit === 0) {
            return res.status(403).json({
                message: 'Auto follow-up is not available on the Free plan. Upgrade to Go (15/day) or Pro (100/day).'
            });
        }

        const used = user.usage.dailyAutoFollowUpCount || 0;

        if (used >= limit) {
            const message = getAutoFollowUpLimitMessage(tier, limit);
            return res.status(429).json({ message });
        }

        user.usage.dailyAutoFollowUpCount = (user.usage.dailyAutoFollowUpCount || 0) + 1;
        user.usage.lastAutoFollowUpDate = new Date();
        await user.save();

        next();
    } catch (err) {
        console.error('❌ Auto follow-up limit error:', err);
        res.status(500).json({ message: 'Server error checking auto follow-up limit' });
    }
};

// ── Assistant limit middleware ──
const checkAssistantLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};

        await resetDailyUsageIfNeeded(user);

        const tier = user.subscriptionTier || 'free';
        const limit = getLimits(tier).assistant;
        const used = user.usage.assistantCount || 0;

        if (used >= limit) {
            const message = getAssistantLimitMessage(tier, limit);
            return res.status(429).json({ message });
        }

        user.usage.assistantCount = (user.usage.assistantCount || 0) + 1;
        user.usage.assistantLastDate = new Date();
        await user.save();

        req.assistantRemaining = limit - user.usage.assistantCount;
        next();
    } catch (err) {
        console.error('❌ Assistant limit error:', err);
        res.status(500).json({ message: 'Server error checking assistant limit' });
    }
};

// ── Image upload limit ──
const checkImageLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};

        await resetDailyUsageIfNeeded(user);

        const tier = user.subscriptionTier || 'free';
        const limit = getLimits(tier).images;

        if (limit === 0) {
            return res.status(403).json({
                message: 'Image upload is not available on the Free plan. Upgrade to Go (5/day) or Pro (20/day).'
            });
        }

        const used = user.usage.dailyImageCount || 0;

        if (used >= limit) {
            const messages = {
                go: 'Daily image upload limit reached (5/5). Upgrade to Pro for 20/day.',
                pro: 'Daily image upload limit reached (20/20). Please try again tomorrow.'
            };
            return res.status(429).json({ message: messages[tier] || messages.go });
        }

        user.usage.dailyImageCount = (user.usage.dailyImageCount || 0) + 1;
        user.usage.lastImageUploadDate = new Date();
        await user.save();

        next();
    } catch (err) {
        console.error('❌ Image limit error:', err);
        res.status(500).json({ message: 'Server error checking image limit' });
    }
};

// ── File upload limit ──
const checkFileLimit = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        if (!user.usage) user.usage = {};

        await resetDailyUsageIfNeeded(user);

        const tier = user.subscriptionTier || 'free';
        const limit = getLimits(tier).files;

        if (limit === 0) {
            return res.status(403).json({
                message: 'File upload is not available on the Free plan. Upgrade to Go (5/day) or Pro (20/day).'
            });
        }

        const used = user.usage.dailyFileCount || 0;

        if (used >= limit) {
            const messages = {
                go: 'Daily file upload limit reached (5/5). Upgrade to Pro for 20/day.',
                pro: 'Daily file upload limit reached (20/20). Please try again tomorrow.'
            };
            return res.status(429).json({ message: messages[tier] || messages.go });
        }

        user.usage.dailyFileCount = (user.usage.dailyFileCount || 0) + 1;
        user.usage.lastFileUploadDate = new Date();
        await user.save();

        next();
    } catch (err) {
        console.error('❌ File limit error:', err);
        res.status(500).json({ message: 'Server error checking file limit' });
    }
};

module.exports = {
    LIMITS,
    getLimits,
    resetDailyUsageIfNeeded,
    checkDailyLimit,
    checkHintLimit,
    checkAndIncrementSendLimit,
    checkSuggestFollowUpLimit,
    checkAutoFollowUpLimit,
    checkAssistantLimit,
    checkImageLimit,
    checkFileLimit
};
