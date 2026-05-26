const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const crypto = require('crypto');

// MIDDLEWARE & UTILITIES
const { verifyToken } = require('./authMiddleware');
const { checkDailyLimit } = require('./dailyLimitMiddleware');
const { checkSubscriptionExpiry } = require('./subscriptionMiddleware');
const { refreshNylasToken, startTokenRefreshJob } = require('./nylasTokenRefresh');
const flutterwaveWebhook = require('./flutterwaveWebhook');
const nylasInboundWebhook = require('./nylasInboundWebhook');
const { createFlutterwavePayment } = require('./Flutterwavepayment');
const leadController = require('./leadController');
const chatController = require('./chatController');
const userController = require('./userController');

// AI SERVICES
const freeAI = require('./Free');
const goAI = require('./Go');
const { generateBusinessResponse } = require('./businessAI');
const { generateAIReply } = require('./aiReplyGenerator');

// MODELS & SERVICES
const Lead = require('./Lead');
const EmailAccount = require('./EmailAccount');
const { getAuthUrl, exchangeCodeForToken, getUserEmail, sendEmail } = require('./nylasService');
const authRoutes = require('./authRoutes');
const Message = require('./Message');
const User = require('./User');
const Report = require('./Report');
const requestQueue = require('./requestQueue');
const { verifyLayer2, verifyLayer3 } = require('./authController'); // only needed for admin

dotenv.config();
const app = express();
app.use(cors());
const stateStore = {};

// ════════════════════════════════════════════
//  WEBHOOKS — MUST BE BEFORE express.json()
// ════════════════════════════════════════════
app.post('/api/flutterwave-webhook', express.raw({ type: 'application/json' }), flutterwaveWebhook);
app.all('/api/webhooks/inbound-email', express.raw({ type: 'application/json' }), nylasInboundWebhook);

// ════════════════════════════════════════════
//  NOW apply express.json()
// ════════════════════════════════════════════
app.use(express.json());
app.use(express.static(path.join(__dirname)));

mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
        console.log('✅ MongoDB Connected');
        startTokenRefreshJob();
    })
    .catch(err => console.log('❌ MongoDB Connection Error:', err));

app.use('/api/auth', authRoutes);

// ════════════════════════════════════════════
//  PAYMENT ROUTE
// ════════════════════════════════════════════
app.post('/api/create-flutterwave-payment', verifyToken, createFlutterwavePayment);

// ════════════════════════════════════════════
//  LEAD / CONVERSATION ROUTES
// ════════════════════════════════════════════
app.get('/api/conversations', verifyToken, leadController.getConversations);
app.get('/api/conversations/:leadId', verifyToken, leadController.getConversationById);
app.put('/api/leads/:leadId/rename', verifyToken, leadController.renameLead);
app.put('/api/leads/:leadId/auto-reply', verifyToken, leadController.updateAutoReply);
app.post('/api/leads/batch-send', verifyToken, leadController.batchSend);
app.post('/api/reconnect-and-send', verifyToken, leadController.reconnectAndSend);
app.get('/api/leads', verifyToken, leadController.getAllLeads);

