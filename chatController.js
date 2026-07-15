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

// POST /api/chat - COMPLETE FIXED VERSION
const sendMessage = async (req, res) => {
    let { message, history, sessionId } = req.body;
    const userId = req.userId;
    
    console.log('🔍 [CHAT] Received message:', message);
    console.log('🔍 [CHAT] User ID:', userId);
    
    if (!message) {
        console.log('❌ [CHAT] Message is empty');
        return res.status(400).json({ message: 'Message is required' });
    }
    
    // ✅ FIX: Store original message, sanitize ONLY for display
    const originalMessage = message;
    
    // Sanitize for display purposes only
    const displayMessage = sanitizeString(message);
    
    console.log('🔍 [CHAT] Original message:', originalMessage);
    console.log('🔍 [CHAT] Original length:', originalMessage.length);
    
    const currentSessionId = sessionId || uuidv4();
    const user = await User.findById(userId);
    const plan = user.subscriptionTier || 'free';

    try {
        // ✅ SAVE USER MESSAGE - Store the ORIGINAL message
        const savedUserMessage = await ChatMessage.create({
            userId,
            sessionId: currentSessionId,
            role: 'user',
            content: originalMessage,  // ✅ Store original, NOT sanitized
            title: originalMessage.substring(0, 30) + '...'
        });
        
        console.log('✅ [CHAT] User message saved:', savedUserMessage._id);
        console.log('✅ [CHAT] Content length saved:', originalMessage.length);

        // --- Create/Update Session metadata ---
        const existingSession = await Session.findOne({ userId, sessionId: currentSessionId });
        if (!existingSession) {
            await Session.create({
                userId,
                sessionId: currentSessionId,
                type: 'lead',
                name: originalMessage.substring(0, 50) || 'Lead Search',
                updatedAt: new Date()
            });
            console.log('✅ [CHAT] Session created:', currentSessionId);
        } else {
            await Session.findOneAndUpdate(
                { userId, sessionId: currentSessionId },
                { updatedAt: new Date() }
            );
            console.log('✅ [CHAT] Session updated:', currentSessionId);
        }

        // --- Get AI Response ---
        let aiReply, updatedHistory;
        if (plan === 'free') {
            const result = await freeQueue.enqueue(() => freeAI.generateFreeResponse(originalMessage, history || [], user));
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        } else if (plan === 'go') {
            const result = await goQueue.enqueue(() => goAI.generateGoResponse(originalMessage, history || [], user));
            aiReply = result ? result.reply : "⚠️ Go AI Service unavailable.";
            updatedHistory = result ? (result.updatedHistory || []) : [];
        } else { // pro
            const userProfile = {
                fullName: user.fullName,
                country: user.country,
                skillLevel: user.skillLevel,
                primaryGoal: user.primaryGoal,
                interests: user.interests,
                bio: user.bio,
                userId: user._id.toString()
            };
            const result = await proQueue.enqueue(() => generateBusinessResponse(originalMessage, history || [], userProfile));
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        }

        // ✅ SAVE AI RESPONSE
        const savedAiMessage = await ChatMessage.create({ 
            userId, 
            sessionId: currentSessionId, 
            role: 'ai', 
            content: aiReply 
        });
        
        console.log('✅ [CHAT] AI response saved:', savedAiMessage._id);
        console.log('✅ [CHAT] AI response length:', aiReply ? aiReply.length : 0);

        // ✅ VERIFY messages were saved
        const verifyCount = await ChatMessage.countDocuments({ 
            userId, 
            sessionId: currentSessionId 
        });
        console.log('✅ [CHAT] Total messages in session:', verifyCount);

        res.json({ 
            reply: aiReply, 
            sessionId: currentSessionId, 
            history: updatedHistory,
            messageCount: verifyCount
        });
        
    } catch (error) {
        console.error('❌ [CHAT] Error:', error);
        if (error.message && (error.message.includes('busy') || error.message.includes('taking longer'))) {
            return handleQueueError(error, res);
        }
        res.status(500).json({ message: error.message || 'Server Error' });
    }
};

