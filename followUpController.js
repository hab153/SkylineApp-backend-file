// followUpController.js
const Lead = require('./Lead');
const User = require('./User');
const { generateFollowUpSuggestion } = require('./followUpAI');
const { isValidObjectId, sanitizeObject } = require('./sanitize');

/**
 * ✅ FIX #68, #69: ZERO regex, ZERO entity decoding.
 * Just truncate to safe length. Content is stored as plain text in MongoDB
 * and sent to AI as plain text. Never rendered as raw HTML.
 */
function sanitizeMessageContent(content) {
    if (!content || typeof content !== 'string') return '';
    return content.substring(0, 500);
}

/**
 * ✅ FIX #7: Structured logger — only fixed event labels + numeric/boolean metadata.
 * No free-form strings, no regex, no string manipulation.
 */
function safeLog(event, meta) {
    if (!meta || typeof meta !== 'object') {
        console.log('[FOLLOW-UP]', event);
        return;
    }
    const safe = {};
    for (const k of Object.keys(meta)) {
        const v = meta[k];
        if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
            safe[k] = v;
        }
    }
    console.log('[FOLLOW-UP]', event, JSON.stringify(safe));
}

// POST /api/leads/:leadId/auto-follow-up
const toggleAutoFollowUp = async (req, res) => {
    try {
        const { leadId } = req.params;
        let { enabled, delayDays } = req.body;

        safeLog('toggle_auto_follow_up', { enabled: enabled, delayDays: delayDays });

        if (!leadId || !isValidObjectId(leadId)) {
            return res.status(400).json({ success: false, message: 'Invalid lead ID' });
        }
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ success: false, message: 'Enabled must be a boolean' });
        }

        delayDays = (delayDays && typeof delayDays === 'number' && delayDays > 0) ? Math.floor(delayDays) : 3;
        if (delayDays > 30) delayDays = 30;

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

            safeLog('auto_follow_up_enabled', { delayDays: delayDays });

            return res.json({
                success: true,
                autoFollowUpEnabled: true,
                followUpScheduledDate: scheduledDate,
                message: 'Auto follow-up enabled. First follow-up scheduled in ' + delayDays + ' day(s).'
            });
        } else {
            lead.autoFollowUpEnabled = false;
            lead.followUpScheduledDate = null;
            await lead.save();

            safeLog('auto_follow_up_disabled');

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

        safeLog('suggest_follow_up');

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

        safeLog('suggestion_generated');

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

        safeLog('get_follow_up_status');

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
