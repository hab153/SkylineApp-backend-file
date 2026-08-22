// ============================================================
// composeController.js — Skyline AA-1 Compose Email Logic
// NEW FILE — Handles sending emails from the Compose button
// ============================================================

const Lead = require('./Lead');
const EmailAccount = require('./EmailAccount');
const { sendEmail } = require('./nylasService');
const { isValidObjectId } = require('./sanitize');
const { checkAndIncrementSendLimit } = require('./dailyLimitMiddleware');

// ─── VALIDATION FUNCTIONS ───

function validateEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const trimmed = email.trim();
    if (trimmed.length === 0 || trimmed.length > 254) return false;
    if (!trimmed.includes('@')) return false;
    const parts = trimmed.split('@');
    if (parts.length !== 2) return false;
    if (parts[0].length === 0 || parts[1].length === 0) return false;
    if (parts[1].length > 253) return false;
    return true;
}

function sanitizeInput(text, maxLength) {
    if (!text || typeof text !== 'string') return '';
    return text.trim().slice(0, maxLength || 2000);
}

// ─── FIND OR CREATE LEAD ───

async function findOrCreateLead(userId, email, name) {
    // Try to find existing lead by email
    let lead = await Lead.findOne({ 
        userId: userId, 
        email: { $regex: new RegExp('^' + email + '$', 'i') } 
    });

    if (!lead) {
        // Create new lead
        const displayName = name || email.split('@')[0] || 'Unknown';
        lead = new Lead({
            userId: userId,
            name: displayName,
            email: email,
            company: '',
            status: 'New',
            replies: [],
            lastContactDate: new Date(),
            unreadCount: 0
        });
        await lead.save();
        console.log('✅ [COMPOSE] Created new lead:', lead._id, 'Email:', email);
    }

    return lead;
}

// ─── MAIN: SEND COMPOSE EMAIL ───

exports.sendComposeEmail = async (req, res) => {
    console.log('📧 [COMPOSE] Send compose email called');
    console.log('📝 [COMPOSE] req.userId:', req.userId);
    console.log('📝 [COMPOSE] req.body:', req.body);

    try {
        // ── 1. AUTH CHECK ──
        if (!req.userId || !isValidObjectId(req.userId)) {
            console.log('❌ [COMPOSE] Unauthorized');
            return res.status(401).json({ 
                success: false, 
                error: 'UNAUTHORIZED',
                message: 'Please log in to send emails' 
            });
        }

        const userId = String(req.userId);

        // ── 2. VALIDATE INPUT ──
        const { to, subject, message, name } = req.body;

        if (!to || typeof to !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'INVALID_TO',
                message: 'Please provide a valid recipient email address'
            });
        }

        const cleanEmail = to.trim().toLowerCase();
        if (!validateEmail(cleanEmail)) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_EMAIL_FORMAT',
                message: 'Please provide a valid email address'
            });
        }

        const cleanSubject = sanitizeInput(subject, 200) || 'No Subject';
        const cleanMessage = sanitizeInput(message, 10000);
        
        if (!cleanMessage || cleanMessage.length < 1) {
            return res.status(400).json({
                success: false,
                error: 'EMPTY_MESSAGE',
                message: 'Please write a message to send'
            });
        }

        const leadName = sanitizeInput(name, 100) || cleanEmail.split('@')[0] || 'Unknown';

        // ── 3. CHECK EMAIL ACCOUNT ──
        const emailAccount = await EmailAccount.findOne({ 
            userId: userId, 
            isConnected: true 
        });

        if (!emailAccount) {
            return res.status(401).json({
                success: false,
                error: 'NYLAS_DISCONNECTED',
                message: 'Please connect your email account first'
            });
        }

        // ── 4. CHECK DAILY LIMIT ──
        try {
            await checkAndIncrementSendLimit(userId);
        } catch (limitError) {
            return res.status(429).json({
                success: false,
                error: 'RATE_LIMIT_EXCEEDED',
                message: limitError.message || 'Daily email limit reached. Please try again tomorrow.'
            });
        }

        // ── 5. SEND EMAIL VIA NYLAS ──
        let emailSent = false;
        let emailError = null;
        let threadId = null;
        let messageId = null;

        try {
            const result = await sendEmail(
                userId,
                cleanEmail,
                cleanSubject,
                cleanMessage
            );

            if (result.success) {
                emailSent = true;
                threadId = result.threadId || null;
                messageId = result.messageId || null;
                console.log('✅ [COMPOSE] Email sent successfully to:', cleanEmail);
            } else {
                emailError = result.error || 'Failed to send email';
                console.error('❌ [COMPOSE] Email send failed:', emailError);
            }
        } catch (sendErr) {
            emailError = sendErr.message || 'Error sending email';
            console.error('❌ [COMPOSE] Email send error:', sendErr.message);
        }

        // ── 6. SAVE TO DATABASE ──
        let lead = null;
        let savedLead = false;

        try {
            // Find or create lead
            lead = await findOrCreateLead(userId, cleanEmail, leadName);

            // Add message to lead replies
            if (!lead.replies) lead.replies = [];
            
            lead.replies.push({
                date: new Date(),
                content: cleanMessage,
                subject: cleanSubject,
                from: 'lead',
                status: emailSent ? 'sent' : 'pending',
                read: true,
                messageId: messageId || null,
                isCompose: true  // Mark as composed email
            });

            lead.lastContactDate = new Date();
            if (emailSent && lead.status === 'New') {
                lead.status = 'Contacted';
            }

            await lead.save();
            savedLead = true;
            console.log('✅ [COMPOSE] Lead saved:', lead._id);

        } catch (dbErr) {
            console.error('❌ [COMPOSE] Database error:', dbErr.message);
            // Don't fail the whole request if DB save fails but email was sent
            if (!emailSent) {
                return res.status(500).json({
                    success: false,
                    error: 'DB_ERROR',
                    message: 'Failed to save to database. Please try again.'
                });
            }
        }

        // ── 7. SEND SSE EVENT ──
        if (emailSent && lead) {
            try {
                const sseManager = require('./sseManager');
                sseManager.notifyUser(userId, {
                    type: 'new_message',
                    leadId: lead._id.toString(),
                    leadName: lead.name || 'Unknown',
                    leadEmail: lead.email || '',
                    fromEmail: '',
                    subject: cleanSubject,
                    content: cleanMessage,
                    snippet: cleanMessage.substring(0, 200),
                    date: new Date().toISOString(),
                    messageId: messageId || '',
                    sent: true,
                    isCompose: true
                });
                console.log('📡 [COMPOSE] SSE event sent to user', userId);
            } catch (sseErr) {
                console.warn('⚠️ [COMPOSE] SSE error:', sseErr.message);
            }
        }

        // ── 8. RESPONSE ──
        if (emailSent) {
            return res.status(200).json({
                success: true,
                message: 'Email sent successfully',
                leadId: lead ? lead._id.toString() : null,
                threadId: threadId,
                messageId: messageId,
                isNewLead: lead ? lead.createdAt && new Date() - new Date(lead.createdAt) < 10000 : false
            });
        } else {
            return res.status(500).json({
                success: false,
                error: 'SEND_FAILED',
                message: emailError || 'Failed to send email. Please try again.'
            });
        }

    } catch (error) {
        console.error('❌ [COMPOSE] Fatal error:', error.message);
        console.error('❌ [COMPOSE] Stack:', error.stack);
        
        return res.status(500).json({
            success: false,
            error: 'SERVER_ERROR',
            message: 'An unexpected error occurred. Please try again.'
        });
    }
};

