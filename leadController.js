const Lead = require('./Lead');
const ChatMessage = require('./ChatMessage');
const { sendEmail, getThreads } = require('./nylasService');
const { isValidObjectId, sanitizeQuery, sanitizeObject, sanitizeEmail } = require('./sanitize');
const { checkAndIncrementSendLimit } = require('./dailyLimitMiddleware');

// ─── IDEMPOTENCY CACHE ───
// Store recently processed requests to prevent duplicates
const idempotencyCache = new Map();
const IDEMPOTENCY_TTL = 5 * 60 * 1000; // 5 minutes

// ─── HELPER: Generate idempotency key ───
function generateIdempotencyKey(userId, leadId, action, email) {
    return `${userId}:${leadId || email}:${action}`;
}

// ─── HELPER: Clean up expired idempotency keys ───
function cleanupIdempotencyCache() {
    const now = Date.now();
    for (const [key, value] of idempotencyCache.entries()) {
        if (now - value.timestamp > IDEMPOTENCY_TTL) {
            idempotencyCache.delete(key);
        }
    }
}

// Run cleanup every minute
setInterval(cleanupIdempotencyCache, 60 * 1000);

// ──────────────────────────────────────────────────────────────
//  GET /api/conversations - FIXED (Proper userId filtering)
// ──────────────────────────────────────────────────────────────
const getConversations = async (req, res) => {
    console.log('🔵 [getConversations] ENTERED - userId:', req.userId);
    try {
        if (!req.userId) {
            console.error('❌ [getConversations] No userId in request');
            return res.status(401).json({ message: 'Unauthorized: No user ID' });
        }
        if (!isValidObjectId(req.userId)) {
            console.error('❌ [getConversations] Invalid userId format:', req.userId);
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        console.log(`📡 [getConversations] Fetching leads for userId: ${req.userId}`);
        
        const leads = await Lead.find({ userId: req.userId })
            .sort({ lastContactDate: -1 })
            .limit(100);
            
        console.log(`✅ [getConversations] Found ${leads.length} leads for user ${req.userId}`);
        
        const conversations = leads.map(lead => {
            const replies = lead.replies || [];
            const lastReply = replies.length > 0 ? replies[replies.length - 1] : null;
            const preview = lastReply
                ? lastReply.content.replace(/<[^>]*>?/gm, '').substring(0, 50)
                : "No messages yet";
            
            const unreadCount = replies.filter(r => r.from === 'lead' && !r.read).length || 0;
            const email = lead.email || '';
            
            return {
                id: lead._id.toString(),
                name: lead.name || 'Unknown',
                company: lead.company || '',
                email: email,
                status: lead.status || 'New',
                lastMessage: preview,
                lastDate: lead.lastContactDate || lead.createdAt,
                unreadCount: unreadCount > 0 ? unreadCount : 0,
                unread: unreadCount > 0,
                autoReplyEnabled: lead.autoReplyEnabled || false,
                autoReplyInstructions: lead.autoReplyInstructions || ''
            };
        });
        
        console.log(`📤 [getConversations] Returning ${conversations.length} conversations for user ${req.userId}`);
        res.json(conversations);
    } catch (err) {
        console.error('❌ [getConversations] Error:', err);
        console.error('❌ [getConversations] Error stack:', err.stack);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  GET /api/conversations/:leadId - FIXED ARRAY FILTER ERROR
// ────────────────────────────────────────────────────────────
const getConversationById = async (req, res) => {
    console.log('🔵 [getConversationById] ENTERED - leadId:', req.params.leadId);
    
    try {
        if (!req.userId) {
            console.error('❌ [getConversationById] No userId');
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
        if (!isValidObjectId(req.userId)) {
            console.error('❌ [getConversationById] Invalid userId format');
            return res.status(400).json({ success: false, message: 'Invalid user ID' });
        }
        const { leadId } = req.params;
        
        if (!isValidObjectId(leadId)) {
            console.error('❌ [getConversationById] Invalid leadId format:', leadId);
            return res.status(400).json({ success: false, message: 'Invalid lead ID format' });
        }
        
        console.log(`📡 [getConversationById] Fetching lead ${leadId} for user ${req.userId}`);
        
        const lead = await Lead.findOne({ _id: leadId, userId: req.userId });
        
        if (!lead) {
            console.warn(`⚠️ [getConversationById] Lead not found for leadId: ${leadId}, userId: ${req.userId}`);
            return res.status(404).json({ success: false, message: 'Conversation not found' });
        }
        console.log(`✅ [getConversationById] Lead found: ${lead.name || lead.email || 'Unknown'}`);
        
        const email = lead.email || '';
        
        // ✅ FIX: Mark replies as read WITHOUT triggering schema validation on arrayFilters
        if (lead.replies && lead.replies.length > 0) {
            const unreadReplies = lead.replies.filter(r => r.from === 'lead' && !r.read);
            if (unreadReplies.length > 0) {
                await Lead.updateOne(
                    { _id: leadId, userId: req.userId },
                    { $set: { 'replies.$[elem].read': true } },
                    { 
                        arrayFilters: [{ 'elem.from': 'lead', 'elem.read': false }],
                        strict: false
                    }
                );
                console.log(`📖 [getConversationById] Marked ${unreadReplies.length} replies as read`);
            }
        }
        
        let allMessages = lead.replies || [];
        console.log(`📡 [getConversationById] Found ${allMessages.length} replies in lead`);
        
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
        
        console.log(`📤 [getConversationById] Returning ${cleanHistory.length} messages for lead ${leadId}`);
        
        res.json({
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
            messages: cleanHistory
        });
        
    } catch (err) {
        console.error(' [getConversationById] Error:', err);
        console.error('❌ [getConversationById] Error stack:', err.stack);
        res.status(500).json({ success: false, message: 'Server Error fetching conversation' });
    }
};

// ─────────────────────────────────────────────────────────────
//  PUT /api/leads/:leadId/rename
// ─────────────────────────────────────────────────────────────
const renameLead = async (req, res) => {
    console.log('🔵 [renameLead] ENTERED - leadId:', req.params.leadId);
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId) || !isValidObjectId(req.params.leadId)) {
            return res.status(400).json({ message: 'Invalid ID' });
        }
        const { newName } = req.body;
        if (!newName || typeof newName !== 'string' || newName.trim() === '') {
            return res.status(400).json({ message: 'New name is required' });
        }
        const sanitizedNewName = newName.trim().slice(0, 100);
        
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        lead.name = sanitizedNewName;
        await lead.save();
        console.log(`✏️ [renameLead] Lead ${lead._id} renamed to ${lead.name}`);
        res.json({ success: true, newName: lead.name });
    } catch (err) {
        console.error('❌ [renameLead] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  PUT /api/leads/:leadId/auto-reply
// ──────────────────────────────────────────────────────────────
const updateAutoReply = async (req, res) => {
    console.log('🔵 [updateAutoReply] ENTERED - leadId:', req.params.leadId);
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId) || !isValidObjectId(req.params.leadId)) {
            return res.status(400).json({ message: 'Invalid ID' });
        }
        const { enabled, instructions } = req.body;
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ message: 'Enabled must be a boolean' });
        }
        const sanitizedInstructions = instructions ? instructions.trim().slice(0, 2000) : '';
        
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: req.userId });
        if (!lead) return res.status(404).json({ message: 'Lead not found' });
        lead.autoReplyEnabled = enabled;
        if (instructions !== undefined) lead.autoReplyInstructions = sanitizedInstructions;
        await lead.save();
        console.log(` [updateAutoReply] Lead ${lead._id} auto-reply enabled=${enabled}`);
        res.json({ success: true, enabled: lead.autoReplyEnabled, instructions: lead.autoReplyInstructions });
    } catch (err) {
        console.error('❌ [updateAutoReply] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  POST /api/leads/batch-send - COMPLETE FIX WITH TOKEN RETRY
// ──────────────────────────────────────────────────────────────
const batchSend = async (req, res) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📨 [BE-BATCH] Request received');
    console.log('👤 [BE-BATCH] User ID:', req.userId);
    console.log('🆔 [BE-BATCH] Received Lead ID:', req.body.leadId);
    console.log('🚫 [BE-BATCH] Allow New Lead:', req.body.allowNewLead);
    
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        
        const { leads, leadId, allowNewLead = true } = req.body;
        
        // ─── ✅ BATCH SIZE VALIDATION ───
        const MAX_BATCH_SIZE = 100;
        
        if (!Array.isArray(leads)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Leads must be an array' 
            });
        }
        
        if (leads.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'At least one lead is required' 
            });
        }
        
        if (leads.length > MAX_BATCH_SIZE) {
            return res.status(400).json({ 
                success: false, 
                message: `Batch size exceeds maximum limit of ${MAX_BATCH_SIZE} leads. You sent ${leads.length}.`,
                maxAllowed: MAX_BATCH_SIZE,
                sentCount: leads.length
            });
        }
        
        console.log(`📊 [BE-BATCH] Processing ${leads.length} leads (max: ${MAX_BATCH_SIZE})`);

        // ─── CHECK EMAIL LIMIT FIRST ───
        try {
            await checkAndIncrementSendLimit(req.userId);
        } catch (limitError) {
            return res.status(429).json({ 
                success: false, 
                message: limitError.message,
                limitReached: true 
            });
        }

        // ─── GET EMAIL ACCOUNT WITH TOKEN HANDLING ───
        const EmailAccount = require('./EmailAccount');
        let account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
        
        // ✅ Check if Nylas is connected
        if (!account) {
            return res.status(401).json({
                success: false,
                error: 'NYLAS_DISCONNECTED',
                message: 'Please connect your email account first.'
            });
        }

        // ✅ FIX: Handle token refresh with retry logic
        let tokenValid = true;
        let tokenError = null;
        
        try {
            // Check if token is expired
            const now = new Date();
            const tokenExpiry = new Date(account.tokenExpiry);
            const timeUntilExpiry = (tokenExpiry - now) / 1000; // seconds
            
            console.log(`🔐 [BE-BATCH] Token expires in ${timeUntilExpiry} seconds`);
            
            // If token expires in less than 5 minutes, refresh it
            if (timeUntilExpiry < 300) {
                console.log('🔄 [BE-BATCH] Token expiring soon, refreshing...');
                
                // ✅ RETRY LOGIC: Try up to 3 times
                let refreshAttempts = 0;
                const MAX_REFRESH_ATTEMPTS = 3;
                let refreshed = false;
                
                while (refreshAttempts < MAX_REFRESH_ATTEMPTS && !refreshed) {
                    try {
                        refreshAttempts++;
                        console.log(`🔄 [BE-BATCH] Refresh attempt ${refreshAttempts}/${MAX_REFRESH_ATTEMPTS}`);
                        
                        const { refreshNylasToken } = require('./nylasService');
                        const newToken = await refreshNylasToken(req.userId);
                        
                        if (newToken && newToken.accessToken) {
                            refreshed = true;
                            tokenValid = true;
                            console.log('✅ [BE-BATCH] Token refreshed successfully');
                            
                            // Update account with new token
                            account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
                        }
                    } catch (refreshErr) {
                        console.error(`❌ [BE-BATCH] Refresh attempt ${refreshAttempts} failed:`, refreshErr.message);
                        tokenError = refreshErr.message;
                        
                        if (refreshAttempts < MAX_REFRESH_ATTEMPTS) {
                            // Wait before retry (exponential backoff)
                            const waitTime = Math.min(1000 * Math.pow(2, refreshAttempts - 1), 5000);
                            console.log(`⏳ [BE-BATCH] Waiting ${waitTime}ms before retry...`);
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                        }
                    }
                }
                
                // If all refresh attempts failed
                if (!refreshed) {
                    console.error(`❌ [BE-BATCH] All ${MAX_REFRESH_ATTEMPTS} refresh attempts failed`);
                    tokenValid = false;
                    
                    // ✅ Fallback: Try to continue with stale token
                    console.warn('⚠️ [BE-BATCH] Continuing with stale token - individual sends may fail');
                }
            } else {
                console.log('✅ [BE-BATCH] Token is valid');
            }
        } catch (err) {
            console.error('❌ [BE-BATCH] Token refresh error:', err);
            tokenValid = false;
            tokenError = err.message;
            // Continue with stale token
        }

        // ✅ CASE 1: Sending to an EXISTING lead (from notifications.html)
        if (leadId) {
            console.log('🔍 [BE-BATCH] Searching for existing lead:', leadId);
            
            // ─── CHECK IDEMPOTENCY ───
            const idempotencyKey = generateIdempotencyKey(req.userId, leadId, 'batchSend', null);
            const cached = idempotencyCache.get(idempotencyKey);
            if (cached) {
                console.log(`⏭️ [BE-BATCH] Skipping duplicate request for lead ${leadId}`);
                return res.json({
                    success: true,
                    alreadyProcessed: true,
                    message: 'Email was already sent',
                    leadId: leadId
                });
            }
            
            const targetLead = await Lead.findOne({ _id: leadId, userId: req.userId });
            
            if (!targetLead) {
                console.error('❌ [BE-BATCH] Lead NOT FOUND for ID:', leadId);
                return res.status(404).json({
                    success: false,
                    error: 'LEAD_NOT_FOUND',
                    message: 'Conversation not found.'
                });
            }
            
            console.log('✅ [BE-BATCH] Lead FOUND:', targetLead.name, '(ID:', targetLead._id, ')');
            
            const leadData = leads[0];
            const msgContent = leadData.messages[0].body;
            const msgSubject = leadData.messages[0].subject || 'Re: Conversation';
            const now = new Date();
            
            // ─── CHECK FOR DUPLICATE MESSAGES ───
            const lastReply = targetLead.replies && targetLead.replies.length > 0 ? targetLead.replies[targetLead.replies.length - 1] : null;
            const isDuplicate = lastReply && 
                                lastReply.content === msgContent && 
                                (new Date() - new Date(lastReply.date)) < 5000;

            if (!isDuplicate) {
                console.log('💾 [BE-BATCH] Saving new reply to Lead.replies...');
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
            } else {
                console.log('⚠️ [BE-BATCH] Duplicate detected. Skipping save.');
            }
            
            // ── SEND EMAIL WITH RETRY ──
            let emailSent = false;
            let emailError = null;
            let threadId = null;
            
            if (!account) {
                emailError = 'No email account connected';
            } else {
                // ✅ RETRY LOGIC: Try up to 2 times per email
                let sendAttempts = 0;
                const MAX_SEND_ATTEMPTS = 2;
                
                while (sendAttempts < MAX_SEND_ATTEMPTS && !emailSent) {
                    try {
                        sendAttempts++;
                        console.log(`📧 [BE-BATCH] Send attempt ${sendAttempts}/${MAX_SEND_ATTEMPTS} to ${targetLead.email}`);
                        
                        // ✅ Use the updated account for each attempt
                        const freshAccount = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
                        
                        const result = await sendEmail(
                            req.userId,
                            targetLead.email,
                            msgSubject,
                            msgContent
                        );
                        
                        if (result.success) {
                            emailSent = true;
                            threadId = result.threadId;
                            console.log(`✅ [BE-BATCH] Email sent successfully to ${targetLead.email}`);
                            
                            if (threadId) {
                                targetLead.threadId = threadId;
                                console.log(`💾 [BE-BATCH] Saved threadId to lead: ${threadId}`);
                            }
                        } else {
                            emailError = result.error || 'Email send failed';
                            console.error(`❌ [BE-BATCH] Send attempt ${sendAttempts} failed: ${emailError}`);
                            
                            if (sendAttempts < MAX_SEND_ATTEMPTS) {
                                const waitTime = 1000 * sendAttempts;
                                console.log(`⏳ [BE-BATCH] Waiting ${waitTime}ms before retry...`);
                                await new Promise(resolve => setTimeout(resolve, waitTime));
                            }
                        }
                    } catch (sendErr) {
                        emailError = sendErr.message;
                        console.error(`❌ [BE-BATCH] Send attempt ${sendAttempts} error: ${emailError}`);
                        
                        if (sendAttempts < MAX_SEND_ATTEMPTS) {
                            const waitTime = 1000 * sendAttempts;
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                        }
                    }
                }
            }
            
            await targetLead.save();
            
            // ─── STORE IN IDEMPOTENCY CACHE ───
            if (emailSent) {
                idempotencyCache.set(idempotencyKey, {
                    timestamp: Date.now(),
                    leadId: targetLead._id,
                    success: true
                });
            }
            
            console.log('📤 [BE-BATCH] Returning response...');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            
            res.json({
                success: true,
                message: emailSent ? 'Email sent successfully.' : 'Message saved but email not sent.',
                leadId: targetLead._id.toString(),
                emailSent: emailSent,
                emailError: emailError || null,
                threadId: threadId || null,
                tokenRefreshed: tokenValid
            });
            
        // ✅ CASE 2: Creating NEW leads and sending (from page.html)
        } else {
            console.log('📝 [BE-BATCH] No Lead ID provided. Creating new leads...');
            if (allowNewLead === false) {
                console.error('❌ [BE-BATCH] New lead creation blocked by allowNewLead=false');
                return res.status(400).json({ success: false, error: 'NEW_LEAD_NOT_ALLOWED' });
            }

            let results = [];
            let anyFailed = false;

            // ─── PROCESS LEADS (with batch size already validated) ───
            for (const leadData of leads) {
                const now = new Date();
                const leadEmail = sanitizeEmail(leadData.email);
                
                // ─── CHECK IDEMPOTENCY ───
                const idempotencyKey = generateIdempotencyKey(req.userId, null, 'createSend', leadEmail);
                const cached = idempotencyCache.get(idempotencyKey);
                if (cached) {
                    console.log(`⏭️ [BE-BATCH] Skipping duplicate lead creation for ${leadEmail}`);
                    results.push({
                        email: leadEmail,
                        name: leadData.name,
                        success: true,
                        alreadyProcessed: true,
                        message: 'Email was already sent'
                    });
                    continue;
                }
                
                // ─── FIND OR CREATE LEAD WITH LOCK ───
                let lead = await Lead.findOne({ userId: req.userId, email: leadEmail });
                
                if (lead) {
                    console.log(`📋 [BE-BATCH] Lead already exists for ${leadEmail}, updating...`);
                    
                    // Check if this exact message was already sent
                    const lastReply = lead.replies?.[lead.replies.length - 1];
                    if (lastReply && lastReply.content === leadData.messages[0].body) {
                        console.log(`⏭️ [BE-BATCH] Duplicate message detected for ${leadEmail}`);
                        results.push({
                            email: leadEmail,
                            name: leadData.name,
                            success: true,
                            alreadyProcessed: true,
                            message: 'Email already sent'
                        });
                        continue;
                    }
                    
                    // ✅ ATOMIC: Update lead status
                    await Lead.findOneAndUpdate(
                        { _id: lead._id, userId: req.userId },
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
                    console.log(`🆕 [BE-BATCH] Creating new lead for ${leadEmail}`);
                    
                    // ✅ ATOMIC: Create new lead
                    lead = new Lead({
                        userId: req.userId,
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

                // ─── SEND EMAIL WITH RETRY ───
                let emailSent = false;
                let emailError = null;

                if (account && leadEmail) {
                    // ✅ RETRY LOGIC: Try up to 2 times per email
                    let sendAttempts = 0;
                    const MAX_SEND_ATTEMPTS = 2;
                    
                    while (sendAttempts < MAX_SEND_ATTEMPTS && !emailSent) {
                        try {
                            sendAttempts++;
                            console.log(`📧 [BE-BATCH] Send attempt ${sendAttempts}/${MAX_SEND_ATTEMPTS} to ${leadEmail}`);
                            
                            // ✅ Use fresh account for each attempt
                            const freshAccount = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
                            
                            const result = await sendEmail(
                                req.userId,
                                leadEmail,
                                leadData.messages[0].subject || 'Hello from Skyline',
                                leadData.messages[0].body
                            );
                            
                            if (result.success) {
                                emailSent = true;
                                if (result.threadId) lead.threadId = result.threadId;
                                console.log(`✅ [BE-BATCH] Email sent successfully to ${leadEmail}`);
                            } else {
                                emailError = result.error || 'Email send failed';
                                console.error(`❌ [BE-BATCH] Send attempt ${sendAttempts} failed: ${emailError}`);
                                
                                if (sendAttempts < MAX_SEND_ATTEMPTS) {
                                    const waitTime = 1000 * sendAttempts;
                                    console.log(`⏳ [BE-BATCH] Waiting ${waitTime}ms before retry...`);
                                    await new Promise(resolve => setTimeout(resolve, waitTime));
                                }
                            }
                        } catch (sendErr) {
                            emailError = sendErr.message;
                            console.error(`❌ [BE-BATCH] Send attempt ${sendAttempts} error: ${emailError}`);
                            
                            if (sendAttempts < MAX_SEND_ATTEMPTS) {
                                const waitTime = 1000 * sendAttempts;
                                await new Promise(resolve => setTimeout(resolve, waitTime));
                            }
                        }
                    }
                } else {
                    emailError = 'No email account or missing lead email';
                    anyFailed = true;
                }

                // ─── SAVE LEAD ───
                await lead.save();
                
                // ─── STORE IN IDEMPOTENCY CACHE ───
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

            console.log(`📤 [BE-BATCH] Batch complete. Sent ${results.filter(r=>r.sent).length}/${results.length}`);
            
            res.json({
                success: !anyFailed,
                message: anyFailed ? 'Some emails failed to send.' : 'All emails sent successfully.',
                results: results,
                tokenRefreshed: tokenValid
            });
        }
        
    } catch (err) {
        console.error('💥 [BE-BATCH] Fatal Error:', err);
        res.status(500).json({ message: 'Server Error during batch send' });
    }
};

// ──────────────────────────────────────────────────────────────
//  POST /api/reconnect-and-send
// ──────────────────────────────────────────────────────────────
const reconnectAndSend = async (req, res) => {
    console.log('🔵 [reconnectAndSend] ENTERED');
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }

        const EmailAccount = require('./EmailAccount');
        const account = await EmailAccount.findOne({ userId: req.userId, isConnected: true });
        if (!account) {
            return res.status(401).json({
                success: false,
                error: 'NYLAS_DISCONNECTED',
                message: 'Please connect your email account first.'
            });
        }

        const leadsWithPending = await Lead.find({ userId: req.userId, 'replies.status': 'pending' });
        let sentCount = 0;
        for (const lead of leadsWithPending) {
            const pendingMessages = lead.replies.filter(r => r.status === 'pending');
            for (const msg of pendingMessages) {
                // ─── CHECK IDEMPOTENCY ───
                const idempotencyKey = generateIdempotencyKey(req.userId, lead._id, 'reconnectSend', null);
                const cached = idempotencyCache.get(idempotencyKey);
                if (cached) {
                    console.log(`⏭️ [reconnectAndSend] Skipping duplicate for lead ${lead._id}`);
                    continue;
                }
                
                try {
                    const result = await sendEmail(
                        req.userId,
                        lead.email,
                        msg.subject || 'Re: Conversation',
                        msg.content
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
        console.error(' [reconnectAndSend] Error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ──────────────────────────────────────────────────────────────
//  GET /api/leads - FIXED (Proper userId filtering)
// ─────────────────────────────────────────────────────────────
const getAllLeads = async (req, res) => {
    console.log('🔵 [getAllLeads] ENTERED - userId:', req.userId);
    try {
        if (!req.userId) return res.status(401).json({ message: 'Unauthorized' });
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        const leads = await Lead.find({ userId: req.userId })
            .sort({ createdAt: -1 });
            
        console.log(`✅ [getAllLeads] Found ${leads.length} leads for user ${req.userId}`);
        res.json(leads);
    } catch (err) {
        console.error('❌ [getAllLeads] Error:', err);
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
