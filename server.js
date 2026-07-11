const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const crypto = require('crypto');

// MIDDLEWARE & UTILITIES
const { verifyToken } = require('./authMiddleware');
const { checkDailyLimit, checkHintLimit, checkSuggestFollowUpLimit, checkAutoFollowUpLimit, checkAssistantLimit } = require('./dailyLimitMiddleware');
const { checkSubscriptionExpiry } = require('./subscriptionMiddleware');

// ✅ NEW: Nylas imports
const nylasAuthController = require('./nylasAuthController');
const { handleWebhook } = require('./nylasWebhookHandler');

const { startExpiryJob } = require('./expiryJob');
const { startFollowUpJob } = require('./followUpJob');
const flutterwaveWebhook = require('./flutterwaveWebhook');

const { createFlutterwavePayment } = require('./Flutterwavepayment');
const leadController = require('./leadController');
const chatController = require('./chatController');
const userController = require('./userController');
const adminController = require('./adminController');
const notificationController = require('./notificationController');
const reportController = require('./reportController');
const followUpController = require('./followUpController');
const revenueController = require('./revenueController');

// AI SERVICES
const freeAI = require('./Free');
const goAI = require('./Go');
const { generateBusinessResponse } = require('./businessAI');
const { generateAIReply } = require('./aiReplyGenerator');
const { generateSuggestion } = require('./aiSuggestion');

// MODELS & SERVICES
const Lead = require('./Lead');
const authRoutes = require('./authRoutes');
const assistantRoutes = require('./assistantRoutes');
const sessionRoutes = require('./sessionRoutes');
const User = require('./User');
const Report = require('./Report');
const requestQueue = require('./requestQueue');

// Import auth controller functions
const { logout, revokeAllTokens, forgotPassword, resetPassword, register, login } = require('./authController');

// Validation imports
const { validate } = require('./validationMiddleware');
const {
    registerSchema,
    loginSchema,
    changeEmailSchema,
    resetPasswordSchema,
    forgotPasswordSchema,
    verifyAgeSchema,
    updateProfileSchema,
    batchSendSchema,
    renameLeadSchema,
    updateAutoReplySchema,
    chatSchema,
    feedbackSchema,
    adminMessageSchema,
    reportSchema,
    autoFollowUpSchema,
    assistantSchema,
    dreamSchema,
    dreamRefineSchema
} = require('./validationSchemas');

// Backup job
const { startBackupJob } = require('./backupJob');

// XSS protection
const { xssProtection, xssOutputProtection } = require('./xssMiddleware');

// Data Export Routes
const dataExportRoutes = require('./dataExportRoutes');

// Data Export Cleanup Job
const { startDataExportCleanupJob } = require('./dataExportJob');

dotenv.config();
const app = express();

// ════════════════════════════════════════════
//  CRITICAL STARTUP CHECKS
// ════════════════════════════════════════════
if (!process.env.JWT_SECRET) {
    console.error('❌ CRITICAL ERROR: JWT_SECRET is not defined in environment variables.');
    console.error('❌ Please set JWT_SECRET in your .env file and restart the server.');
    process.exit(1);
}
console.log('✅ JWT_SECRET is configured (length: ' + process.env.JWT_SECRET.length + ' characters)');

// ════════════════════════════════════════════
//  BACKUP CHECK
// ════════════════════════════════════════════
const fs = require('fs-extra');
const backupDir = process.env.BACKUP_DIR || './backups';

try {
    if (fs.existsSync(backupDir)) {
        const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.zip'));
        if (backups.length === 0) {
            console.warn('⚠️ [BACKUP] No backups found. Run "npm run backup" to create one.');
        } else {
            const latest = backups.sort().pop();
            const stats = fs.statSync(path.join(backupDir, latest));
            const days = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
            if (days > 7) {
                console.warn(`⚠️ [BACKUP] Last backup was ${days.toFixed(1)} days ago. Consider running "npm run backup".`);
            } else {
                console.log(`✅ [BACKUP] Recent backup found: ${latest} (${days.toFixed(1)} days old)`);
            }
        }
    } else {
        console.warn('⚠️ [BACKUP] Backup directory not found. Create one with "npm run backup".');
    }
} catch (err) {
    console.warn('⚠️ [BACKUP] Could not check backup status:', err.message);
}

