const Lead = require('./Lead');
const ChatMessage = require('./ChatMessage');
const { sendEmail, getThreads } = require('./nylasService');
const { isValidObjectId, sanitizeQuery, sanitizeObject, sanitizeEmail } = require('./sanitize');
const { checkAndIncrementSendLimit } = require('./dailyLimitMiddleware');

// ─── ✅ COMPLETE EMAIL SANITIZATION FUNCTIONS ───

/**
 * Sanitize email subject - Remove CRLF to prevent header injection
 */
function sanitizeEmailSubject(subject) {
    if (!subject || typeof subject !== 'string') return '';
    return String(subject)
        .replace(/[\r\n\t\0]/g, ' ')
        .trim()
        .substring(0, 200);
}

/**
 * Sanitize email body - Keep newlines but remove carriage returns and null bytes
 */
function sanitizeEmailBody(body) {
    if (!body || typeof body !== 'string') return '';
    return String(body)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\0/g, '')
        .trim();
}

/**
 * ✅ FIX #39: Complete multi-character email sanitization.
 * Uses strict whitelist — only allows valid email characters.
 * Previous version only removed \r\n and <> which CodeQL flagged as incomplete.
 */
function sanitizeEmailAddress(email) {
    if (!email || typeof email !== 'string') return '';
    // Step 1: Strip all characters not in the email-safe whitelist
    let sanitized = email.replace(/[^\w@.\-+]/g, '');
    // Step 2: Validate basic structure
    if (!sanitized || !sanitized.includes('@') || sanitized.length > 254) return '';
    // Step 3: Lowercase
    return sanitized.toLowerCase().trim();
}

/**
 * Sanitize name for email - Remove control characters with complete whitelist
 */
