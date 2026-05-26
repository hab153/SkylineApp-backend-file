const { v4: uuidv4 } = require('uuid');
const Message = require('./Message');
const User = require('./User');
const freeAI = require('./Free');
const goAI = require('./Go');
const { generateBusinessResponse } = require('./businessAI');
const requestQueue = require('./requestQueue');

// POST /api/chat
const sendMessage = async (req, res) => {
    const { message, history, sessionId } = req.body;
    const userId = req.userId;
    if (!message) return res.status(400).json({ message: 'Message is required' });
    const currentSessionId = sessionId || uuidv4();
    const user = await User.findById(userId);
    const plan = user.subscriptionTier || 'free';
    try {
        await new Message({
            userId,
            sessionId: currentSessionId,
            role: 'user',
            content: message,
            title: message.substring(0, 30) + '...'
        }).save();

        let aiReply, updatedHistory;
        if (plan === 'free') {
            const result = await freeAI.generateFreeResponse(message, history || [], user);
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        } else if (plan === 'go') {
            try {
                const result = await goAI.generateGoResponse(message, history || [], user);
                aiReply = result ? result.reply : "⚠️ Go AI Service unavailable.";
                updatedHistory = result ? (result.updatedHistory || []) : [];
            } catch (goError) {
                aiReply = "⚠️ Go AI Service currently unavailable.";
            }
        } else {
            const userProfile = {
                fullName: user.fullName,
                country: user.country,
                skillLevel: user.skillLevel,
                primaryGoal: user.primaryGoal,
                interests: user.interests,
                bio: user.bio,
                userId: user._id.toString()
            };
            const result = await requestQueue.enqueue(async () => generateBusinessResponse(message, history || [], userProfile));
            aiReply = result.reply;
            updatedHistory = result.updatedHistory;
        }

        await new Message({ userId, sessionId: currentSessionId, role: 'ai', content: aiReply }).save();
        res.json({ reply: aiReply, sessionId: currentSessionId, history: updatedHistory });
    } catch (error) {
        console.error('Chat route error:', error);
        res.status(500).json({ message: error.message || 'Server Error' });
    }
};

// POST /api/feedback
const submitFeedback = async (req, res) => {
    try {
        const { messageId, type } = req.body;
        if (!messageId || !['like', 'dislike'].includes(type)) return res.status(400).json({ message: 'Invalid feedback data' });
        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ message: 'Message not found' });
        if (message.userId.toString() !== req.userId) return res.status(403).json({ message: 'Unauthorized' });
        message.feedback = message.feedback === type ? null : type;
        await message.save();
        res.json({ success: true, feedback: message.feedback });
    } catch (err) {
        res.status(500).json({ message: 'Server Error saving feedback' });
    }
};

// GET /api/sessions
const getSessions = async (req, res) => {
    try {
        const mongoose = require('mongoose');
        const sessions = await Message.aggregate([
            { $match: { userId: new mongoose.Types.ObjectId(req.userId) } },
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$sessionId', title: { $first: '$title' }, lastUpdated: { $first: '$createdAt' } } },
            { $sort: { lastUpdated: -1 } }
        ]);
        res.json(sessions);
    } catch (error) {
        res.status(500).json({ message: 'Server Error fetching sessions' });
    }
};

// GET /api/history/:sessionId
const getHistory = async (req, res) => {
    try {
        const messages = await Message.find({ userId: req.userId, sessionId: req.params.sessionId }).sort({ createdAt: 1 });
        res.json(messages);
    } catch (error) {
        res.status(500).json({ message: 'Server Error fetching history' });
    }
};

// POST /api/dreams/analyze
const analyzeDream = async (req, res) => {
    const { dream, sessionId } = req.body;
    const userId = req.userId;
    if (!dream) return res.status(400).json({ message: 'Dream description is required' });
    const currentSessionId = sessionId || uuidv4();
    try {
        await new Message({ userId, sessionId: currentSessionId, role: 'user', content: dream, title: dream.substring(0, 30) + '...' }).save();
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
        const result = await requestQueue.enqueue(async () => generateBusinessResponse(dream, [], userProfile));
        await new Message({ userId, sessionId: currentSessionId, role: 'ai', content: result.reply }).save();
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Server Error' });
    }
};

// POST /api/dreams/refine
const refineDream = async (req, res) => {
    const { followUpAnswer, dreamDescription, sessionId } = req.body;
    const userId = req.userId;
    if (!followUpAnswer || !dreamDescription) return res.status(400).json({ message: 'followUpAnswer and dreamDescription are required' });
    const currentSessionId = sessionId || uuidv4();
    try {
        await new Message({ userId, sessionId: currentSessionId, role: 'user', content: followUpAnswer }).save();
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
        const result = await requestQueue.enqueue(async () => generateBusinessResponse(followUpAnswer, [], userProfile));
        await new Message({ userId, sessionId: currentSessionId, role: 'ai', content: result.reply }).save();
        res.json({ plan: result.reply, audit: {}, sessionId: currentSessionId });
    } catch (error) {
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
