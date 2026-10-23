const Lead = require('./Lead');
const ChatMessage = require('./ChatMessage');
const User = require('./User');
const { sendEmail, getThreads } = require('./nylasService');
const { isValidObjectId, sanitizeQuery, sanitizeObject, sanitizeEmail } = require('./sanitize');
const { checkAndIncrementSendLimit } = require('./dailyLimitMiddleware');

// ─── ✅ DECRYPTION IMPORT ───
const { decrypt } = require('./encryption');

// ─── ✅ SANITIZATION FUNCTIONS — ZERO REGEX ───

function sanitizeEmailSubject(subject) {
    if (!subject || typeof subject !== 'string') return '';
    let result = '';
    for (let i = 0; i < subject.length && result.length < 200; i++) {
        const c = subject.charCodeAt(i);
        if (c >= 32 && c <= 126) {
            result += subject[i];
        } else if (c === 13 || c === 10 || c === 9) {
            result += ' ';
        }
    }
    return result.trim();
}

function sanitizeEmailBody(body) {
    if (!body || typeof body !== 'string') return '';
    let result = '';
    for (let i = 0; i < body.length; i++) {
        const c = body.charCodeAt(i);
        if (c === 0) continue;
        if (c === 13) {
            result += '\n';
        } else {
            result += body[i];
        }
    }
    return result.trim();
}

function sanitizeEmailAddress(email) {
    if (!email || typeof email !== 'string') return '';
    const trimmed = email.trim();
    if (trimmed.length === 0 || trimmed.length > 254) return '';
    if (!trimmed.includes('@')) return '';
    const parts = trimmed.split('@');
    if (parts.length !== 2) return '';
    if (parts[0].length === 0 || parts[1].length === 0) return '';
    if (parts[1].length > 253) return '';
    return trimmed.toLowerCase();
}

function sanitizeEmailName(name) {
    if (!name || typeof name !== 'string') return '';
    let result = '';
    for (let i = 0; i < name.length && result.length < 100; i++) {
        const c = name.charCodeAt(i);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
            c === 32 || c === 46 || c === 45 || c === 39 || c === 95) {
            result += name[i];
        } else if (c === 13 || c === 10 || c === 9 || c === 0) {
            result += ' ';
        }
    }
    return result.trim();
}

function stripHtmlTags(text) {
    if (!text || typeof text !== 'string') return '';
    let result = '';
    let inTag = false;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '<') {
            inTag = true;
        } else if (text[i] === '>') {
            inTag = false;
        } else if (!inTag) {
            result += text[i];
        }
    }
    return result;
}

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
    return String(userId) + ':' + String(leadId || email || '') + ':' + String(action);
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

// ─── ✅ DECRYPT EMAIL HELPER ───
function decryptEmail(email) {
    if (!email || typeof email !== 'string') return email;
    if (!email.includes('=') && email.length < 20) return email;
    try {
        const decrypted = decrypt(email);
        return decrypted || email;
    } catch (e) {
        return email;
    }
}

// ============================================================
// ✅ UNREAD COUNT HELPER FUNCTIONS
// ============================================================

const incrementUnreadCount = async (leadId, userId) => {
    try {
        const result = await Lead.findOneAndUpdate(
            { _id: leadId, userId: userId },
            { $inc: { unreadCount: 1 } },
            { new: true }
        );
        return result;
    } catch (error) {
        console.error('❌ [incrementUnreadCount] Error:', error.message);
        return null;
    }
};

const resetUnreadCount = async (leadId, userId) => {
    try {
        const result = await Lead.findOneAndUpdate(
            { _id: leadId, userId: userId },
            { $set: { unreadCount: 0 } },
            { new: true }
        );
        return result;
    } catch (error) {
        console.error('❌ [resetUnreadCount] Error:', error.message);
        return null;
    }
};

const getTotalUnreadCount = async (userId) => {
    try {
        const mongoose = require('mongoose');
        const result = await Lead.aggregate([
            { $match: { userId: mongoose.Types.ObjectId(userId) } },
            { $group: { _id: null, totalUnread: { $sum: '$unreadCount' } } }
        ]);
        return result.length > 0 ? result[0].totalUnread : 0;
    } catch (error) {
        console.error('❌ [getTotalUnreadCount] Error:', error.message);
        return 0;
    }
};

// ============================================================
// ✅ SAVED LEADS FUNCTIONS
// ============================================================