function sanitizeEmailName(name) {
    if (!name || typeof name !== 'string') return '';
    // ✅ FIX #39: Use whitelist instead of blacklist for complete sanitization
    return String(name)
        .replace(/[^\w\s.\-']/g, '')  // Only allow word chars, spaces, dots, hyphens, apostrophes
        .replace(/[\r\n\t\0]/g, ' ')
        .trim()
        .substring(0, 100);
}

/**
 * Sanitize lead data for email sending
 */
function sanitizeLeadForEmail(leadData) {
    return {
        name: sanitizeEmailName(leadData.name),
        email: sanitizeEmailAddress(leadData.email),
        company: sanitizeEmailName(leadData.company || ''),
        messages: (leadData.messages || []).map(msg => ({
            subject: sanitizeEmailSubject(msg.subject || ''),
            body: sanitizeEmailBody(msg.body || '')
        }))
    };
}

// ─── IDEMPOTENCY CACHE ───
const idempotencyCache = new Map();
const IDEMPOTENCY_TTL = 5 * 60 * 1000;

function generateIdempotencyKey(userId, leadId, action, email) {
    return `${String(userId)}:${String(leadId || email || '')}:${String(action)}`;
}

function cleanupIdempotencyCache() {
    const now = Date.now();
    for (const [key, value] of idempotencyCache.entries()) {
        if (now - value.timestamp > IDEMPOTENCY_TTL) {
            idempotencyCache.delete(key);
        }
    }
}

setInterval(cleanupIdempotencyCache, 60 * 1000);

// ──────────────────────────────────────────────────────────────
//  GET /api/conversations
// ──────────────────────────────────────────────────────────────
const getConversations = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        // ✅ Cast userId to String before any DB query
        const safeUserId = String(req.userId);

        const leads = await Lead.find({ userId: safeUserId })
            .sort({ lastContactDate: -1 })
            .limit(100);

        const conversations = leads.map(lead => {
            const replies = lead.replies || [];
            const lastReply = replies.length > 0 ? replies[replies.length - 1] : null;
            const preview = lastReply
                ? String(lastReply.content || '').replace(/<[^>]*>?/gm, '').substring(0, 50)
                : "No messages yet";

            const unreadCount = replies.filter(r => r.from === 'lead' && !r.read).length || 0;

            return {
                id: lead._id.toString(),
                name: lead.name || 'Unknown',
                company: lead.company || '',
                email: lead.email || '',
                status: lead.status || 'New',
                lastMessage: preview,
                lastDate: lead.lastContactDate || lead.createdAt,
                unreadCount: unreadCount > 0 ? unreadCount : 0,
                unread: unreadCount > 0,
                autoReplyEnabled: lead.autoReplyEnabled || false,
                autoReplyInstructions: lead.autoReplyInstructions || ''
            };
        });

        res.json(conversations);
    } catch (err) {
        console.error('❌ [getConversations] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  GET /api/conversations/:leadId
// ────────────────────────────────────────────────────────────
const getConversationById = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { leadId } = req.params;

        if (!leadId || !isValidObjectId(leadId)) {
            return res.status(400).json({ success: false, message: 'Invalid lead ID format' });
        }

        // ✅ Cast both IDs to String before any DB query
        const safeUserId = String(req.userId);
        const safeLeadId = String(leadId);

        const lead = await Lead.findOne({ _id: safeLeadId, userId: safeUserId });

        if (!lead) {
            return res.status(404).json({ success: false, message: 'Conversation not found' });
        }

        // Mark replies as read
        if (lead.replies && lead.replies.length > 0) {
            const unreadReplies = lead.replies.filter(r => r.from === 'lead' && !r.read);
            if (unreadReplies.length > 0) {
                await Lead.updateOne(
                    { _id: safeLeadId, userId: safeUserId },
                    { $set: { 'replies.$[elem].read': true } },
                    {
                        arrayFilters: [{ 'elem.from': 'lead', 'elem.read': false }],
                        strict: false
                    }
                );
            }
        }

        let allMessages = lead.replies || [];

        allMessages.sort((a, b) => {
            const dateA = a.date ? new Date(a.date) : new Date(0);
            const dateB = b.date ? new Date(b.date) : new Date(0);
            return dateA - dateB;
        });

        const cleanHistory = allMessages.map(msg => ({
            from: msg.from || 'lead',
            content: msg.content || '',
            subject: msg.subject || '',
            date: msg.date || new Date(),
            messageId: msg.messageId || null,
            read: msg.read || false
        }));

        res.json({
            success: true,
            lead: {
                id: lead._id.toString(),
                name: lead.name || lead.email || 'Unknown',
                email: lead.email || '',
                company: lead.company || '',
                status: lead.status || 'New',
                autoReplyEnabled: lead.autoReplyEnabled || false,
                autoReplyInstructions: lead.autoReplyInstructions || ''
            },
            messages: cleanHistory
        });

    } catch (err) {
        console.error('❌ [getConversationById] Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error fetching conversation' });
    }
};

