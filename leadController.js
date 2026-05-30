const Lead = require('./Lead');
const EmailAccount = require('./EmailAccount');
const { refreshNylasToken } = require('./nylasTokenRefresh');
const { sendEmail } = require('./nylasService');
const { checkAndIncrementSendLimit } = require('./dailyLimitMiddleware');

// GET /api/conversations
const getConversations = async (req, res) => {
    try {
        const leads = await Lead.find({ userId: req.userId }).sort({ lastContactDate: -1 }).limit(50);
        const conversations = leads.map(lead => {
            const lastReply = lead.replies?.length > 0 ? lead.replies[lead.replies.length - 1] : null;
            const preview = lastReply
                ? lastReply.content.replace(/<[^>]*>?/gm, '').substring(0, 50)
                : "No messages yet";
            return {
                id: lead._id,
                name: lead.name,
                company: lead.company,
                email: lead.email,
                status: lead.status,
                lastMessage: preview,
                lastDate: lead.lastContactDate,
                unread: !lastReply || lastReply.from === 'lead',
                autoReplyEnabled: lead.autoReplyEnabled
            };
        });
        res.json(conversations);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// GET /api/conversations/:leadId
const getConversationById = async (req, res) => {
    try {
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Conversation not found' });
        const cleanHistory = (lead.replies || []).map(msg => ({
            ...msg.toObject(),
            content: msg.content.replace(/<[^>]*>?/gm, '')
        }));
        res.json({
            lead: {
                id: lead._id,
                name: lead.name,
                email: lead.email,
                company: lead.company,
                status: lead.status,
                autoReplyEnabled: lead.autoReplyEnabled,
                autoReplyInstructions: lead.autoReplyInstructions
            },
            messages: cleanHistory
        });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// PUT /api/leads/:leadId/rename
const renameLead = async (req, res) => {
    try {
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        lead.name = req.body.newName;
        await lead.save();
        res.json({ success: true, newName: lead.name });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// PUT /api/leads/:leadId/auto-reply
const updateAutoReply = async (req, res) => {
    try {
        const { enabled, instructions } = req.body;
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        lead.autoReplyEnabled = enabled;
        if (instructions !== undefined) lead.autoReplyInstructions = instructions;
        await lead.save();
        res.json({ success: true, enabled: lead.autoReplyEnabled, instructions: lead.autoReplyInstructions });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

// POST /api/leads/batch-send
const batchSend = async (req, res) => {
    try {
        const { leads } = req.body;
        const emailAccount = await EmailAccount.findOne({ userId: req.userId });
        if (!emailAccount) {
            return res.status(401).json({ success: false, error: 'NYLAS_DISCONNECTED', message: 'No connection found.' });
        }

        const isExpired = !emailAccount.tokenExpiry ||
            new Date() > new Date(emailAccount.tokenExpiry.getTime() - 15 * 60 * 1000);
        let currentAccessToken = emailAccount.accessToken;

        if (isExpired) {
            try {
                currentAccessToken = await refreshNylasToken(emailAccount);
            } catch (refreshErr) {
                return res.status(401).json({ success: false, error: 'NYLAS_DISCONNECTED', message: 'Session expired. Please reconnect.' });
            }
        }

        let sentCount = 0;
        let errors = [];
        const now = new Date();

        for (const leadData of leads) {
            // Check send limit before each email
            try {
                await checkAndIncrementSendLimit(req.userId);
            } catch (limitError) {
                errors.push({ email: leadData.email, error: limitError.message });
                continue; // skip this email, do not attempt send
            }

            try {
                let lead = await Lead.findOne({ email: leadData.email, userId: req.userId });
                if (!lead) {
                    lead = new Lead({
                        userId: req.userId,
                        name: leadData.name,
                        email: leadData.email,
                        company: leadData.company,
                        status: 'Contacted',
                        lastContactDate: now,
                        followUpCount: 0
                    });
                } else {
                    lead.status = 'Contacted';
                    lead.lastContactDate = now;
                }

                if (leadData.messages?.length > 0) {
                    if (!lead.replies) lead.replies = [];
                    lead.replies.push({
                        date: now,
                        content: leadData.messages[0].body,
                        subject: leadData.messages[0].subject,
                        from: 'ai',
                        status: 'sent'
                    });
                    lead.followUpCount = (lead.followUpCount || 0) + 1;
                }
                await lead.save();

                if (leadData.messages?.length > 0) {
                    const result = await sendEmail(
                        currentAccessToken,
                        leadData.email,
                        leadData.messages[0].subject,
                        leadData.messages[0].body
                    );
                    if (result.success) {
                        sentCount++;
                        console.log(`✅ Email sent to ${leadData.email}`);
                    } else {
                        lead.status = 'Failed';
                        await lead.save();
                        errors.push({ email: leadData.email, error: result.error });
                    }
                }
            } catch (err) {
                errors.push({ email: leadData.email, error: err.message });
            }
        }
        res.json({ success: true, message: `Sent ${sentCount} emails.`, errors });
    } catch (err) {
        console.error('Batch Send Error:', err);
        res.status(500).json({ message: 'Server Error during batch send' });
    }
};

// POST /api/reconnect-and-send
const reconnectAndSend = async (req, res) => {
    try {
        const emailAccount = await EmailAccount.findOne({ userId: req.userId });
        if (!emailAccount) return res.status(400).json({ message: 'Nylas not connected' });

        let currentAccessToken = emailAccount.accessToken;
        const isExpired = !emailAccount.tokenExpiry ||
            new Date() > new Date(emailAccount.tokenExpiry.getTime() - 15 * 60 * 1000);
        if (isExpired) currentAccessToken = await refreshNylasToken(emailAccount);

        const leadsWithPending = await Lead.find({ userId: req.userId, 'replies.status': 'pending' });
        let sentCount = 0;
        for (const lead of leadsWithPending) {
            const pendingMessages = lead.replies.filter(r => r.status === 'pending');
            for (const msg of pendingMessages) {
                // Check send limit before each email
                try {
                    await checkAndIncrementSendLimit(req.userId);
                } catch (limitError) {
                    console.warn(`Send limit reached, skipping message to ${lead.email}: ${limitError.message}`);
                    continue;
                }

                const result = await sendEmail(
                    currentAccessToken,
                    lead.email,
                    msg.subject || 'Re: Conversation',
                    msg.content
                );
                msg.status = result.success ? 'sent' : 'failed';
                if (result.success) sentCount++;
            }
            await lead.save();
        }
        res.json({ success: true, sentCount });
    } catch (err) {
        console.error('Auto-send Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// GET /api/leads (list all leads – simple version)
const getAllLeads = async (req, res) => {
    try {
        const leads = await Lead.find({ userId: req.userId }).sort({ createdAt: -1 });
        res.json(leads);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
};

module.exports = {
    getConversations,
    getConversationById,
    renameLead,
    updateAutoReply,
    batchSend,
    reconnectAndSend,
    getAllLeads
};