const saveLeads = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const { leads } = req.body;
        if (!Array.isArray(leads) || leads.length === 0) {
            return res.status(400).json({ message: 'No leads provided' });
        }

        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const existingEmails = new Set(user.savedLeads.map(l => l.email));
        const existingNames = new Set(user.savedLeads.map(l => l.companyName));

        const newLeads = leads.filter(lead => {
            return !existingEmails.has(lead.email) && !existingNames.has(lead.companyName);
        });

        if (newLeads.length === 0) {
            return res.json({ success: true, message: 'All leads are already saved', count: 0 });
        }

        const leadsToSave = newLeads.map(lead => ({
            ...lead,
            savedAt: new Date()
        }));

        user.savedLeads.push(...leadsToSave);
        await user.save();

        res.json({ 
            success: true, 
            message: `${leadsToSave.length} leads saved successfully`, 
            count: leadsToSave.length 
        });

    } catch (err) {
        console.error('❌ [saveLeads] Error:', err.message);
        res.status(500).json({ message: 'Server Error saving leads' });
    }
};

const deleteLead = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const { email, companyName } = req.body;
        if (!email && !companyName) {
            return res.status(400).json({ message: 'Email or Company Name required to delete' });
        }

        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const initialLength = user.savedLeads.length;
        user.savedLeads = user.savedLeads.filter(lead => {
            if (email) return lead.email !== email;
            if (companyName) return lead.companyName !== companyName;
            return true;
        });

        if (user.savedLeads.length === initialLength) {
            return res.status(404).json({ message: 'Lead not found in saved list' });
        }

        await user.save();
        res.json({ success: true, message: 'Lead deleted successfully' });

    } catch (err) {
        console.error('❌ [deleteLead] Error:', err.message);
        res.status(500).json({ message: 'Server Error deleting lead' });
    }
};

const getSavedLeads = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const user = await User.findById(req.userId).select('savedLeads').lean();
        if (!user) return res.status(404).json({ message: 'User not found' });

        res.json({ success: true, data: user.savedLeads || [] });

    } catch (err) {
        console.error('❌ [getSavedLeads] Error:', err.message);
        res.status(500).json({ message: 'Server Error fetching saved leads' });
    }
};

// ============================================================
// ✅ DRAFTED MESSAGES FUNCTIONS
// ============================================================

// ─── ✅ SAVE DRAFT TO DATABASE ───
const saveDraft = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const { companyName, email, subject, message } = req.body;

        if (!companyName || !email) {
            return res.status(400).json({ message: 'Company name and email are required' });
        }

        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        // Check if draft already exists for this email
        const existingDraftIndex = user.draftedMessages.findIndex(d => d.email === email);

        if (existingDraftIndex !== -1) {
            // Update existing draft
            user.draftedMessages[existingDraftIndex].subject = subject || '';
            user.draftedMessages[existingDraftIndex].message = message || '';
            user.draftedMessages[existingDraftIndex].draftedAt = new Date();
        } else {
            // Add new draft
            user.draftedMessages.push({
                companyName,
                email,
                subject: subject || '',
                message: message || '',
                draftedAt: new Date()
            });
        }

        await user.save();

        res.json({ 
            success: true, 
            message: 'Draft saved successfully' 
        });

    } catch (err) {
        console.error('❌ [saveDraft] Error:', err.message);
        res.status(500).json({ message: 'Server Error saving draft' });
    }
};

// ─── ✅ GET ALL DRAFTS ───
const getDrafts = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const user = await User.findById(req.userId).select('draftedMessages').lean();
        if (!user) return res.status(404).json({ message: 'User not found' });

        res.json({ success: true, data: user.draftedMessages || [] });

    } catch (err) {
        console.error('❌ [getDrafts] Error:', err.message);
        res.status(500).json({ message: 'Server Error fetching drafts' });
    }
};

// ─── ✅ DELETE DRAFT FROM DATABASE ───
const deleteDraft = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ message: 'Email is required to delete draft' });
        }

        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const initialLength = user.draftedMessages.length;
        user.draftedMessages = user.draftedMessages.filter(draft => draft.email !== email);

        if (user.draftedMessages.length === initialLength) {
            return res.status(404).json({ message: 'Draft not found' });
        }

        await user.save();
        res.json({ success: true, message: 'Draft deleted successfully' });

    } catch (err) {
        console.error('❌ [deleteDraft] Error:', err.message);
        res.status(500).json({ message: 'Server Error deleting draft' });
    }
};

