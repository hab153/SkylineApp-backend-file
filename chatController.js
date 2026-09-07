const { v4: uuidv4 } = require('uuid');
const ChatMessage = require('./ChatMessage');
const Session = require('./Session');
const User = require('./User');
const freeAI = require('./Free');
const goAI = require('./Go');
const { generateBusinessResponse } = require('./businessAI');
const { freeQueue, goQueue, proQueue } = require('./requestQueue');
const { isValidObjectId, sanitizeQuery, sanitizeString, sanitizeObject } = require('./sanitize');

// Helper to handle queue errors and send friendly messages
const handleQueueError = (error, res) => {
    console.error('Queue error:', error.message);
    if (error.message.includes('busy') || error.message.includes('try again')) {
        return res.status(503).json({ message: error.message });
    }
    if (error.message.includes('taking longer than expected')) {
        return res.status(504).json({ message: error.message });
    }
    return res.status(500).json({ message: 'AI service error. Please try again later.' });
};

// ──────────────────────────────────────────────────────────────
// HELPER: Check if a message is a clarification response
// ──────────────────────────────────────────────────────────────

function isClarificationResponse(history) {
    if (!history || history.length === 0) return false;
    
    // Check the last assistant message for clarification context
    for (let i = history.length - 1; i >= 0; i--) {
        const entry = history[i];
        if (entry.role === 'assistant' && entry._meta?.needsClarification) {
            return {
                isClarification: true,
                originalMessage: entry._meta.originalMessage,
                clarificationContext: entry._meta.clarificationContext
            };
        }
    }
    return false;
}

// ──────────────────────────────────────────────────────────────
// HELPER: Build userProfile from user object
// ──────────────────────────────────────────────────────────────

function buildUserProfile(user) {
    return {
        fullName: user.fullName,
        country: user.country,
        skillLevel: user.skillLevel,
        primaryGoal: user.primaryGoal,
        interests: user.interests,
        bio: user.bio,
        userId: user._id.toString(),
        tenantId: user.tenantId || 'skyline-default',
        id: user._id.toString(),
        _id: user._id.toString(),
        conversationId: null,
        locale: user.locale || 'en-US',
        timezone: user.timezone || 'Africa/Lagos'
    };
}

// ──────────────────────────────────────────────────────────────
// POST /api/chat - COMPLETE FIXED VERSION WITH CONTEXT
// ──────────────────────────────────────────────────────────────