// ════════════════════════════════════════════
//  SECURITY MIDDLEWARE
// ════════════════════════════════════════════
app.use(helmet());
app.disable('x-powered-by');
app.set('trust proxy', 1);

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    keyGenerator: (req) => req.userId || req.ip,
    skipSuccessfulRequests: false,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(globalLimiter);
app.use(cors());

// ════════════════════════════════════════════
//  WEBHOOKS (EXEMPT FROM XSS)
//  NOTE: These must be BEFORE express.json() to handle raw payloads
// ════════════════════════════════════════════
app.post('/api/flutterwave-webhook', express.raw({ type: 'application/json' }), flutterwaveWebhook);

// ✅ NEW: Nylas inbound webhook (Handles both GET for challenge and POST for events)
app.all('/api/nylas/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// ════════════════════════════════════════════
//  JSON PARSER & STATIC FILES
// ════════════════════════════════════════════
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ════════════════════════════════════════════
//  XSS PROTECTION MIDDLEWARE
// ════════════════════════════════════════════
app.use(xssProtection);
app.use(xssOutputProtection);

// ════════════════════════════════════════════
//  MONGODB CONNECTION
// ════════════════════════════════════════════
mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000
})
    .then(() => {
        console.log('✅ MongoDB Connected');
        
        startExpiryJob();
        startFollowUpJob();
        if (process.env.NODE_ENV !== 'test') {
            startBackupJob();
        }
        startDataExportCleanupJob();

        // ✅ START WEBHOOK VERIFICATION
        verifyWebhookRegistration();
    })
    .catch(err => console.log('❌ MongoDB Connection Error:', err));

// ════════════════════════════════════════════
//  WEBHOOK VERIFICATION FUNCTION
// ════════════════════════════════════════════
async function verifyWebhookRegistration() {
    try {
        console.log('🔍 [WEBHOOK] Verifying webhook registration...');
        
        // You can add a call to Nylas API to check webhook status here
        // For now, just log that the endpoint is ready
        
        console.log('✅ [WEBHOOK] Endpoint ready: https://skylineapp-backend-file.onrender.com/api/nylas/webhook');
        console.log('📋 [WEBHOOK] Please register this URL in Nylas Dashboard:');
        console.log('   → https://dashboard.nylas.com');
        console.log('   → Select your app → Webhooks');
        console.log('   → Add URL: https://skylineapp-backend-file.onrender.com/api/nylas/webhook');
        console.log('   → Triggers: message.created, message.sent, grant.expired, grant.refreshed');
    } catch (error) {
        console.error('❌ [WEBHOOK] Verification error:', error.message);
    }
}

// ════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════
app.use('/api/auth', authRoutes);

// Logout & Revoke routes
app.post('/api/auth/logout', verifyToken, logout);
app.post('/api/auth/revoke-tokens', verifyToken, revokeAllTokens);

app.use('/api', assistantRoutes);
app.use('/api', sessionRoutes);

// ✅ NEW: Nylas Auth Routes WITH DEBUG LOGS
app.get('/api/auth/nylas/connect', verifyToken, (req, res, next) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 [NYLAS ROUTE] /api/auth/nylas/connect called');
    console.log('📝 [NYLAS ROUTE] User ID:', req.userId);
    console.log('📝 [NYLAS ROUTE] Headers:', {
        authorization: req.headers.authorization ? '✅ Present' : '❌ Missing',
        'content-type': req.headers['content-type'] || 'Not set'
    });
    console.log('📝 [NYLAS ROUTE] Method:', req.method);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    next();
}, nylasAuthController.getAuthUrl);

// ❌ RESPONSE INTERCEPTOR REMOVED - It was converting & to &amp;

app.get('/api/auth/nylas/callback', nylasAuthController.handleCallback);

// ✅ CHECK NYLAS CONNECTION STATUS
app.get('/api/auth/nylas/status', verifyToken, async (req, res) => {
  try {
    const EmailAccount = require('./EmailAccount');
    
    // Check both EmailAccount and User models
    const emailAccount = await EmailAccount.findOne({ 
      userId: req.userId, 
      isConnected: true 
    });
    
    if (emailAccount) {
      // Check if token is expired
      const isExpired = emailAccount.tokenExpiry && new Date(emailAccount.tokenExpiry) < new Date();
      
      res.json({
        connected: true,
        email: emailAccount.emailAddress || 'Connected',
        isExpired: isExpired,
        grantId: emailAccount.nylasGrantId
      });
    } else {
      res.json({
        connected: false,
        email: null
      });
    }
  } catch (error) {
    console.error('❌ [NYLAS STATUS] Error:', error);
    res.status(500).json({ 
      connected: false, 
      error: 'Failed to check status' 
    });
  }
});