// ─────────────────────────────────────────────────────────────
//  PUT /api/leads/:leadId/rename
// ─────────────────────────────────────────────────────────────
const renameLead = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId) || !isValidObjectId(req.params.leadId)) {
            return res.status(400).json({ message: 'Invalid ID' });
        }

        const { newName } = req.body;
        if (!newName || typeof newName !== 'string' || newName.trim() === '') {
            return res.status(400).json({ message: 'New name is required' });
        }

        const safeUserId = String(req.userId);
        const safeLeadId = String(req.params.leadId);
        const sanitizedNewName = newName.trim().slice(0, 100);

        const lead = await Lead.findOne({ _id: safeLeadId, userId: safeUserId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        lead.name = sanitizedNewName;
        await lead.save();

        res.json({ success: true, newName: lead.name });
    } catch (err) {
        console.error('❌ [renameLead] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  PUT /api/leads/:leadId/auto-reply
// ──────────────────────────────────────────────────────────────
const updateAutoReply = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId) || !isValidObjectId(req.params.leadId)) {
            return res.status(400).json({ message: 'Invalid ID' });
        }

        const { enabled, instructions } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ message: 'Enabled must be a boolean' });
        }

        const safeUserId = String(req.userId);
        const safeLeadId = String(req.params.leadId);
        const sanitizedInstructions = instructions ? String(instructions).trim().slice(0, 2000) : '';

        const lead = await Lead.findOne({ _id: safeLeadId, userId: safeUserId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });

        lead.autoReplyEnabled = enabled;
        if (instructions !== undefined) lead.autoReplyInstructions = sanitizedInstructions;
        await lead.save();

        res.json({ success: true, enabled: lead.autoReplyEnabled, instructions: lead.autoReplyInstructions });
    } catch (err) {
        console.error('❌ [updateAutoReply] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  POST /api/leads/batch-send
// ──────────────────────────────────────────────────────────────
const batchSend = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const safeUserId = String(req.userId);
        const { leads, leadId, allowNewLead = true } = req.body;

        const MAX_BATCH_SIZE = 100;

        if (!Array.isArray(leads)) {
            return res.status(400).json({ success: false, message: 'Leads must be an array' });
        }

        if (leads.length === 0) {
            return res.status(400).json({ success: false, message: 'At least one lead is required' });
        }

        if (leads.length > MAX_BATCH_SIZE) {
            return res.status(400).json({
                success: false,
                message: `Batch size exceeds maximum limit of ${MAX_BATCH_SIZE} leads.`,
                maxAllowed: MAX_BATCH_SIZE,
                sentCount: leads.length
            });
        }

        const sanitizedLeads = leads.map(lead => sanitizeLeadForEmail(lead));

        try {
            await checkAndIncrementSendLimit(safeUserId);
        } catch (limitError) {
            return res.status(429).json({
                success: false,
                message: limitError.message,
                limitReached: true
            });
        }

        const EmailAccount = require('./EmailAccount');
        let account = await EmailAccount.findOne({ userId: safeUserId, isConnected: true });

        if (!account) {
            return res.status(401).json({
                success: false,
                error: 'NYLAS_DISCONNECTED',
                message: 'Please connect your email account first.'
            });
        }

        // Token refresh logic
        let tokenValid = true;
        try {
            const now = new Date();
            const tokenExpiry = new Date(account.tokenExpiry);
            const timeUntilExpiry = (tokenExpiry - now) / 1000;

            if (timeUntilExpiry < 300) {
                let refreshAttempts = 0;
                const MAX_REFRESH_ATTEMPTS = 3;
                let refreshed = false;

                while (refreshAttempts < MAX_REFRESH_ATTEMPTS && !refreshed) {
                    try {
                        refreshAttempts++;
                        const { refreshNylasToken } = require('./nylasService');
                        const newToken = await refreshNylasToken(safeUserId);

                        if (newToken && newToken.accessToken) {
                            refreshed = true;
                            account = await EmailAccount.findOne({ userId: safeUserId, isConnected: true });
                        }
                    } catch (refreshErr) {
                        if (refreshAttempts < MAX_REFRESH_ATTEMPTS) {
                            const waitTime = Math.min(1000 * Math.pow(2, refreshAttempts - 1), 5000);
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                        }
                    }
                }

                if (!refreshed) {
                    tokenValid = false;
                }
            }
        } catch (err) {
            tokenValid = false;
        }

        // CASE 1: Sending to an EXISTING lead
        if (leadId) {
            if (!isValidObjectId(leadId)) {
                return res.status(400).json({ success: false, message: 'Invalid lead ID' });
            }

            // ✅ FIX #26: Cast leadId to String before DB query
            const safeLeadId = String(leadId);

            const idempotencyKey = generateIdempotencyKey(safeUserId, safeLeadId, 'batchSend', null);
            const cached = idempotencyCache.get(idempotencyKey);
            if (cached) {
                return res.json({
                    success: true,
                    alreadyProcessed: true,
                    message: 'Email was already sent',
                    leadId: safeLeadId
                });
            }

            // ✅ FIX #26: Use safeLeadId and safeUserId in query
            const targetLead = await Lead.findOne({ _id: safeLeadId, userId: safeUserId });

            if (!targetLead) {
                return res.status(404).json({
                    success: false,
                    error: 'LEAD_NOT_FOUND',
                    message: 'Conversation not found.'
                });
            }

            const leadData = sanitizedLeads[0];
            const msgContent = leadData.messages[0].body;
            const msgSubject = leadData.messages[0].subject || 'Re: Conversation';
            const now = new Date();

            const lastReply = targetLead.replies && targetLead.replies.length > 0
                ? targetLead.replies[targetLead.replies.length - 1] : null;
            const isDuplicate = lastReply &&
                String(lastReply.content || '') === msgContent &&
                (new Date() - new Date(lastReply.date)) < 5000;

            if (!isDuplicate) {
                if (!targetLead.replies) targetLead.replies = [];
                targetLead.replies.push({
                    date: now,
                    content: msgContent,
                    subject: msgSubject,
                    from: 'lead',
                    status: 'sent',
                    read: true
                });
                targetLead.lastContactDate = now;
                targetLead.status = 'Contacted';
            }

            let emailSent = false;
            let emailError = null;
            let threadId = null;

            if (account) {
                let sendAttempts = 0;
                const MAX_SEND_ATTEMPTS = 2;

                while (sendAttempts < MAX_SEND_ATTEMPTS && !emailSent) {
                    try {
                        sendAttempts++;
                        const result = await sendEmail(
                            safeUserId,
                            targetLead.email,
                            msgSubject,
                            msgContent
                        );

                        if (result.success) {
                            emailSent = true;
                            threadId = result.threadId;
                            if (threadId) targetLead.threadId = threadId;
                        } else {
                            emailError = result.error || 'Email send failed';
                            if (sendAttempts < MAX_SEND_ATTEMPTS) {
                                await new Promise(resolve => setTimeout(resolve, 1000 * sendAttempts));
                            }
                        }
                    } catch (sendErr) {
                        emailError = sendErr.message;
                        if (sendAttempts < MAX_SEND_ATTEMPTS) {
                            await new Promise(resolve => setTimeout(resolve, 1000 * sendAttempts));
                        }
                    }
                }
            }

            await targetLead.save();

            if (emailSent) {
                idempotencyCache.set(idempotencyKey, {
                    timestamp: Date.now(),
                    leadId: targetLead._id,
                    success: true
                });
            }

            return res.json({
                success: true,
                message: emailSent ? 'Email sent successfully.' : 'Message saved but email not sent.',
                leadId: targetLead._id.toString(),
                emailSent,
                emailError: emailError || null,
                threadId: threadId || null,
                tokenRefreshed: tokenValid
            });

        // CASE 2: Creating NEW leads and sending
        } else {
            if (allowNewLead === false) {
                return res.status(400).json({ success: false, error: 'NEW_LEAD_NOT_ALLOWED' });
            }

            let results = [];
            let anyFailed = false;

            for (const leadData of sanitizedLeads) {
                const now = new Date();
                const leadEmail = leadData.email;

                const idempotencyKey = generateIdempotencyKey(safeUserId, null, 'createSend', leadEmail);
                const cached = idempotencyCache.get(idempotencyKey);
                if (cached) {
                    results.push({
                        email: leadEmail,
                        name: leadData.name,
                        success: true,
                        alreadyProcessed: true,
                        message: 'Email was already sent'
                    });
                    continue;
                }

                // ✅ FIX #26: Use safeUserId in all queries
                let lead = await Lead.findOne({ userId: safeUserId, email: leadEmail });

                if (lead) {
                    const lastReply = lead.replies?.[lead.replies.length - 1];
                    if (lastReply && String(lastReply.content || '') === leadData.messages[0].body) {
                        results.push({
                            email: leadEmail,
                            name: leadData.name,
                            success: true,
                            alreadyProcessed: true,
                            message: 'Email already sent'
                        });
                        continue;
                    }

                    await Lead.findOneAndUpdate(
                        { _id: String(lead._id), userId: safeUserId },
                        {
                            $set: {
                                status: 'Contacted',
                                lastContactDate: now
                            },
                            $push: {
                                replies: {
                                    date: now,
                                    content: leadData.messages[0].body,
                                    subject: leadData.messages[0].subject || 'Hello from Skyline',
                                    from: 'lead',
                                    status: 'sent',
                                    read: true
                                }
                            }
                        }
                    );
                } else {
                    lead = new Lead({
                        userId: safeUserId,
                        name: leadData.name || leadData.company || 'Unknown',
                        email: leadEmail,
                        company: leadData.company || '',
                        status: 'Contacted',
                        lastContactDate: now,
                        replies: [{
                            date: now,
                            content: leadData.messages[0].body,
                            subject: leadData.messages[0].subject || 'Hello from Skyline',
                            from: 'lead',
                            status: 'sent',
                            read: true
                        }]
                    });
                }

                let emailSent = false;
                let emailError = null;

                if (account && leadEmail) {
                    let sendAttempts = 0;
                    const MAX_SEND_ATTEMPTS = 2;

                    while (sendAttempts < MAX_SEND_ATTEMPTS && !emailSent) {
                        try {
                            sendAttempts++;
                            const result = await sendEmail(
                                safeUserId,
                                leadEmail,
                                leadData.messages[0].subject || 'Hello from Skyline',
                                leadData.messages[0].body
                            );

                            if (result.success) {
                                emailSent = true;
                                if (result.threadId) lead.threadId = result.threadId;
                            } else {
                                emailError = result.error || 'Email send failed';
                                if (sendAttempts < MAX_SEND_ATTEMPTS) {
                                    await new Promise(resolve => setTimeout(resolve, 1000 * sendAttempts));
                                }
                            }
                        } catch (sendErr) {
                            emailError = sendErr.message;
                            if (sendAttempts < MAX_SEND_ATTEMPTS) {
                                await new Promise(resolve => setTimeout(resolve, 1000 * sendAttempts));
                            }
                        }
                    }
                } else {
                    emailError = 'No email account or missing lead email';
                    anyFailed = true;
                }

                await lead.save();

                if (emailSent) {
                    idempotencyCache.set(idempotencyKey, {
                        timestamp: Date.now(),
                        leadId: lead._id,
                        success: true
                    });
                }

                results.push({
                    leadId: lead._id,
                    email: leadEmail,
                    sent: emailSent,
                    error: emailError
                });
            }

            return res.json({
                success: !anyFailed,
                message: anyFailed ? 'Some emails failed to send.' : 'All emails sent successfully.',
                results,
                tokenRefreshed: tokenValid
            });
        }

    } catch (err) {
        console.error('💥 [BE-BATCH] Fatal Error:', err.message);
        res.status(500).json({ message: 'Server Error during batch send' });
    }
};

