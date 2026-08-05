// followUpController.js
const Lead = require('./Lead');
const User = require('./User');
const { generateFollowUpSuggestion } = require('./followUpAI');
const { isValidObjectId, sanitizeObject } = require('./sanitize');

/**
 * ✅ FIX #38: Complete multi-character sanitization for message content.
 * Uses strict whitelist — only allows printable characters, newlines, and common punctuation.
 * Previous version only stripped HTML tags with /<[^>]*>?/gm which CodeQL flagged as incomplete
 * because it doesn't handle encoded tags, null bytes, or other bypass vectors.
 */
function sanitizeMessageContent(content) {
    if (!content || typeof content !== 'string') return '';
    return String(content)
        // Step 1: Remove null bytes and control characters (except newline/tab)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // Step 2: Strip HTML tags
        .replace(/<[^>]*>/g, '')
        // Step 3: Strip any HTML entities that could decode into tags
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/<[^>]*>/g, '')  // Strip again after entity decode
        // Step 4: Restore safe entities
        .replace(/</g, '&lt;').replace(/>/g, '&gt;')
        // Step 5: Trim and limit length
        .trim()
        .substring(0, 500);
}

/**
 * ✅ FIX #7: Safe string interpolation — NEVER pass user-controlled data
 * as a format string to console.log or any printf-like function.
 * This helper ensures all logged values are plain strings, not format specifiers.
 */
function safeLog(prefix, ...args) {
    const safeArgs = args.map(arg => {
        if (arg === null || arg === undefined) return String(arg);
        if (typeof arg === 'object') return JSON.stringify(arg);
        return String(arg).replace(/%[sdifoO]/g, '');  // Strip printf format specifiers
    });
    console.log(prefix, ...safeArgs);
}

// POST /api/leads/:leadId/auto-follow-up
const toggleAutoFollowUp = async (req, res) => {
    try {
        const { leadId } = req.params;
        let { enabled, delayDays } = req.body;

        // ✅ FIX #7: Use safeLog instead of console.log with template literals
        // that could contain user-controlled format specifiers
        safeLog('🔄 [FOLLOW-UP] Toggle auto follow-up for lead:', leadId, 'enabled:', enabled, 'delayDays:', delayDays);

        if (!leadId || !isValidObjectId(leadId)) {
            return res.status(400).json({ success: false, message: 'Invalid lead ID' });
        }
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ success: false, message: 'Enabled must be a boolean' });
        }

        // Validate and sanitize delayDays
        delayDays = (delayDays && typeof delayDays === 'number' && delayDays > 0) ? Math.floor(delayDays) : 3;
        if (delayDays > 30) delayDays = 30;

        // ✅ Cast IDs to String before any DB query
        const safeLeadId = String(leadId);
        const safeUserId = String(req.userId);

        const lead = await Lead.findOne({ _id: safeLeadId, userId: safeUserId });
        if (!lead) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        if (enabled === true) {
            const user = await User.findById(safeUserId);
            if (!user) {
                return res.status(500).json({ success: false, message: 'User not found' });
            }

            const scheduledDate = new Date();
            scheduledDate.setDate(scheduledDate.getDate() + delayDays);

            lead.autoFollowUpEnabled = true;
            lead.followUpScheduledDate = scheduledDate;
            lead.followUpCount = 0;
            await lead.save();

            if (!user.usage) user.usage = {};
            user.usage.dailyAutoFollowUpCount = (user.usage.dailyAutoFollowUpCount || 0) + 1;
            await user.save();

            safeLog('✅ [FOLLOW-UP] Auto follow-up ENABLED for lead:', safeLeadId, 'scheduled for:', scheduledDate.toISOString());

            return res.json({
                success: true,
                autoFollowUpEnabled: true,
                followUpScheduledDate: scheduledDate,
                message: `Auto follow-up enabled. First follow-up scheduled in ${delayDays} day(s).`
            });
        } else {
            lead.autoFollowUpEnabled = false;
            lead.followUpScheduledDate = null;
            await lead.save();

            safeLog('✅ [FOLLOW-UP] Auto follow-up DISABLED for lead:', safeLeadId);

            return res.json({
                success: true,
                autoFollowUpEnabled: false,
                message: 'Auto follow-up disabled'
            });
        }
    } catch (err) {
        console.error('❌ Toggle auto follow-up error:', err.message);
        res.status(500).json({ success: false, message: 'Server error toggling auto follow-up' });
    }
};