// ============================================================
// ✅ CONVERSATIONS
// ============================================================

const getConversations = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const safeUserId = String(req.userId);
        
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 15;
        const skip = (page - 1) * limit;

        const total = await Lead.countDocuments({ userId: safeUserId });

        const leads = await Lead.find({ userId: safeUserId })
            .select('name email company status lastContactDate createdAt replies unreadCount autoReplyEnabled autoReplyInstructions')
            .sort({ lastContactDate: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean()
            .exec();

        const conversations = leads.map(lead => {
            const replies = lead.replies || [];
            const lastReply = replies.length > 0 ? replies[replies.length - 1] : null;
            const rawContent = String(lastReply?.content || '');
            const preview = lastReply
                ? stripHtmlTags(rawContent).substring(0, 50)
                : 'No messages yet';

            const unreadCount = lead.unreadCount || 0;
            let email = decryptEmail(lead.email || '');

            return {
                id: lead._id.toString(),
                name: lead.name || 'Unknown',
                company: lead.company || '',
                email: email,
                status: lead.status || 'New',
                lastMessage: preview,
                lastDate: lead.lastContactDate || lead.createdAt,
                unreadCount: unreadCount,
                unread: unreadCount > 0,
                autoReplyEnabled: lead.autoReplyEnabled || false,
                autoReplyInstructions: lead.autoReplyInstructions || ''
            };
        });

        res.json({
            success: true,
            data: conversations,
            pagination: {
                page: page,
                limit: limit,
                total: total,
                pages: Math.ceil(total / limit),
                hasMore: skip + limit < total
            }
        });

    } catch (err) {
        console.error('❌ [getConversations] Error:', err.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error loading conversations' 
        });
    }
};

const conversationCache = new Map();
const CONVERSATION_CACHE_TTL = 30000;

function getConversationCacheKey(userId, leadId) {
    return String(userId) + ':' + String(leadId);
}

const getConversationById = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { leadId } = req.params;

        if (!leadId || !isValidObjectId(leadId)) {
            return res.status(400).json({ success: false, message: 'Invalid lead ID format' });
        }

        const safeUserId = String(req.userId);
        const safeLeadId = String(leadId);

        await resetUnreadCount(safeLeadId, safeUserId);

        const cacheKey = getConversationCacheKey(safeUserId, safeLeadId);
        const cached = conversationCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < CONVERSATION_CACHE_TTL)) {
            return res.json(cached.data);
        }

        const lead = await Lead.findOne({ _id: safeLeadId, userId: safeUserId })
            .select('name email company status replies lastContactDate autoReplyEnabled autoReplyInstructions unreadCount')
            .lean()
            .exec();

        if (!lead) {
            return res.status(404).json({ success: false, message: 'Conversation not found' });
        }

        let allMessages = lead.replies || [];
        allMessages.sort((a, b) => {
            const dateA = a.date ? new Date(a.date) : new Date(0);
            const dateB = b.date ? new Date(b.date) : new Date(0);
            return dateA - dateB;
        });

        const limitedMessages = allMessages.slice(-100);

        const cleanHistory = limitedMessages.map(msg => ({
            from: msg.from || 'lead',
            content: msg.content || '',
            subject: msg.subject || '',
            date: msg.date || new Date(),
            messageId: msg.messageId || null,
            read: msg.read || false
        }));

        let email = decryptEmail(lead.email || '');

        const result = {
            success: true,
            lead: {
                id: lead._id.toString(),
                name: lead.name || lead.email || 'Unknown',
                email: email,
                company: lead.company || '',
                status: lead.status || 'New',
                autoReplyEnabled: lead.autoReplyEnabled || false,
                autoReplyInstructions: lead.autoReplyInstructions || ''
            },
            messages: cleanHistory,
            totalMessages: allMessages.length,
            displayedMessages: limitedMessages.length
        };

        conversationCache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });

        res.json(result);

    } catch (err) {
        console.error('❌ [getConversationById] Error:', err.message);
        res.status(500).json({ success: false, message: 'Server Error fetching conversation' });
    }
};

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

        const cacheKey = getConversationCacheKey(safeUserId, safeLeadId);
        conversationCache.delete(cacheKey);

        res.json({ success: true, newName: lead.name });
    } catch (err) {
        console.error('❌ [renameLead] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

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
        if (!lead) {
            return res.status(404).json({ message: 'Lead not found' });
        }

        lead.autoReplyEnabled = enabled;
        if (instructions !== undefined) lead.autoReplyInstructions = sanitizedInstructions;
        await lead.save();

        const cacheKey = getConversationCacheKey(safeUserId, safeLeadId);
        conversationCache.delete(cacheKey);

        res.json({ 
            success: true, 
            enabled: lead.autoReplyEnabled, 
            instructions: lead.autoReplyInstructions 
        });

    } catch (err) {
        console.error('❌ [updateAutoReply] Error:', err.message);
        res.status(500).json({ message: 'Server Error' });
    }
};

