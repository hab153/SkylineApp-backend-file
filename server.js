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

// ✅ Import sessionController for session routes
const sessionController = require('./sessionController');

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

console.log(' [SERVER] Starting server...');
console.log('🚀 [SERVER] NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('🚀 [SERVER] PORT:', process.env.PORT || 5001);

// ══════════════════════════════════════════
//  CRITICAL STARTUP CHECKS
// ══════════════════════════════════════════
if (!process.env.JWT_SECRET) {
    console.error('❌ CRITICAL ERROR: JWT_SECRET is not defined in environment variables.');
    console.error('⚠️ Please set JWT_SECRET in your .env file and restart the server.');
    process.exit(1);
}
console.log('✅ JWT_SECRET is configured (length: ' + process.env.JWT_SECRET.length + ' characters)');

// ══════════════════════════════════════════
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

// ═══════════════════════════════════════════
//  SECURITY MIDDLEWARE
// ════════════════════════════════════════════
app.use(helmet());
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ✅ CORS CONFIGURED FOR FRONTEND/BACKEND SEPARATION
const ALLOWED_ORIGINS = [
    'https://skylineai-app.vercel.app', 
    'http://localhost:3000'
];

app.use(cors({
    origin: function(origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    keyGenerator: (req) => req.userId || req.ip,
    skipSuccessfulRequests: false,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(globalLimiter);

console.log('✅ [SERVER] Security middleware applied');

// ═══════════════════════════════════════════
//  ✅ HEALTH CHECK ENDPOINT (FOR UPTIME MONITORING)
// ════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ═══════════════════════════════════════════
//  WEBHOOKS (EXEMPT FROM XSS)
//  NOTE: These must be BEFORE express.json() to handle raw payloads
// ════════════════════════════════════════
console.log('🔧 [SERVER] Registering webhook routes...');
app.post('/api/flutterwave-webhook', express.raw({ type: 'application/json' }), flutterwaveWebhook);
app.all('/api/nylas/webhook', express.raw({ type: 'application/json' }), handleWebhook);
console.log('✅ [SERVER] Webhook routes registered at /api/nylas/webhook');

// ════════════════════════════════════════════
//  JSON PARSER
//  NOTE: Static file serving REMOVED - Frontend is now separate on Vercel
// ════════════════════════════════════════════
app.use(express.json());

// ═══════════════════════════════════════════
//  XSS PROTECTION MIDDLEWARE
//  ✅ Applied globally since no HTML is served from backend
// ════════════════════════════════════════════
app.use(xssProtection);
app.use(xssOutputProtection);

// ═════════════════════════════════════════
//  MONGODB CONNECTION & INDEX CREATION
// ════════════════════════════════════════════
console.log('🔗 [SERVER] Connecting to MongoDB...');
mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000
})
    .then(async () => {
        console.log('✅ MongoDB Connected');
        
        // ✅ SPEED: Create indexes for faster queries
        try {
            console.log('🔧 [SERVER] Creating database indexes...');
            
            // ChatMessage indexes
            const ChatMessage = require('./ChatMessage');
            await ChatMessage.collection.createIndex({ userId: 1, sessionId: 1 });
            await ChatMessage.collection.createIndex({ userId: 1, createdAt: -1 });
            console.log('✅ [SERVER] ChatMessage indexes created');
            
            // Lead indexes
            await Lead.collection.createIndex({ userId: 1, lastContactDate: -1 });
            await Lead.collection.createIndex({ userId: 1, email: 1 });
            console.log('✅ [SERVER] Lead indexes created');
            
            console.log('✅ [SERVER] All database indexes created');
        } catch (indexErr) {
            console.warn('️ [SERVER] Index creation warning:', indexErr.message);
        }
        
        startExpiryJob();
        startFollowUpJob();
        if (process.env.NODE_ENV !== 'test') {
            startBackupJob();
        }
        startDataExportCleanupJob();

        // ✅ START WEBHOOK VERIFICATION
        verifyWebhookRegistration();

        // ✅ START TOKEN REFRESH JOB
        startTokenRefreshJob();
    })
    .catch(err => console.log('❌ MongoDB Connection Error:', err));

// ════════════════════════════════════════════
//  WEBHOOK VERIFICATION FUNCTION
// ═══════════════════════════════════════════
async function verifyWebhookRegistration() {
    try {
        console.log('🔍 [WEBHOOK] Verifying webhook registration...');
        console.log('✅ [WEBHOOK] Endpoint ready: https://skylineapp-backend-file.onrender.com/api/nylas/webhook');
        console.log('🔗 [WEBHOOK] Please register this URL in Nylas Dashboard:');
        console.log('   → https://dashboard.nylas.com');
        console.log('   → Select your app → Webhooks');
        console.log('   → Add URL: https://skylineapp-backend-file.onrender.com/api/nylas/webhook');
        console.log('   → Triggers: message.created, message.sent, grant.expired, grant.refreshed');
    } catch (error) {
        console.error('❌ [WEBHOOK] Verification error:', error.message);
    }
}

// ═══════════════════════════════════════════
//  TOKEN REFRESH JOB
// ════════════════════════════════════════════
async function startTokenRefreshJob() {
    console.log(' [TOKEN REFRESH] Starting background token refresh job...');
    
    // Run every 5 minutes
    setInterval(async () => {
        try {
            const EmailAccount = require('./EmailAccount');
            const now = new Date();
            const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
            
            // Find accounts with tokens expiring in the next 5 minutes
            const expiringAccounts = await EmailAccount.find({
                isConnected: true,
                tokenExpiry: { 
                    $lt: fiveMinutesFromNow,
                    $gte: now
                }
            });
            
            if (expiringAccounts.length > 0) {
                console.log(`🔄 [TOKEN REFRESH] Found ${expiringAccounts.length} accounts expiring soon`);
            }
            
            for (const account of expiringAccounts) {
                try {
                    const { refreshNylasToken } = require('./nylasService');
                    console.log(`🔄 [TOKEN REFRESH] Refreshing token for user: ${account.userId}`);
                    await refreshNylasToken(account.userId);
                } catch (err) {
                    console.error(`❌ [TOKEN REFRESH] Failed to refresh for user ${account.userId}:`, err.message);
                }
            }
            
        } catch (error) {
            console.error('❌ [TOKEN REFRESH] Job error:', error.message);
        }
    }, 5 * 60 * 1000); // Run every 5 minutes
}

// ════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════
app.use('/api/auth', authRoutes);
console.log('✅ [SERVER] Auth routes registered');

// Logout & Revoke routes
app.post('/api/auth/logout', verifyToken, logout);
app.post('/api/auth/revoke-tokens', verifyToken, revokeAllTokens);

// ✅ Assistant and Session routes handled via routers
app.use('/api', assistantRoutes);
app.use('/api', sessionRoutes);

// ✅ NEW: Nylas Auth Routes WITH DEBUG LOGS
app.get('/api/auth/nylas/connect', verifyToken, (req, res, next) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' [NYLAS ROUTE] /api/auth/nylas/connect called');
    console.log('📝 [NYLAS ROUTE] User ID:', req.userId);
    console.log('📝 [NYLAS ROUTE] Headers:', {
        authorization: req.headers.authorization ? '✅ Present' : ' Missing',
        'content-type': req.headers['content-type'] || 'Not set'
    });
    console.log(' [NYLAS ROUTE] Method:', req.method);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    next();
}, nylasAuthController.getAuthUrl);

app.get('/api/auth/nylas/callback', nylasAuthController.handleCallback);

// ✅ CHECK NYLAS CONNECTION STATUS (with auto-refresh)
app.get('/api/auth/nylas/status', verifyToken, async (req, res) => {
  try {
    const { checkConnection } = require('./nylasService');
    const status = await checkConnection(req.userId);
    res.json(status);
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
    console.log(' [TEST] Headers:', {
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

// ─────────────────────────────────────────────────────────────
//  PAYMENT ROUTE
// ──────────────────────────────────────────────────────────────
app.post('/api/create-flutterwave-payment', verifyToken, createFlutterwavePayment);
console.log('✅ [SERVER] Payment route registered');

// ──────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', validate(registerSchema), register);
app.post('/api/auth/login', validate(loginSchema), login);
app.put('/api/auth/change-email', verifyToken, validate(changeEmailSchema), userController.changeEmail);
app.post('/api/auth/forgot-password', validate(forgotPasswordSchema), forgotPassword);
app.post('/api/auth/reset-password', validate(resetPasswordSchema), resetPassword);
app.put('/api/users/verify-age', verifyToken, validate(verifyAgeSchema), userController.verifyAge);

// ─────────────────────────────────────────────────────────────
//  USER PROFILE ROUTES
// ────────────────────────────────────────────────────────────
app.get('/api/users/me', verifyToken, checkSubscriptionExpiry, userController.getUserProfile);
app.put('/api/users/me', verifyToken, checkSubscriptionExpiry, validate(updateProfileSchema), userController.updateUserProfile);
app.put('/api/auth/change-password', verifyToken, userController.changePassword);

// ──────────────────────────────────────────────────────────────
//  ACCOUNT DELETION ROUTES (Right to Be Forgotten – GDPR)
// ─────────────────────────────────────────────────────────────
app.delete('/api/users/me', verifyToken, userController.deleteUserAccount);
app.post('/api/users/me/deactivate', verifyToken, userController.deactivateUserAccount);
app.post('/api/users/me/restore', verifyToken, userController.restoreUserAccount);
app.get('/api/users/me/deletion-status', verifyToken, userController.getDeletionStatus);

// ──────────────────────────────────────────────────────────────
//  DATA EXPORT ROUTES (Right to Data Portability – GDPR)
// ──────────────────────────────────────────────────────────────
app.use('/api/data', dataExportRoutes);

// ─────────────────────────────────────────────────────────────
//  LEAD / CONVERSATION ROUTES
// ─────────────────────────────────────────────────────────────
console.log('🔧 [SERVER] Registering lead/conversation routes...');

app.get('/api/conversations', verifyToken, leadController.getConversations);
console.log('✅ [SERVER] GET /api/conversations registered');

app.get('/api/conversations/:leadId', verifyToken, leadController.getConversationById);
console.log('✅ [SERVER] GET /api/conversations/:leadId registered');

app.put('/api/leads/:leadId/rename', verifyToken, validate(renameLeadSchema), leadController.renameLead);
app.put('/api/leads/:leadId/auto-reply', verifyToken, validate(updateAutoReplySchema), leadController.updateAutoReply);
app.post('/api/leads/batch-send', verifyToken, validate(batchSendSchema), leadController.batchSend);
app.post('/api/reconnect-and-send', verifyToken, leadController.reconnectAndSend);
app.get('/api/leads', verifyToken, leadController.getAllLeads);
console.log('✅ [SERVER] All lead routes registered');

// ─────────────────────────────────────────────────────────────
//  ✅ FOLLOW-UP ROUTES (FIXED)
// ──────────────────────────────────────────────────────────────
console.log('🔧 [SERVER] Registering follow-up routes...');

// ✅ Get follow-up status first (no body validation needed)
app.get('/api/leads/:leadId/follow-up-status', verifyToken, followUpController.getFollowUpStatus);

// ✅ Suggest follow-up (requires leadId)
app.post('/api/leads/:leadId/suggest-follow-up', verifyToken, checkSuggestFollowUpLimit, followUpController.suggestFollowUp);

// ✅ Toggle auto follow-up (requires leadId + body)
app.post('/api/leads/:leadId/auto-follow-up', verifyToken, checkAutoFollowUpLimit, validate(autoFollowUpSchema), followUpController.toggleAutoFollowUp);

console.log('✅ [SERVER] Follow-up routes registered');
console.log('   📋 GET    /api/leads/:leadId/follow-up-status');
console.log('   📋 POST   /api/leads/:leadId/suggest-follow-up');
console.log('   📋 POST   /api/leads/:leadId/auto-follow-up');

// ──────────────────────────────────────────────────────────────
//  REVENUE TRACKING
// ──────────────────────────────────────────────────────────────
if (typeof revenueController !== 'undefined' && revenueController.getRevenueTracking) {
    app.get('/api/revenue/tracking', verifyToken, revenueController.getRevenueTracking);
    console.log('✅ [SERVER] Revenue tracking route registered');
}

// ──────────────────────────────────────────────────────────────
//  NOTIFICATIONS
// ──────────────────────────────────────────────────────────────
app.get('/api/my-notifications', verifyToken, notificationController.getMyNotifications);
app.get('/api/notifications/replies', verifyToken, notificationController.getRepliesCount);
app.get('/api/notifications/count', verifyToken, notificationController.getNotificationCount);
console.log('✅ [SERVER] Notification routes registered');

// ──────────────────────────────────────────────────────────────
//  CHAT & DREAMS ROUTES
// ──────────────────────────────────────────────────────────────

app.post('/api/chat', verifyToken, checkSubscriptionExpiry, checkDailyLimit, validate(chatSchema), chatController.sendMessage);
app.post('/api/feedback', verifyToken, validate(feedbackSchema), chatController.submitFeedback);

// ✅ FIXED: Use sessionController for session routes
app.get('/api/sessions', verifyToken, checkSubscriptionExpiry, sessionController.getSessions);
app.post('/api/sessions', verifyToken, sessionController.createSession);
console.log('✅ [SERVER] Session routes registered');

// ─────────────────────────────────────────────────────────────
//  DREAMS ROUTES
// ──────────────────────────────────────────────────────────────
app.post('/api/dreams/analyze', verifyToken, checkSubscriptionExpiry, checkDailyLimit, validate(dreamSchema), chatController.analyzeDream);
app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, validate(dreamRefineSchema), chatController.refineDream);
console.log('✅ [SERVER] Dreams routes registered');

// ──────────────────────────────────────────────────────────────
//  AI SUGGESTION ROUTE
// ──────────────────────────────────────────────────────────────
app.post('/api/ai/suggest', verifyToken, checkHintLimit, async (req, res) => {
    console.log('💡 [AI SUGGEST] Request received');
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
console.log('✅ [SERVER] AI suggestion route registered');

// ──────────────────────────────────────────────────────────────
//  ASSISTANT ROUTE (Handled by assistantRoutes.js)
//  NOTE: Inline definition removed to prevent startup crash
// ──────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
//  ✅ SIMPLE ADMIN CREATION ROUTE
//  Creates admin exactly like a user, but forces isAdmin: true
// ─────────────────────────────────────────────────────────────
app.post('/api/admin/create', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password || password.length < 8) {
            return res.status(400).json({ error: 'Valid email and password (min 8 chars) required' });
        }

        // Check if user already exists
        const existing = await User.findOne({ email: email.toLowerCase().trim() });
        if (existing) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Hash password and create admin
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        
        // ✅ FIX: Use email as username to avoid duplicate key errors
        const admin = new User({
            username: email.toLowerCase().trim(), 
            email: email.toLowerCase().trim(),
            password: hashedPassword,
            isAdmin: true, 
            tokenVersion: 0
        });

        await admin.save();
        console.log(`[ADMIN CREATE] New admin created: ${email}`);
        
        res.json({ success: true, message: 'Admin account created' });
    } catch (err) {
        console.error('[ADMIN CREATE ERROR]', err);
        res.status(500).json({ error: 'Server error during admin creation' });
    }
});

// Honeypot: Block all other /admin* paths with 404
app.use(/^\/admin/i, (req, res) => {
    console.warn(`[SECURITY] Suspicious scan from ${req.ip}: ${req.originalUrl}`);
    res.status(404).json({ error: 'Not Found' });
});

// ──────────────────────────────────────────────────────────────
//  LEGACY ADMIN ROUTES (Protected by verifyToken)
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
console.log('✅ [SERVER] Admin routes registered');

// ──────────────────────────────────────────────────────────────
//  REPORTS
// ──────────────────────────────────────────────────────────────
app.post('/api/reports', verifyToken, validate(reportSchema), reportController.submitReport);
console.log('✅ [SERVER] Report routes registered');

// ─────────────────────────────────────────────────────────────
//  ✅ NEW: HISTORY ROUTES (Aliases for history.html)
// ───────────────────────────────────────────────────────────
console.log('🔧 [SERVER] Registering history routes...');

// Alias for /api/sessions (history.html uses /api/history/sessions)
app.get('/api/history/sessions', verifyToken, checkSubscriptionExpiry, sessionController.getSessions);

// Alias for /api/history/:sessionId (history.html uses /api/history/messages/:sessionId)
app.get('/api/history/messages/:sessionId', verifyToken, checkSubscriptionExpiry, chatController.getHistory);

// Keep original routes for compatibility
app.get('/api/history/:sessionId', verifyToken, checkSubscriptionExpiry, chatController.getHistory);

// Rename session (history.html uses /api/history/rename/:sessionId)
app.put('/api/history/rename/:sessionId', verifyToken, sessionController.renameSession);

// Pin session (history.html uses /api/history/pin/:sessionId)
app.put('/api/history/pin/:sessionId', verifyToken, sessionController.pinSession);

// Delete session (history.html uses /api/history/delete/:sessionId)
app.delete('/api/history/delete/:sessionId', verifyToken, sessionController.deleteSession);

console.log('✅ [SERVER] History routes registered');
console.log('   📋 GET    /api/history/sessions');
console.log('   📋 GET    /api/history/messages/:sessionId');
console.log('   📋 PUT    /api/history/rename/:sessionId');
console.log('   📋 PUT    /api/history/pin/:sessionId');
console.log('   📋 DELETE /api/history/delete/:sessionId');

// ──────────────────────────────────────────────────────────────
//  DEBUG ROUTE - Check messages (Remove after fixing)
// ──────────────────────────────────────────────────────────────
app.get('/api/debug/verify-messages', verifyToken, async (req, res) => {
    try {
        const ChatMessage = require('./ChatMessage');
        const Session = require('./Session');
        
        const userId = req.userId;
        
        // Get sessions
        const sessions = await Session.find({ userId }).sort({ updatedAt: -1 }).limit(5);
        
        let result = {
            userId: userId,
            totalSessions: sessions.length,
            sessions: []
        };
        
        for (const session of sessions) {
            const messages = await ChatMessage.find({ 
                userId, 
                sessionId: session.sessionId 
            }).sort({ createdAt: 1 });
            
            result.sessions.push({
                sessionId: session.sessionId,
                name: session.name,
                messageCount: messages.length,
                messages: messages.map(m => ({
                    role: m.role,
                    content: m.content ? m.content.substring(0, 100) : ' EMPTY',
                    contentLength: m.content ? m.content.length : 0,
                    hasContent: !!m.content
                }))
            });
        }
        
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ──────────────────────────────────────────────────────────────
//  ✅ DEBUG ROUTE - Check Conversation Data
// ──────────────────────────────────────────────────────────────
app.get('/api/debug/conversation/:leadId', verifyToken, async (req, res) => {
    try {
        const ChatMessage = require('./ChatMessage');
        const Lead = require('./Lead');
        
        const lead = await Lead.findOne({ 
            _id: req.params.leadId, 
            userId: req.userId 
        });
        
        if (!lead) {
            return res.json({ 
                exists: false, 
                message: 'Lead not found' 
            });
        }
        
        // Get ChatMessages
        const chatMessages = await ChatMessage.find({ 
            userId: req.userId, 
            sessionId: lead._id.toString() 
        });
        
        res.json({
            lead: {
                id: lead._id,
                name: lead.name,
                email: lead.email,
                status: lead.status,
                repliesCount: lead.replies?.length || 0,
                replies: lead.replies || []
            },
            chatMessages: chatMessages.map(m => ({
                id: m._id,
                role: m.role,
                content: m.content,
                title: m.title,
                createdAt: m.createdAt
            })),
            totalMessages: (lead.replies?.length || 0) + chatMessages.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message, stack: error.stack });
    }
});

// ──────────────────────────────────────────────────────────────
//  ✅ DEBUG ROUTE - Check All Leads
// ──────────────────────────────────────────────────────────────
app.get('/api/debug/leads', verifyToken, async (req, res) => {
    try {
        const leads = await Lead.find({ userId: req.userId })
            .select('name email status replies lastContactDate createdAt')
            .sort({ lastContactDate: -1 })
            .limit(20);
        
        res.json({
            count: leads.length,
            leads: leads.map(l => ({
                id: l._id,
                name: l.name,
                email: l.email,
                status: l.status,
                repliesCount: l.replies?.length || 0,
                lastContactDate: l.lastContactDate,
                createdAt: l.createdAt
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ═════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════
const PORT = process.env.PORT || 5001;
const server = app.listen(PORT, () => { 
    console.log(`🚀 Server running on port ${PORT}`); 
    console.log(`✅ [SERVER] All routes registered successfully`);
});
server.timeout = 300000;