// ──────────────────────────────────────────────────────────────
//  POST /api/reconnect-and-send
// ──────────────────────────────────────────────────────────────
const reconnectAndSend = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const safeUserId = String(req.userId);
        const EmailAccount = require('./EmailAccount');
        const account = await EmailAccount.findOne({ userId: safeUserId, isConnected: true });

        if (!account) {
            return res.status(401).json({
                success: false,
                error: 'NYLAS_DISCONNECTED',
                message: 'Please connect your email account first.'
            });
        }

        const leadsWithPending = await Lead.find({ userId: safeUserId, 'replies.status': 'pending' });
        let sentCount = 0;

        for (const lead of leadsWithPending) {
            const pendingMessages = lead.replies.filter(r => r.status === 'pending');

            for (const msg of pendingMessages) {
                const idempotencyKey = generateIdempotencyKey(safeUserId, String(lead._id), 'reconnectSend', null);
                const cached = idempotencyCache.get(idempotencyKey);
                if (cached) continue;

                try {
                    const sanitizedSubject = sanitizeEmailSubject(msg.subject || 'Re: Conversation');
                    const sanitizedBody = sanitizeEmailBody(msg.content || '');

                    const result = await sendEmail(
                        safeUserId,
                        lead.email,
                        sanitizedSubject,
                        sanitizedBody
                    );

                    if (result.success) {
                        msg.status = 'sent';
                        sentCount++;
                        idempotencyCache.set(idempotencyKey, {
                            timestamp: Date.now(),
                            leadId: lead._id,
                            success: true
                        });
                    } else {
                        msg.status = 'failed';
                    }
                } catch (err) {
                    msg.status = 'failed';
                }
            }
            await lead.save();
        }

        res.json({ success: true, sentCount });
    } catch (err) {
        console.error('❌ [reconnectAndSend] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  GET /api/leads
// ─────────────────────────────────────────────────────────────
const getAllLeads = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const safeUserId = String(req.userId);

        const leads = await Lead.find({ userId: safeUserId })
            .sort({ createdAt: -1 });

        res.json(leads);
    } catch (err) {
        console.error('❌ [getAllLeads] Error:', err.message);
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