const getAutoReply = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId) || !isValidObjectId(req.params.leadId)) {
            return res.status(400).json({ message: 'Invalid ID' });
        }

        const safeUserId = String(req.userId);
        const safeLeadId = String(req.params.leadId);

        const lead = await Lead.findOne({ _id: safeLeadId, userId: safeUserId })
            .select('autoReplyEnabled autoReplyInstructions')
            .lean()
            .exec();

        if (!lead) {
            return res.json({ 
                enabled: false, 
                instructions: '' 
            });
        }

        res.json({ 
            enabled: lead.autoReplyEnabled || false, 
            instructions: lead.autoReplyInstructions || '' 
        });

    } catch (err) {
        console.error('❌ [getAutoReply] Error:', err.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error',
            error: err.message 
        });
    }
};

// ──────────────────────────────────────────────────────────────
//  POST /api/leads/batch-send (OPTIMIZED FOR SPEED)
// ──────────────────────────────────────────────────────────────
const batchSend = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const safeUserId = String(req.userId);
        const { leads, leadId, allowNewLead = true } = req.body;

        const MAX_BATCH_SIZE = 100;
        const CONCURRENCY_LIMIT = 5;

        if (!Array.isArray(leads)) {
            return res.status(400).json({ success: false, message: 'Leads must be an array' });
        }

        if (leads.length === 0) {
            return res.status(400).json({ success: false, message: 'At least one lead is required' });
        }

        if (leads.length > MAX_BATCH_SIZE) {
            return res.status(400).json({
                success: false,
                message: 'Batch size exceeds maximum limit of ' + MAX_BATCH_SIZE + ' leads.',
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

        if (leadId) {
            if (!isValidObjectId(leadId)) {
                return res.status(400).json({ success: false, message: 'Invalid lead ID' });
            }
            const safeLeadId = String(leadId);
            const idempotencyKey = generateIdempotencyKey(safeUserId, safeLeadId, 'batchSend', null);
            const cached = idempotencyCache.get(idempotencyKey);
            if (cached) {
                return res.json({ success: true, alreadyProcessed: true, message: 'Email was already sent', leadId: safeLeadId });
            }
            const targetLead = await Lead.findOne({ _id: safeLeadId, userId: safeUserId });
            if (!targetLead) {
                return res.status(404).json({ success: false, error: 'LEAD_NOT_FOUND', message: 'Conversation not found.' });
            }
            const leadData = sanitizedLeads[0];
            const msgContent = leadData.messages[0].body;
            const msgSubject = leadData.messages[0].subject || 'Re: Conversation';
            const now = new Date();
            const lastReply = targetLead.replies && targetLead.replies.length > 0 ? targetLead.replies[targetLead.replies.length - 1] : null;
            const isDuplicate = lastReply && String(lastReply.content || '') === msgContent && (new Date() - new Date(lastReply.date)) < 5000;
            if (!isDuplicate) {
                if (!targetLead.replies) targetLead.replies = [];
                targetLead.replies.push({ date: now, content: msgContent, subject: msgSubject, from: 'lead', status: 'sent', read: true });
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
                        const result = await sendEmail(safeUserId, targetLead.email, msgSubject, msgContent);
                        if (result.success) {
                            emailSent = true;
                            threadId = result.threadId;
                            if (threadId) targetLead.threadId = threadId;
                        } else {
                            emailError = result.error || 'Email send failed';
                            if (sendAttempts < MAX_SEND_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 1000 * sendAttempts));
                        }
                    } catch (sendErr) {
                        emailError = sendErr.message;
                        if (sendAttempts < MAX_SEND_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 1000 * sendAttempts));
                    }
                }
            }
            await targetLead.save();
            await incrementUnreadCount(targetLead._id, safeUserId);
            try {
                const sseManager = require('./sseManager');
                sseManager.sendToUser(safeUserId, { type: 'new_message', leadId: targetLead._id.toString(), leadName: targetLead.name || 'Unknown', message: msgContent, from: 'customer' });
            } catch (sseErr) {}
            const cacheKey = getConversationCacheKey(safeUserId, safeLeadId);
            conversationCache.delete(cacheKey);
            if (emailSent) {
                idempotencyCache.set(idempotencyKey, { timestamp: Date.now(), leadId: targetLead._id, success: true });
            }
            return res.json({ success: true, message: emailSent ? 'Email sent successfully.' : 'Message saved but email not sent.', leadId: targetLead._id.toString(), emailSent, emailError: emailError || null, threadId: threadId || null, tokenRefreshed: tokenValid });

        } else {
            if (allowNewLead === false) {
                return res.status(400).json({ success: false, error: 'NEW_LEAD_NOT_ALLOWED' });
            }

            let results = [];
            
            const processLead = async (leadData) => {
                const now = new Date();
                const leadEmail = leadData.email;
                const idempotencyKey = generateIdempotencyKey(safeUserId, null, 'createSend', leadEmail);
                const cached = idempotencyCache.get(idempotencyKey);
                
                if (cached) {
                    return { email: leadEmail, name: leadData.name, success: true, alreadyProcessed: true, message: 'Email was already sent' };
                }

                let lead = await Lead.findOne({ userId: safeUserId, email: leadEmail });

                if (lead) {
                    const lastReply = lead.replies?.[lead.replies.length - 1];
                    if (lastReply && String(lastReply.content || '') === leadData.messages[0].body) {
                        return { email: leadEmail, name: leadData.name, success: true, alreadyProcessed: true, message: 'Email already sent' };
                    }
                    await Lead.findOneAndUpdate(
                        { _id: String(lead._id), userId: safeUserId },
                        {
                            $set: { status: 'Contacted', lastContactDate: now },
                            $push: { replies: { date: now, content: leadData.messages[0].body, subject: leadData.messages[0].subject || 'Hello from Skyline', from: 'lead', status: 'sent', read: true } }
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
                        replies: [{ date: now, content: leadData.messages[0].body, subject: leadData.messages[0].subject || 'Hello from Skyline', from: 'lead', status: 'sent', read: true }]
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
                            const result = await sendEmail(safeUserId, leadEmail, leadData.messages[0].subject || 'Hello from Skyline', leadData.messages[0].body);
                            if (result.success) {
                                emailSent = true;
                                if (result.threadId) lead.threadId = result.threadId;
                            } else {
                                emailError = result.error || 'Email send failed';
                                if (sendAttempts < MAX_SEND_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 1000 * sendAttempts));
                            }
                        } catch (sendErr) {
                            emailError = sendErr.message;
                            if (sendAttempts < MAX_SEND_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 1000 * sendAttempts));
                        }
                    }
                } else {
                    emailError = 'No email account or missing lead email';
                }

                await lead.save();
                await incrementUnreadCount(lead._id, safeUserId);

                try {
                    const sseManager = require('./sseManager');
                    sseManager.sendToUser(safeUserId, { type: 'new_message', leadId: lead._id.toString(), leadName: lead.name || 'Unknown', message: leadData.messages[0].body, from: 'customer' });
                } catch (sseErr) {}

                if (emailSent) {
                    idempotencyCache.set(idempotencyKey, { timestamp: Date.now(), leadId: lead._id, success: true });
                }

                return { leadId: lead._id, email: leadEmail, sent: emailSent, error: emailError };
            };

            for (let i = 0; i < sanitizedLeads.length; i += CONCURRENCY_LIMIT) {
                const batch = sanitizedLeads.slice(i, i + CONCURRENCY_LIMIT);
                const batchPromises = batch.map(leadData => processLead(leadData));
                const batchResults = await Promise.all(batchPromises);
                results.push(...batchResults);
            }

            const anyFailed = results.some(r => !r.sent && !r.alreadyProcessed);

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

// ──────────────────────────────────────────────────────────────
//  EXPORTS
// ──────────────────────────────────────────────────────────────
module.exports = {
    getConversations,
    getConversationById,
    renameLead,
    updateAutoReply,
    getAutoReply,
    batchSend,
    reconnectAndSend,
    getAllLeads,
    incrementUnreadCount,
    resetUnreadCount,
    getTotalUnreadCount,
    saveLeads,
    deleteLead,
    getSavedLeads,
    saveDraft,      // ✅ New Export
    getDrafts,      // ✅ New Export
    deleteDraft     // ✅ New Export
};