const sendMessage = async (req, res) => {
    let { message, history, sessionId } = req.body;
    const userId = req.userId;
    
    // ✅ Validate input types before any processing
    if (!message || typeof message !== 'string') {
        return res.status(400).json({ message: 'Message is required and must be a string' });
    }
    
    if (message.length > 10000) {
        return res.status(400).json({ message: 'Message too long. Maximum 10000 characters.' });
    }
    
    // ✅ Validate userId
    if (!isValidObjectId(userId)) {
        return res.status(400).json({ message: 'Invalid user ID' });
    }
    
    const safeUserId = String(userId);
    
    console.log('🔍 [CHAT] Received message length:', message.length);
    console.log('🔍 [CHAT] User ID:', safeUserId);
    
    // ✅ Store original message
    const originalMessage = message;
    
    // ✅ Validate and sanitize sessionId
    let currentSessionId;
    if (sessionId && typeof sessionId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) {
        currentSessionId = sessionId;
    } else {
        currentSessionId = uuidv4();
    }
    
    const user = await User.findById(safeUserId);
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }
    
    const plan = user.subscriptionTier || 'free';

    try {
        // ✅ SAVE USER MESSAGE - Store the ORIGINAL message
        const savedUserMessage = await ChatMessage.create({
            userId: safeUserId,
            sessionId: String(currentSessionId),
            role: 'user',
            content: originalMessage,
            title: originalMessage.substring(0, 30) + '...'
        });
        
        console.log('✅ [CHAT] User message saved:', savedUserMessage._id);

        // --- Create/Update Session metadata ---
        const existingSession = await Session.findOne({ 
            userId: safeUserId, 
            sessionId: String(currentSessionId) 
        });
        
        if (!existingSession) {
            await Session.create({
                userId: safeUserId,
                sessionId: String(currentSessionId),
                type: 'lead',
                name: originalMessage.substring(0, 50) || 'Lead Search',
                updatedAt: new Date()
            });
            console.log('✅ [CHAT] Session created:', currentSessionId);
        } else {
            if (String(existingSession.userId) !== safeUserId) {
                return res.status(403).json({ message: 'Access denied to this session' });
            }
            
            await Session.findOneAndUpdate(
                { userId: safeUserId, sessionId: String(currentSessionId) },
                { updatedAt: new Date() }
            );
            console.log('✅ [CHAT] Session updated:', currentSessionId);
        }

        // ── Build history for context ──
        // Ensure history is an array and include metadata for clarification detection
        const historyWithMeta = history || [];
        
        // ── Check if this is a clarification response ──
        const clarificationInfo = isClarificationResponse(historyWithMeta);
        if (clarificationInfo) {
            console.log('🔄 [CHAT] Clarification response detected');
            console.log('   Original message:', clarificationInfo.originalMessage);
            console.log('   Clarification context:', clarificationInfo.clarificationContext);
        }

        // ── Build userProfile ──
        const userProfile = buildUserProfile(user);
        
        // ── If this is a clarification, pass the context to the AI ──
        const aiOptions = {
            clarificationInfo: clarificationInfo,
            originalMessage: clarificationInfo ? clarificationInfo.originalMessage : null,
            sessionId: currentSessionId // ✅ PASS SESSION ID TO AI
        };

        // --- Get AI Response ---
        let aiReply, updatedHistory;
        if (plan === 'free') {
            const result = await freeQueue.enqueue(() => freeAI.generateFreeResponse(
                originalMessage, 
                historyWithMeta, 
                userProfile,
                null, // onProgress
                aiOptions // Pass clarification context + sessionId
            ));
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        } else if (plan === 'go') {
            const result = await goQueue.enqueue(() => goAI.generateGoResponse(
                originalMessage, 
                historyWithMeta, 
                userProfile,
                aiOptions
            ));
            aiReply = result ? result.reply : "⚠️ Go AI Service unavailable.";
            updatedHistory = result ? (result.updatedHistory || []) : [];
        } else { // pro
            const result = await proQueue.enqueue(() => generateBusinessResponse(
                originalMessage, 
                historyWithMeta, 
                userProfile,
                aiOptions
            ));
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        }

        // ✅ SAVE AI RESPONSE
        const savedAiMessage = await ChatMessage.create({ 
            userId: safeUserId, 
            sessionId: String(currentSessionId), 
            role: 'ai', 
            content: typeof aiReply === 'string' ? aiReply : 'Unable to generate response.'
        });
        
        console.log('✅ [CHAT] AI response saved:', savedAiMessage._id);
        console.log('✅ [CHAT] AI response length:', aiReply ? aiReply.length : 0);

        // ✅ VERIFY messages were saved
        const verifyCount = await ChatMessage.countDocuments({ 
            userId: safeUserId, 
            sessionId: String(currentSessionId) 
        });
        console.log('✅ [CHAT] Total messages in session:', verifyCount);

        res.json({ 
            reply: aiReply, 
            sessionId: currentSessionId, 
            history: updatedHistory,
            messageCount: verifyCount
        });
        
    } catch (error) {
        console.error('❌ [CHAT] Error:', error.message);
        if (error.message && (error.message.includes('busy') || error.message.includes('taking longer'))) {
            return handleQueueError(error, res);
        }
        res.status(500).json({ message: 'Server Error processing your message' });
    }
};

// ──────────────────────────────────────────────────────────────
// POST /api/feedback
// ──────────────────────────────────────────────────────────────

const submitFeedback = async (req, res) => {
    try {
        const { messageId, type } = req.body;
        
        if (!messageId || typeof messageId !== 'string' || !['like', 'dislike'].includes(type)) {
            return res.status(400).json({ message: 'Invalid feedback data' });
        }
        if (!isValidObjectId(messageId)) {
            return res.status(400).json({ message: 'Invalid message ID' });
        }
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        const safeUserId = String(req.userId);
        const safeMessageId = String(messageId);
        
        const message = await ChatMessage.findById(safeMessageId);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        
        if (String(message.userId) !== safeUserId) {
            return res.status(403).json({ message: 'Unauthorized' });
        }
        
        message.feedback = message.feedback === type ? null : type;
        await message.save();
        res.json({ success: true, feedback: message.feedback });
    } catch (err) {
        console.error('Submit feedback error:', err.message);
        res.status(500).json({ message: 'Server Error saving feedback' });
    }
};

// ──────────────────────────────────────────────────────────────
// GET /api/sessions
// ──────────────────────────────────────────────────────────────