// ════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════
app.get('/api/my-notifications', verifyToken, async (req, res) => {
    try {
        const replyNotifications = await Message.find({ userId: req.userId, sessionId: 'reply-notification' }).sort({ createdAt: -1 });
        const adminMessages = await Message.find({ userId: req.userId, sessionId: 'admin-direct-message' }).sort({ createdAt: -1 });
        const allNotifications = [...replyNotifications, ...adminMessages].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        res.json(allNotifications);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════
//  NYLAS AUTH
// ════════════════════════════════════════════
app.get('/api/auth/nylas/url', verifyToken, (req, res) => {
    const userId = req.userId;
    const randomState = uuidv4();
    stateStore[randomState] = userId;
    setTimeout(() => { delete stateStore[randomState]; }, 10 * 60 * 1000);
    res.json({ url: getAuthUrl(randomState) });
});

app.get('/api/auth/nylas/callback', async (req, res) => {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=false&error=' + oauthError);
    if (!code || !state) return res.status(400).send('Missing required parameters.');
    const userId = stateStore[state];
    if (!userId) return res.status(400).send('Session expired. Please try connecting again.');
    delete stateStore[state];
    try {
        const tokenData = await exchangeCodeForToken(code);
        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token;
        const grantId = tokenData.grant_id;

        if (!refreshToken) {
            console.error('❌ [NYLAS CALLBACK] No refresh_token returned from Nylas! Ensure offline_access scope is enabled in your Nylas app settings.');
        }
        let emailAddress = 'unknown@nylas.com';
        try {
            emailAddress = await getUserEmail(accessToken);
        } catch (emailErr) {
            console.warn(`⚠️ Could not retrieve email: ${emailErr.message}`);
        }

        await User.findByIdAndUpdate(userId, {
            'nylasIntegration.accessToken': accessToken,
            'nylasIntegration.emailAddress': emailAddress,
            'nylasIntegration.isConnected': true,
            'nylasIntegration.connectedAt': new Date()
        });

        if (grantId) {
            const saved = await EmailAccount.findOneAndUpdate(
                { nylasGrantId: grantId },
                {
                    userId,
                    emailAddress,
                    isConnected: true,
                    provider: 'gmail',
                    accessToken,
                    refreshToken,
                    tokenExpiry: new Date(Date.now() + 3600 * 1000),
                    refreshFailCount: 0,
                    lastRefreshError: null
                },
                { upsert: true, new: true }
            );
            console.log(`✅ [AUTH] Grant ${grantId} linked to User ${userId} — refreshToken saved: ${!!saved.refreshToken}`);
        }

        res.redirect('https://skylineai-app.vercel.app/dashboard.html?connected=true');
    } catch (err) {
        console.error(`❌ Nylas Callback Error: ${err.message}`);
        res.redirect(`https://skylineai-app.vercel.app/dashboard.html?connected=false&error=token_exchange_failed`);
    }
});

// ════════════════════════════════════════════
//  CHAT & DREAMS ROUTES (extracted)
// ════════════════════════════════════════════
app.post('/api/chat', verifyToken, checkSubscriptionExpiry, checkDailyLimit, chatController.sendMessage);
app.post('/api/feedback', verifyToken, chatController.submitFeedback);
app.get('/api/sessions', verifyToken, checkSubscriptionExpiry, chatController.getSessions);
app.get('/api/history/:sessionId', verifyToken, checkSubscriptionExpiry, chatController.getHistory);
app.post('/api/dreams/analyze', verifyToken, checkSubscriptionExpiry, checkDailyLimit, chatController.analyzeDream);
app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, chatController.refineDream);

// ════════════════════════════════════════════
//  USER PROFILE ROUTES (extracted)
// ════════════════════════════════════════════
app.get('/api/users/me', verifyToken, checkSubscriptionExpiry, userController.getUserProfile);
app.put('/api/users/me', verifyToken, checkSubscriptionExpiry, userController.updateUserProfile);
app.put('/api/auth/change-password', verifyToken, userController.changePassword);
app.put('/api/auth/change-email', verifyToken, userController.changeEmail);
app.put('/api/users/verify-age', verifyToken, userController.verifyAge);
app.delete('/api/users/me', verifyToken, userController.deleteUserAccount);

// ════════════════════════════════════════════
//  OTHER ROUTES (admin, reports, notifications, etc.)
// ════════════════════════════════════════════
app.get('/api/notifications/replies', verifyToken, async (req, res) => {
    try {
        const repliedLeads = await Lead.find({ userId: req.userId, status: 'Replied' }).sort({ lastContactDate: -1 });
        res.json({ count: repliedLeads.length, leads: repliedLeads });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.post('/api/admin/verify-layer-2', verifyToken, verifyLayer2);
app.post('/api/admin/verify-layer-3', verifyToken, verifyLayer3);

app.get('/api/admin/users', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user || !user.isAdmin) return res.status(403).json({ message: 'Access denied. Admins only.' });
        const users = await User.find().select('-password');
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.put('/api/admin/users/:id/suspend', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        targetUser.isSuspended = !targetUser.isSuspended;
        targetUser.suspensionEnds = targetUser.isSuspended ? new Date('2099-12-31') : null;
        await targetUser.save();
        res.json({ message: 'Status updated' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.delete('/api/admin/users/:id', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'User deleted' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/admin/users/:id/details', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const messages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, history: messages });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/admin/users/:id/chat-view', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const targetUser = await User.findById(req.params.id).select('-password');
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        const chatMessages = await Message.find({ userId: req.params.id }).sort({ createdAt: 1 });
        res.json({ user: targetUser, messages: chatMessages });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.post('/api/admin/users/:id/message', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const { messageContent } = req.body;
        if (!messageContent) return res.status(400).json({ message: 'Message content is required' });
        const targetUser = await User.findById(req.params.id);
        if (!targetUser) return res.status(404).json({ message: 'User not found' });
        await new Message({
            userId: req.params.id,
            sessionId: 'admin-direct-message',
            role: 'ai',
            content: `[ADMIN MESSAGE]: ${messageContent}`,
            title: 'Direct Message from Admin'
        }).save();
        res.json({ message: 'Message sent successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.post('/api/reports', verifyToken, async (req, res) => {
    try {
        const { subject, message } = req.body;
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        await new Report({ userId: req.userId, username: user.username, subject, message }).save();
        res.json({ message: 'Report submitted successfully' });
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/admin/reports', verifyToken, async (req, res) => {
    try {
        const admin = await User.findById(req.userId);
        if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Access denied' });
        const reports = await Report.find().sort({ createdAt: -1 });
        res.json(reports);
    } catch (err) {
        res.status(500).json({ message: 'Server Error' });
    }
});

app.get('/api/notifications/count', verifyToken, async (req, res) => {
    try {
        const adminCount = await Message.countDocuments({ userId: req.userId, sessionId: 'admin-direct-message' });
        const replyCount = await Message.countDocuments({ userId: req.userId, sessionId: 'reply-notification' });
        res.json({ count: adminCount + replyCount });
    } catch (err) {
        res.status(500).json({ message: 'Server Error counting notifications' });
    }
});

// ════════════════════════════════════════════
//  EXPIRY CHECK JOB
// ════════════════════════════════════════════
const scheduleExpiryCheck = async () => {
    try {
        const result = await User.updateMany(
            { subscriptionTier: { $ne: 'free' }, subscriptionEndDate: { $lt: new Date() } },
            { subscriptionTier: 'free', subscriptionEndDate: null }
        );
        if (result.modifiedCount > 0) console.log(`🔄 Downgraded ${result.modifiedCount} expired users`);
    } catch (err) {
        console.error('Error in expiry check:', err);
    }
};
setTimeout(() => {
    scheduleExpiryCheck();
    setInterval(scheduleExpiryCheck, 24 * 60 * 60 * 1000);
}, 5000);

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}`); });