// ✅ TEST ROUTE: Check if callback route is reachable
app.get('/api/auth/nylas/test-callback', (req, res) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ [TEST] Callback test route hit!');
    console.log('📥 [TEST] Full URL:', req.originalUrl);
    console.log('📥 [TEST] Query params:', req.query);
    console.log('📥 [TEST] Headers:', {
        host: req.headers.host,
        'user-agent': req.headers['user-agent']
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    res.send(`
        <h1>✅ Test Callback Working!</h1>
        <p>If you see this, the route is accessible.</p>
        <p>Full URL: ${req.originalUrl}</p>
        <p>Query: ${JSON.stringify(req.query)}</p>
        <p>Time: ${new Date().toISOString()}</p>
        <hr>
        <p><strong>Next Steps:</strong></p>
        <ul>
            <li>Check if this matches your Nylas redirect URI</li>
            <li>Make sure this exact URI is whitelisted in Nylas Dashboard</li>
            <li>Try the actual callback: <a href="/api/auth/nylas/callback?test=123">/api/auth/nylas/callback?test=123</a></li>
        </ul>
    `);
});

// ──────────────────────────────────────────────────────────────
//  PAYMENT ROUTE
// ──────────────────────────────────────────────────────────────
app.post('/api/create-flutterwave-payment', verifyToken, createFlutterwavePayment);

// ──────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', validate(registerSchema), register);
app.post('/api/auth/login', validate(loginSchema), login);
app.put('/api/auth/change-email', verifyToken, validate(changeEmailSchema), userController.changeEmail);
app.post('/api/auth/forgot-password', validate(forgotPasswordSchema), forgotPassword);
app.post('/api/auth/reset-password', validate(resetPasswordSchema), resetPassword);
app.put('/api/users/verify-age', verifyToken, validate(verifyAgeSchema), userController.verifyAge);

// ──────────────────────────────────────────────────────────────
//  USER PROFILE ROUTES
// ──────────────────────────────────────────────────────────────
app.get('/api/users/me', verifyToken, checkSubscriptionExpiry, userController.getUserProfile);
app.put('/api/users/me', verifyToken, checkSubscriptionExpiry, validate(updateProfileSchema), userController.updateUserProfile);
app.put('/api/auth/change-password', verifyToken, userController.changePassword);

// ──────────────────────────────────────────────────────────────
//  ACCOUNT DELETION ROUTES (Right to Be Forgotten – GDPR)
// ──────────────────────────────────────────────────────────────
app.delete('/api/users/me', verifyToken, userController.deleteUserAccount);
app.post('/api/users/me/deactivate', verifyToken, userController.deactivateUserAccount);
app.post('/api/users/me/restore', verifyToken, userController.restoreUserAccount);
app.get('/api/users/me/deletion-status', verifyToken, userController.getDeletionStatus);

// ──────────────────────────────────────────────────────────────
//  DATA EXPORT ROUTES (Right to Data Portability – GDPR)
// ──────────────────────────────────────────────────────────────
app.use('/api/data', dataExportRoutes);

// ──────────────────────────────────────────────────────────────
//  LEAD / CONVERSATION ROUTES
// ──────────────────────────────────────────────────────────────
app.get('/api/conversations', verifyToken, leadController.getConversations);
app.get('/api/conversations/:leadId', verifyToken, leadController.getConversationById);
app.put('/api/leads/:leadId/rename', verifyToken, validate(renameLeadSchema), leadController.renameLead);
app.put('/api/leads/:leadId/auto-reply', verifyToken, validate(updateAutoReplySchema), leadController.updateAutoReply);
app.post('/api/leads/batch-send', verifyToken, validate(batchSendSchema), leadController.batchSend);
app.post('/api/reconnect-and-send', verifyToken, leadController.reconnectAndSend);
app.get('/api/leads', verifyToken, leadController.getAllLeads);

// ──────────────────────────────────────────────────────────────
//  FOLLOW-UP ROUTES
// ──────────────────────────────────────────────────────────────
app.post('/api/leads/:leadId/auto-follow-up', verifyToken, checkAutoFollowUpLimit, validate(autoFollowUpSchema), followUpController.toggleAutoFollowUp);
app.post('/api/leads/:leadId/suggest-follow-up', verifyToken, checkSuggestFollowUpLimit, followUpController.suggestFollowUp);
app.get('/api/leads/:leadId/follow-up-status', verifyToken, followUpController.getFollowUpStatus);

// ──────────────────────────────────────────────────────────────
//  REVENUE TRACKING
// ──────────────────────────────────────────────────────────────
if (typeof revenueController !== 'undefined' && revenueController.getRevenueTracking) {
    app.get('/api/revenue/tracking', verifyToken, revenueController.getRevenueTracking);
}

// ──────────────────────────────────────────────────────────────
//  NOTIFICATIONS
// ──────────────────────────────────────────────────────────────
app.get('/api/my-notifications', verifyToken, notificationController.getMyNotifications);
app.get('/api/notifications/replies', verifyToken, notificationController.getRepliesCount);
app.get('/api/notifications/count', verifyToken, notificationController.getNotificationCount);

// ──────────────────────────────────────────────────────────────
//  CHAT & DREAMS ROUTES
// ──────────────────────────────────────────────────────────────
app.post('/api/chat', verifyToken, checkSubscriptionExpiry, checkDailyLimit, validate(chatSchema), chatController.sendMessage);
app.post('/api/feedback', verifyToken, validate(feedbackSchema), chatController.submitFeedback);
app.get('/api/sessions', verifyToken, checkSubscriptionExpiry, chatController.getSessions);
app.get('/api/history/:sessionId', verifyToken, checkSubscriptionExpiry, chatController.getHistory);
app.post('/api/dreams/analyze', verifyToken, checkSubscriptionExpiry, checkDailyLimit, validate(dreamSchema), chatController.analyzeDream);
app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, validate(dreamRefineSchema), chatController.refineDream);