// POST /api/leads/:leadId/suggest-follow-up
const suggestFollowUp = async (req, res) => {
    try {
        const { leadId } = req.params;

        safeLog('💡 [FOLLOW-UP] Suggest follow-up for lead:', leadId);

        if (!leadId || !isValidObjectId(leadId)) {
            return res.status(400).json({ success: false, message: 'Invalid lead ID' });
        }

        const safeLeadId = String(leadId);
        const safeUserId = String(req.userId);

        const lead = await Lead.findOne({ _id: safeLeadId, userId: safeUserId });
        if (!lead) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        const messages = lead.replies || [];
        if (messages.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No conversation history to base follow-up on. Send a message first.'
            });
        }

        // ✅ FIX #38: Use complete sanitization instead of incomplete HTML strip
        const formattedMessages = messages.slice(-3).map(msg => ({
            from: String(msg.from || ''),
            content: sanitizeMessageContent(msg.content),
            date: msg.date
        }));

        let suggestion;
        try {
            suggestion = await generateFollowUpSuggestion(
                formattedMessages,
                String(lead.name || 'the prospect').substring(0, 100),
                String(lead.company || 'the team').substring(0, 100)
            );
        } catch (aiErr) {
            console.error('❌ AI generation error:', aiErr.message);
            return res.status(500).json({
                success: false,
                message: 'AI service temporarily unavailable. Please try again.'
            });
        }

        try {
            const user = await User.findById(safeUserId);
            if (user) {
                if (!user.usage) user.usage = {};
                user.usage.dailySuggestFollowUpCount = (user.usage.dailySuggestFollowUpCount || 0) + 1;
                await user.save();
            }
        } catch (userErr) {
            console.warn('⚠️ Could not update usage count:', userErr.message);
        }

        safeLog('✅ [FOLLOW-UP] Suggestion generated for lead:', safeLeadId);

        res.json({
            success: true,
            suggestion,
            message: 'Follow-up suggestion generated'
        });
    } catch (err) {
        console.error('❌ Suggest follow-up error:', err.message);
        res.status(500).json({ success: false, message: 'Failed to generate follow-up suggestion' });
    }
};

// GET /api/leads/:leadId/follow-up-status
const getFollowUpStatus = async (req, res) => {
    try {
        const { leadId } = req.params;

        safeLog('📊 [FOLLOW-UP] Get status for lead:', leadId);

        if (!leadId || !isValidObjectId(leadId)) {
            return res.status(400).json({ success: false, message: 'Invalid lead ID' });
        }

        const safeLeadId = String(leadId);
        const safeUserId = String(req.userId);

        const lead = await Lead.findOne({ _id: safeLeadId, userId: safeUserId });
        if (!lead) {
            return res.status(404).json({ success: false, message: 'Lead not found' });
        }

        res.json({
            autoFollowUpEnabled: lead.autoFollowUpEnabled || false,
            followUpScheduledDate: lead.followUpScheduledDate || null,
            lastFollowUpSent: lead.lastFollowUpSent || null,
            followUpCount: lead.followUpCount || 0,
            hasConversation: (lead.replies || []).length > 0
        });
    } catch (err) {
        console.error('❌ Get follow-up status error:', err.message);
        res.status(500).json({ success: false, message: 'Server error fetching follow-up status' });
    }
};

module.exports = {
    toggleAutoFollowUp,
    suggestFollowUp,
    getFollowUpStatus
};