// POST /api/feedback
const submitFeedback = async (req, res) => {
    try {
        const { messageId, type } = req.body;
        if (!messageId || !['like', 'dislike'].includes(type)) return res.status(400).json({ message: 'Invalid feedback data' });
        if (!isValidObjectId(messageId)) {
            return res.status(400).json({ message: 'Invalid message ID' });
        }
        const message = await ChatMessage.findById(messageId);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        if (message.userId.toString() !== req.userId) return res.status(403).json({ message: 'Unauthorized' });
        message.feedback = message.feedback === type ? null : type;
        await message.save();
        res.json({ success: true, feedback: message.feedback });
    } catch (err) {
        console.error('Submit feedback error:', err);
        res.status(500).json({ message: 'Server Error saving feedback' });
    }
};

// GET /api/sessions - UPDATED to use Session model
const getSessions = async (req, res) => {
    try {
        const userId = req.userId;
        if (!isValidObjectId(userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const query = sanitizeQuery({ userId });
        const sessions = await Session.find(query)
            .sort({ pinned: -1, updatedAt: -1 })
            .lean();

        const sessionsWithCounts = await Promise.all(sessions.map(async (session) => {
            const count = await ChatMessage.countDocuments({
                userId,
                sessionId: session.sessionId
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
        console.error('[getSessions] Error:', error);
        res.status(500).json({ message: 'Server Error fetching sessions' });
    }
};

// GET /api/history/:sessionId
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
        // Sanitize sessionId string
        const sanitizedSessionId = sanitizeString(sessionId);
        const query = sanitizeQuery({ userId, sessionId: sanitizedSessionId });
        const messages = await ChatMessage.find(query).sort({ createdAt: 1 });
        res.json(messages);
    } catch (error) {
        console.error('Get history error:', error);
        res.status(500).json({ message: 'Server Error fetching history' });
    }
};

// POST /api/dreams/analyze (pro feature)
const analyzeDream = async (req, res) => {
    let { dream, sessionId } = req.body;
    const userId = req.userId;
    if (!dream) return res.status(400).json({ message: 'Dream description is required' });
    
    // ✅ FIX: Store original, sanitize for display
    const originalDream = dream;
    dream = sanitizeString(dream);
    
    const currentSessionId = sessionId || uuidv4();
    try {
        await ChatMessage.create({ userId, sessionId: currentSessionId, role: 'user', content: originalDream, title: originalDream.substring(0, 30) + '...' });
        const user = await User.findById(userId);
        const userProfile = {
            fullName: user.fullName,
            country: user.country,
            skillLevel: user.skillLevel,
            primaryGoal: user.primaryGoal,
            interests: user.interests,
            bio: user.bio,
            userId: user._id.toString()
        };
        const result = await proQueue.enqueue(() => generateBusinessResponse(originalDream, [], userProfile));
        await ChatMessage.create({ userId, sessionId: currentSessionId, role: 'ai', content: result.reply });
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        if (error.message && (error.message.includes('busy') || error.message.includes('taking longer'))) {
            return handleQueueError(error, res);
        }
        console.error('Dream analyze error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }
};

// POST /api/dreams/refine (pro feature)
const refineDream = async (req, res) => {
    let { followUpAnswer, dreamDescription, sessionId } = req.body;
    const userId = req.userId;
    if (!followUpAnswer || !dreamDescription) return res.status(400).json({ message: 'followUpAnswer and dreamDescription are required' });
    
    // ✅ FIX: Store original
    const originalFollowUp = followUpAnswer;
    followUpAnswer = sanitizeString(followUpAnswer);
    dreamDescription = sanitizeString(dreamDescription);
    
    const currentSessionId = sessionId || uuidv4();
    try {
        await ChatMessage.create({ userId, sessionId: currentSessionId, role: 'user', content: originalFollowUp });
        const user = await User.findById(userId);
        const userProfile = {
            fullName: user.fullName,
            country: user.country,
            skillLevel: user.skillLevel,
            primaryGoal: user.primaryGoal,
            interests: user.interests,
            bio: user.bio,
            userId: user._id.toString()
        };
        const result = await proQueue.enqueue(() => generateBusinessResponse(originalFollowUp, [], userProfile));
        await ChatMessage.create({ userId, sessionId: currentSessionId, role: 'ai', content: result.reply });
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        if (error.message && (error.message.includes('busy') || error.message.includes('taking longer'))) {
            return handleQueueError(error, res);
        }
        console.error('Dream refine error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }
};

module.exports = {
    sendMessage,
    submitFeedback,
    getSessions,
    getHistory,
    analyzeDream,
    refineDream
};