// ──────────────────────────────────────────────────────────────
//  AI SUGGESTION ROUTE
// ──────────────────────────────────────────────────────────────
app.post('/api/ai/suggest', verifyToken, checkHintLimit, async (req, res) => {
    try {
        const { messages } = req.body;
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Invalid message format.' });
        }
        const contextMessages = messages.slice(-3);
        const suggestion = await generateSuggestion(contextMessages);
        res.json({
            suggestion,
            remainingHints: req.remainingHints
        });
    } catch (error) {
        console.error('AI Suggestion Error:', error);
        res.status(500).json({ error: 'Failed to generate suggestion.' });
    }
});

// ──────────────────────────────────────────────────────────────
//  ASSISTANT ROUTE
// ──────────────────────────────────────────────────────────────
app.post('/api/assistant', verifyToken, checkAssistantLimit, validate(assistantSchema), require('./assistantController').assistantChat);

// ──────────────────────────────────────────────────────────────
//  ADMIN ROUTES
// ──────────────────────────────────────────────────────────────
app.post('/api/admin/verify-layer-2', verifyToken, adminController.adminVerifyLayer2);
app.post('/api/admin/verify-layer-3', verifyToken, adminController.adminVerifyLayer3);
app.get('/api/admin/users', verifyToken, adminController.getAllUsers);
app.put('/api/admin/users/:id/suspend', verifyToken, adminController.suspendUser);
app.delete('/api/admin/users/:id', verifyToken, adminController.deleteUser);
app.get('/api/admin/users/:id/details', verifyToken, adminController.getUserDetails);
app.get('/api/admin/users/:id/chat-view', verifyToken, adminController.getUserChatView);
app.post('/api/admin/users/:id/message', verifyToken, validate(adminMessageSchema), adminController.sendUserMessage);
app.get('/api/admin/reports', verifyToken, adminController.getAllReports);

// ──────────────────────────────────────────────────────────────
//  REPORTS
// ──────────────────────────────────────────────────────────────
app.post('/api/reports', verifyToken, validate(reportSchema), reportController.submitReport);

// ════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════
const PORT = process.env.PORT || 5001;
const server = app.listen(PORT, () => { console.log(`🚀 Server running on port ${PORT}`); });
server.timeout = 300000;