const getSessions = async (req, res) => {
    try {
        const userId = req.userId;
        if (!isValidObjectId(userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        const safeUserId = String(userId);
        const query = sanitizeQuery({ userId: safeUserId });
        
        const sessions = await Session.find(query)
            .sort({ pinned: -1, updatedAt: -1 })
            .lean();

        const sessionsWithCounts = await Promise.all(sessions.map(async (session) => {
            const count = await ChatMessage.countDocuments({
                userId: safeUserId,
                sessionId: String(session.sessionId)
            });
            return {
                _id: session.sessionId,
                title: session.name,
                lastUpdated: session.updatedAt,
                messageCount: count,
                type: session.type,
                pinned: session.pinned
            };
        }));

        res.json(sessionsWithCounts);
    } catch (error) {
        console.error('[getSessions] Error:', error.message);
        res.status(500).json({ message: 'Server Error fetching sessions' });
    }
};

// ──────────────────────────────────────────────────────────────
// GET /api/history/:sessionId
// ──────────────────────────────────────────────────────────────

const getHistory = async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        if (!sessionId || typeof sessionId !== 'string') {
            return res.status(400).json({ message: 'Invalid session ID' });
        }
        
        const userId = req.userId;
        if (!isValidObjectId(userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        const safeUserId = String(userId);
        const sanitizedSessionId = String(sanitizeString(sessionId));
        
        const session = await Session.findOne({ 
            userId: safeUserId, 
            sessionId: sanitizedSessionId 
        });
        
        if (!session) {
            return res.status(404).json({ message: 'Session not found' });
        }
        
        const query = sanitizeQuery({ 
            userId: safeUserId, 
            sessionId: sanitizedSessionId 
        });
        const messages = await ChatMessage.find(query).sort({ createdAt: 1 });
        res.json(messages);
    } catch (error) {
        console.error('Get history error:', error.message);
        res.status(500).json({ message: 'Server Error fetching history' });
    }
};

// ──────────────────────────────────────────────────────────────
// POST /api/dreams/analyze (pro feature)
// ──────────────────────────────────────────────────────────────

const analyzeDream = async (req, res) => {
    let { dream, sessionId } = req.body;
    const userId = req.userId;
    
    if (!dream || typeof dream !== 'string') {
        return res.status(400).json({ message: 'Dream description is required and must be a string' });
    }
    if (!isValidObjectId(userId)) {
        return res.status(400).json({ message: 'Invalid user ID' });
    }
    
    const safeUserId = String(userId);
    const originalDream = dream;
    dream = sanitizeString(dream);
    
    let currentSessionId;
    if (sessionId && typeof sessionId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) {
        currentSessionId = sessionId;
    } else {
        currentSessionId = uuidv4();
    }
    
    try {
        await ChatMessage.create({ 
            userId: safeUserId, 
            sessionId: String(currentSessionId), 
            role: 'user', 
            content: originalDream, 
            title: originalDream.substring(0, 30) + '...' 
        });
        
        const user = await User.findById(safeUserId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        const userProfile = buildUserProfile(user);
        const result = await proQueue.enqueue(() => generateBusinessResponse(originalDream, [], userProfile));
        
        await ChatMessage.create({ 
            userId: safeUserId, 
            sessionId: String(currentSessionId), 
            role: 'ai', 
            content: typeof result.reply === 'string' ? result.reply : 'Unable to analyze dream.'
        });
        
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        if (error.message && (error.message.includes('busy') || error.message.includes('taking longer'))) {
            return handleQueueError(error, res);
        }
        console.error('Dream analyze error:', error.message);
        res.status(500).json({ message: 'Server Error analyzing dream' });
    }
};

// ──────────────────────────────────────────────────────────────
// POST /api/dreams/refine (pro feature)
// ──────────────────────────────────────────────────────────────

const refineDream = async (req, res) => {
    let { followUpAnswer, dreamDescription, sessionId } = req.body;
    const userId = req.userId;
    
    if (!followUpAnswer || typeof followUpAnswer !== 'string' || !dreamDescription || typeof dreamDescription !== 'string') {
        return res.status(400).json({ message: 'followUpAnswer and dreamDescription are required and must be strings' });
    }
    if (!isValidObjectId(userId)) {
        return res.status(400).json({ message: 'Invalid user ID' });
    }
    
    const safeUserId = String(userId);
    const originalFollowUp = followUpAnswer;
    followUpAnswer = sanitizeString(followUpAnswer);
    dreamDescription = sanitizeString(dreamDescription);
    
    let currentSessionId;
    if (sessionId && typeof sessionId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) {
        currentSessionId = sessionId;
    } else {
        currentSessionId = uuidv4();
    }
    
    try {
        await ChatMessage.create({ 
            userId: safeUserId, 
            sessionId: String(currentSessionId), 
            role: 'user', 
            content: originalFollowUp 
        });
        
        const user = await User.findById(safeUserId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        
        const userProfile = buildUserProfile(user);
        const result = await proQueue.enqueue(() => generateBusinessResponse(originalFollowUp, [], userProfile));
        
        await ChatMessage.create({ 
            userId: safeUserId, 
            sessionId: String(currentSessionId), 
            role: 'ai', 
            content: typeof result.reply === 'string' ? result.reply : 'Unable to refine dream.'
        });
        
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        if (error.message && (error.message.includes('busy') || error.message.includes('taking longer'))) {
            return handleQueueError(error, res);
        }
        console.error('Dream refine error:', error.message);
        res.status(500).json({ message: 'Server Error refining dream' });
    }
};

// ──────────────────────────────────────────────────────────────
// EXPORTS
// ──────────────────────────────────────────────────────────────

module.exports = {
    sendMessage,
    submitFeedback,
    getSessions,
    getHistory,
    analyzeDream,
    refineDream
};
