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
const { startExpiryJob } = require('./expiryJob');
const flutterwaveWebhook = require('./flutterwaveWebhook');
const nylasInboundWebhook = require('./nylasInboundWebhook');
const { createFlutterwavePayment } = require('./Flutterwavepayment');
const leadController = require('./leadController');
const chatController = require('./chatController');
const userController = require('./userController');
const adminController = require('./adminController');
const notificationController = require('./notificationController');
const nylasAuthController = require('./nylasAuthController');
const reportController = require('./reportController');

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

dotenv.config();
const app = express();
app.use(cors());

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

// ════════════════════════════════════════════
//  MONGODB CONNECTION WITH LARGER POOL SIZE
// ════════════════════════════════════════════
mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000
})
    .then(() => {
        console.log('✅ MongoDB Connected');
        startTokenRefreshJob();
        startExpiryJob();
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
app.get('/api/my-notifications', verifyToken, notificationController.getMyNotifications);
app.get('/api/notifications/replies', verifyToken, notificationController.getRepliesCount);
app.get('/api/notifications/count', verifyToken, notificationController.getNotificationCount);

// ════════════════════════════════════════════
//  NYLAS AUTH
// ════════════════════════════════════════════
app.get('/api/auth/nylas/url', verifyToken, nylasAuthController.getAuthUrl);
app.get('/api/auth/nylas/callback', nylasAuthController.handleCallback);

// ════════════════════════════════════════════
//  CHAT & DREAMS ROUTES
// ════════════════════════════════════════════
app.post('/api/chat', verifyToken, checkSubscriptionExpiry, checkDailyLimit, chatController.sendMessage);
app.post('/api/feedback', verifyToken, chatController.submitFeedback);
app.get('/api/sessions', verifyToken, checkSubscriptionExpiry, chatController.getSessions);
app.get('/api/history/:sessionId', verifyToken, checkSubscriptionExpiry, chatController.getHistory);
app.post('/api/dreams/analyze', verifyToken, checkSubscriptionExpiry, checkDailyLimit, chatController.analyzeDream);
app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, chatController.refineDream);

// ════════════════════════════════════════════
//  USER PROFILE ROUTES
// ════════════════════════════════════════════
app.get('/api/users/me', verifyToken, checkSubscriptionExpiry, userController.getUserProfile);
app.put('/api/users/me', verifyToken, checkSubscriptionExpiry, userController.updateUserProfile);
app.put('/api/auth/change-password', verifyToken, userController.changePassword);
app.put('/api/auth/change-email', verifyToken, userController.changeEmail);
app.put('/api/users/verify-age', verifyToken, userController.verifyAge);
app.delete('/api/users/me', verifyToken, userController.deleteUserAccount);

// ════════════════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════════════════
app.post('/api/admin/verify-layer-2', verifyToken, adminController.adminVerifyLayer2);
app.post('/api/admin/verify-layer-3', verifyToken, adminController.adminVerifyLayer3);
app.get('/api/admin/users', verifyToken, adminController.getAllUsers);
app.put('/api/admin/users/:id/suspend', verifyToken, adminController.suspendUser);
app.delete('/api/admin/users/:id', verifyToken, adminController.deleteUser);
app.get('/api/admin/users/:id/details', verifyToken, adminController.getUserDetails);
app.get('/api/admin/users/:id/chat-view', verifyToken, adminController.getUserChatView);
app.post('/api/admin/users/:id/message', verifyToken, adminController.sendUserMessage);
app.get('/api/admin/reports', verifyToken, adminController.getAllReports);

// ════════════════════════════════════════════
//  REPORTS (user submission)
// ════════════════════════════════════════════
app.post('/api/reports', verifyToken, reportController.submitReport);

// ════════════════════════════════════════════
//  START SERVER WITH 5-MINUTE TIMEOUT
// ════════════════════════════════════════════
const PORT = process.env.PORT || 5001;
const server = app.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}`); });
server.timeout = 300000; // 5 minutes (300,000 ms)