// ─── GET LEAD SUGGESTIONS (AUTOCOMPLETE) ───

exports.getLeadSuggestions = async (req, res) => {
    console.log('🔍 [COMPOSE] Getting lead suggestions');
    console.log('📝 [COMPOSE] req.userId:', req.userId);
    console.log('📝 [COMPOSE] req.query:', req.query);

    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ 
                success: false, 
                error: 'UNAUTHORIZED',
                message: 'Please log in' 
            });
        }

        const userId = String(req.userId);
        const query = req.query.q || '';
        const limit = parseInt(req.query.limit) || 10;

        // Find leads matching the query
        const leads = await Lead.find({
            userId: userId,
            $or: [
                { email: { $regex: query, $options: 'i' } },
                { name: { $regex: query, $options: 'i' } }
            ]
        })
        .select('name email company')
        .limit(limit)
        .lean()
        .exec();

        // Also get unique emails from replies
        const replyEmails = await Lead.aggregate([
            { $match: { userId: userId } },
            { $unwind: '$replies' },
            { $match: { 'replies.from': 'customer' } },
            { $group: { _id: '$replies.email' } },
            { $limit: limit }
        ]);

        const suggestions = leads.map(lead => ({
            id: lead._id.toString(),
            name: lead.name || 'Unknown',
            email: lead.email || '',
            company: lead.company || '',
            type: 'lead'
        }));

        // Add unique emails from replies
        replyEmails.forEach(item => {
            if (item._id && !suggestions.some(s => s.email === item._id)) {
                suggestions.push({
                    id: null,
                    name: item._id.split('@')[0] || 'Unknown',
                    email: item._id,
                    company: '',
                    type: 'reply'
                });
            }
        });

        // Filter by query
        const filtered = suggestions.filter(s => 
            s.email.toLowerCase().includes(query.toLowerCase()) ||
            s.name.toLowerCase().includes(query.toLowerCase())
        );

        res.json({
            success: true,
            suggestions: filtered.slice(0, limit)
        });

    } catch (error) {
        console.error('❌ [COMPOSE] Suggestions error:', error.message);
        res.status(500).json({
            success: false,
            error: 'SERVER_ERROR',
            message: 'Failed to load suggestions'
        });
    }
};

// ─── GET RECENT LEADS FOR QUICK SELECT ───

exports.getRecentLeads = async (req, res) => {
    console.log('📋 [COMPOSE] Getting recent leads');
    console.log('📝 [COMPOSE] req.userId:', req.userId);

    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ 
                success: false, 
                error: 'UNAUTHORIZED',
                message: 'Please log in' 
            });
        }

        const userId = String(req.userId);
        const limit = parseInt(req.query.limit) || 5;

        const leads = await Lead.find({ userId: userId })
            .select('name email company')
            .sort({ lastContactDate: -1 })
            .limit(limit)
            .lean()
            .exec();

        res.json({
            success: true,
            leads: leads.map(lead => ({
                id: lead._id.toString(),
                name: lead.name || 'Unknown',
                email: lead.email || '',
                company: lead.company || ''
            }))
        });

    } catch (error) {
        console.error('❌ [COMPOSE] Recent leads error:', error.message);
        res.status(500).json({
            success: false,
            error: 'SERVER_ERROR',
            message: 'Failed to load recent leads'
        });
    }
};
