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
const { verifyAdminToken } = require('./adminAuthMiddleware');
const { checkDailyLimit, checkHintLimit, checkSuggestFollowUpLimit, checkAutoFollowUpLimit, checkAssistantLimit } = require('./dailyLimitMiddleware');
const { checkSubscriptionExpiry } = require('./subscriptionMiddleware');

// Nylas imports
const nylasAuthController = require('./nylasAuthController');
const { handleWebhook } = require('./nylasWebhookHandler');

// ✅ SSE: Import shared SSE manager (no circular dependency)
const sseManager = require('./sseManager');

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

// Import sessionController for session routes
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

console.log('🚀 [SERVER] Starting server...');
console.log('🚀 [SERVER] NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('🚀 [SERVER] PORT:', process.env.PORT || 5001);

// ──────────────────────────────────────────────────────────────
//  ✅ JWT SECRET VALIDATION (ENHANCED - HARD FAILS)
// ──────────────────────────────────────────────────────────────

console.log('\n🔐 [SECURITY] Validating JWT secrets...');

function getEntropyRecommendation() {
    return '\n   💡 RECOMMENDED: Run this command to generate a secure secret:\n   node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';
}

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    console.error('❌ [SECURITY] JWT_SECRET is not defined in environment variables!');
    console.error(getEntropyRecommendation());
    process.exit(1);
}
if (jwtSecret.length < 32) {
    console.error('❌ [SECURITY] JWT_SECRET is too short. Minimum 32 characters required.');
    process.exit(1);
}
const weakSecrets = ['secret', 'password', '1234567890', 'jwtsecret', 'supersecret', 'mysecret', 'changeme', 'test', '1234', 'qwerty', 'admin', 'letmein', 'welcome', 'monkey', 'dragon', 'master', 'hello'];
const isWeak = weakSecrets.some(weak => jwtSecret.toLowerCase().includes(weak) || weak.toLowerCase().includes(jwtSecret.toLowerCase()));
if (isWeak) {
    console.error('❌ [SECURITY] JWT_SECRET appears to contain a weak/common pattern. Use a cryptographically random string.');
    process.exit(1);
}
console.log('✅ [SECURITY] JWT_SECRET is configured and validated');

const adminJwtSecret = process.env.ADMIN_JWT_SECRET;
if (!adminJwtSecret) {
    console.error('❌ [SECURITY] ADMIN_JWT_SECRET is not defined!');
    process.exit(1);
}
if (adminJwtSecret.length < 32) {
    console.error('❌ [SECURITY] ADMIN_JWT_SECRET is too short. Minimum 32 characters required.');
    process.exit(1);
}
if (adminJwtSecret === jwtSecret) {
    console.error('❌ [SECURITY] ADMIN_JWT_SECRET must be different from JWT_SECRET!');
    process.exit(1);
}
const isAdminWeak = weakSecrets.some(weak => adminJwtSecret.toLowerCase().includes(weak) || weak.toLowerCase().includes(adminJwtSecret.toLowerCase()));
if (isAdminWeak) {
    console.error('❌ [SECURITY] ADMIN_JWT_SECRET appears to contain a weak/common pattern. Use a cryptographically random string.');
    process.exit(1);
}
console.log('✅ [SECURITY] ADMIN_JWT_SECRET is configured and distinct.');

const requiredEnvVars = ['NYLAS_CLIENT_ID', 'NYLAS_API_KEY', 'FLUTTERWAVE_SECRET_KEY', 'FLUTTERWAVE_SECRET_HASH', 'MONGODB_URI'];
const missingEnvVars = requiredEnvVars.filter(varName => { const value = process.env[varName]; return !value || value.trim() === ''; });
if (missingEnvVars.length > 0) {
    console.error('❌ CRITICAL ERROR: Missing required environment variables:', missingEnvVars.join(', '));
    process.exit(1);
}
console.log('✅ All required environment variables are configured');

// ─── BACKUP CHECK ───
const fs = require('fs-extra');
const backupDir = process.env.BACKUP_DIR || './backups';
try {
    if (fs.existsSync(backupDir)) {
        const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.zip'));
        if (backups.length === 0) console.warn('⚠️ [BACKUP] No backups found.');
        else {
            const latest = backups.sort().pop();
            const stats = fs.statSync(path.join(backupDir, latest));
            const days = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
            if (days > 7) console.warn('⚠️ [BACKUP] Last backup was ' + days.toFixed(1) + ' days ago.');
            else console.log('✅ [BACKUP] Recent backup found: ' + latest);
        }
    } else console.warn('⚠️ [BACKUP] Backup directory not found.');
} catch (err) { console.warn('⚠️ [BACKUP] Could not check backup status:', err.message); }

// ─── SECURITY MIDDLEWARE ───
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://*.googletagmanager.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "https://skylineapp-backend-file.onrender.com", "https://*.google-analytics.com", "https://*.analytics.google.com"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));
app.disable('x-powered-by');
app.set('trust proxy', 1);

const ALLOWED_ORIGINS = ['https://skylineai-app.vercel.app', 'http://localhost:3000'];
app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.indexOf(origin) !== -1) callback(null, true);
        else callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));

// ✅ Strict Rate Limiters for Auth Endpoints
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => req.body.identifier || req.body.email || req.ip,
    message: { success: false, message: 'Too many login attempts. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    keyGenerator: (req) => req.ip,
    message: { success: false, message: 'Too many registration attempts. Please try again in 1 hour.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const resetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => req.body.email || req.ip,
    message: { success: false, message: 'Too many reset attempts. Please try again in 1 hour.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req) => req.body.email || req.ip,
    message: { success: false, message: 'Too many admin login attempts. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 200,
    keyGenerator: (req) => req.userId || req.ip,
    skipSuccessfulRequests: false, standardHeaders: true, legacyHeaders: false,
});
app.use(globalLimiter);
console.log('✅ [SERVER] Security middleware applied');

// ─── HEALTH CHECK ───
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() });
});

// ✅ SSE: Accept token from query string for EventSource (which can't send custom headers)
app.use('/api/events/stream', function(req, res, next) {
    if (req.query.token && !req.headers.authorization) {
        req.headers.authorization = 'Bearer ' + req.query.token;
    }
    next();
});

// ✅ SSE: Real-time event stream endpoint — browser connects via EventSource
app.get('/api/events/stream', verifyToken, function(req, res) {
    var userId = String(req.userId);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': 'https://skylineai-app.vercel.app',
        'Access-Control-Allow-Credentials': 'true'
    });

    res.write('data: ' + JSON.stringify({ type: 'connected', time: Date.now() }) + '\n\n');

    sseManager.addClient(userId, res);
    console.log('📡 [SSE] Client connected: ' + userId + ' (total: ' + sseManager.getClientCount() + ')');

    req.on('close', function() {
        sseManager.removeClient(userId);
        console.log('📡 [SSE] Client disconnected: ' + userId + ' (total: ' + sseManager.getClientCount() + ')');
    });

    req.on('error', function() {
        sseManager.removeClient(userId);
    });
});

// ✅ SSE: Heartbeat every 30 seconds to keep connections alive through Render proxy
setInterval(function() {
    var http = require('http');
    http.get('http://localhost:' + (process.env.PORT || 5001) + '/api/health', function(res) {
        res.resume();
    }).on('error', function() {});
}, 30000);

// ─── WEBHOOKS ───
console.log('🔧 [SERVER] Registering webhook routes...');
app.post('/api/flutterwave-webhook', express.raw({ type: 'application/json' }), flutterwaveWebhook);
app.all('/api/nylas/webhook', express.raw({ type: 'application/json' }), handleWebhook);
console.log('✅ [SERVER] Webhook routes registered at /api/nylas/webhook');

// ─── JSON PARSER ───
app.use(express.json());

// ─── XSS PROTECTION ───
app.use(xssProtection);
app.use(xssOutputProtection);

// ─── MONGODB CONNECTION ───
console.log('🔗 [SERVER] Connecting to MongoDB...');
mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 50, serverSelectionTimeoutMS: 5000 })
    .then(async () => {
        console.log('✅ MongoDB Connected');
        try {
            console.log('🔧 [SERVER] Creating database indexes...');
            const ChatMessage = require('./ChatMessage');
            await ChatMessage.collection.createIndex({ userId: 1, sessionId: 1 });
            await ChatMessage.collection.createIndex({ userId: 1, createdAt: -1 });
            console.log('✅ [SERVER] ChatMessage indexes created');
            await Lead.collection.createIndex({ userId: 1, lastContactDate: -1 });
            await Lead.collection.createIndex({ userId: 1, email: 1 });
            console.log('✅ [SERVER] Lead indexes created');
            console.log('✅ [SERVER] All database indexes created');
        } catch (indexErr) { console.warn('⚠️ [SERVER] Index creation warning:', indexErr.message); }
        startExpiryJob();
        startFollowUpJob();
        if (process.env.NODE_ENV !== 'test') startBackupJob();
        startDataExportCleanupJob();
        verifyWebhookRegistration();
        startTokenRefreshJob();
    })
    .catch(err => console.log('❌ MongoDB Connection Error:', err.message));

async function verifyWebhookRegistration() {
    try {
        console.log('🔍 [WEBHOOK] Verifying webhook registration...');
        console.log('✅ [WEBHOOK] Endpoint ready at /api/nylas/webhook');
        console.log('🔗 [WEBHOOK] Register this URL in Nylas Dashboard → Webhooks');
        console.log('   → Triggers: message.created, message.sent, grant.expired, grant.refreshed');
    } catch (error) { console.error('❌ [WEBHOOK] Verification error:', error.message); }
}

async function startTokenRefreshJob() {
    console.log('⏰ [TOKEN REFRESH] Starting background token refresh job...');
    setInterval(async () => {
        try {
            const EmailAccount = require('./EmailAccount');
            const now = new Date();
            const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
            const expiringAccounts = await EmailAccount.find({ isConnected: true, tokenExpiry: { $lt: fiveMinutesFromNow, $gte: now } });
            if (expiringAccounts.length > 0) console.log('🔄 [TOKEN REFRESH] Found ' + expiringAccounts.length + ' accounts expiring soon');
            for (const account of expiringAccounts) {
                try {
                    const { refreshNylasToken } = require('./nylasService');
                    console.log('🔄 [TOKEN REFRESH] Refreshing token for user ID: ' + account.userId);
                    await refreshNylasToken(account.userId);
                } catch (err) { console.error('❌ [TOKEN REFRESH] Failed to refresh for user ' + account.userId + ':', err.message); }
            }
        } catch (error) { console.error('❌ [TOKEN REFRESH] Job error:', error.message); }
    }, 5 * 60 * 1000);
}

// ════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════

app.use('/api/auth', authRoutes);
console.log('✅ [SERVER] Auth routes registered');

app.post('/api/auth/logout', verifyToken, logout);
app.post('/api/auth/revoke-tokens', verifyToken, revokeAllTokens);

app.use('/api', assistantRoutes);
app.use('/api', sessionRoutes);

// ─── NYLAS AUTH ROUTES ───
app.get('/api/auth/nylas/connect', verifyToken, (req, res, next) => {
    console.log('🔐 [NYLAS ROUTE] /api/auth/nylas/connect called');
    console.log('📝 [NYLAS ROUTE] User ID:', req.userId);
    console.log('📝 [NYLAS ROUTE] Method:', req.method);
    next();
}, nylasAuthController.getAuthUrl);

app.get('/api/auth/nylas/callback', nylasAuthController.handleCallback);

app.get('/api/auth/nylas/status', verifyToken, async (req, res) => {
  try {
    const { checkConnection } = require('./nylasService');
    const status = await checkConnection(req.userId);
    res.json(status);
  } catch (error) {
    console.error('❌ [NYLAS STATUS] Error:', error.message);
    res.status(500).json({ connected: false, error: 'Failed to check status' });
  }
});

app.get('/api/auth/nylas/test-callback', (req, res) => {
    console.log('✅ [TEST] Callback test route hit');
    res.status(200).json({ 
        status: 'ok', 
        message: 'Test callback route is accessible. Register your Nylas redirect URI in the Nylas Dashboard.',
        timestamp: new Date().toISOString()
    });
});

// ─── PAYMENT ROUTE ───
app.post('/api/create-flutterwave-payment', verifyToken, createFlutterwavePayment);
console.log('✅ [SERVER] Payment route registered');

// ─── AUTH ROUTES (WITH STRICT RATE LIMITING) ───
app.post('/api/auth/register', registerLimiter, validate(registerSchema), register);
app.post('/api/auth/login', loginLimiter, validate(loginSchema), login);
app.put('/api/auth/change-email', verifyToken, validate(changeEmailSchema), userController.changeEmail);
app.post('/api/auth/forgot-password', resetLimiter, validate(forgotPasswordSchema), forgotPassword);
app.post('/api/auth/reset-password', resetLimiter, validate(resetPasswordSchema), resetPassword);
app.put('/api/users/verify-age', verifyToken, validate(verifyAgeSchema), userController.verifyAge);

// ─── USER PROFILE ROUTES ───
app.get('/api/users/me', verifyToken, checkSubscriptionExpiry, userController.getUserProfile);
app.put('/api/users/me', verifyToken, checkSubscriptionExpiry, validate(updateProfileSchema), userController.updateUserProfile);
app.put('/api/auth/change-password', verifyToken, userController.changePassword);

// ─── GDPR ACCOUNT DELETION ROUTES ───
app.delete('/api/users/me', verifyToken, userController.deleteUserAccount);
app.post('/api/users/me/deactivate', verifyToken, userController.deactivateUserAccount);
app.post('/api/users/me/restore', verifyToken, userController.restoreUserAccount);
app.get('/api/users/me/deletion-status', verifyToken, userController.getDeletionStatus);

// ─── DATA EXPORT ROUTES ───
app.use('/api/data', dataExportRoutes);

// ─── LEAD / CONVERSATION ROUTES ───
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

// ─── FOLLOW-UP ROUTES ───
console.log('🔧 [SERVER] Registering follow-up routes...');
app.get('/api/leads/:leadId/follow-up-status', verifyToken, followUpController.getFollowUpStatus);
app.post('/api/leads/:leadId/suggest-follow-up', verifyToken, checkSuggestFollowUpLimit, followUpController.suggestFollowUp);
app.post('/api/leads/:leadId/auto-follow-up', verifyToken, checkAutoFollowUpLimit, validate(autoFollowUpSchema), followUpController.toggleAutoFollowUp);
console.log('✅ [SERVER] Follow-up routes registered');

// ─── REVENUE TRACKING ───
if (typeof revenueController !== 'undefined' && revenueController.getRevenueTracking) {
    app.get('/api/revenue/tracking', verifyToken, revenueController.getRevenueTracking);
    console.log('✅ [SERVER] Revenue tracking route registered');
}

// ─── NOTIFICATIONS ───
app.get('/api/my-notifications', verifyToken, notificationController.getMyNotifications);
app.get('/api/notifications/replies', verifyToken, notificationController.getRepliesCount);
app.get('/api/notifications/count', verifyToken, notificationController.getNotificationCount);
console.log('✅ [SERVER] Notification routes registered');

// ─── CHAT & DREAMS ROUTES ───
app.post('/api/chat', verifyToken, checkSubscriptionExpiry, checkDailyLimit, validate(chatSchema), chatController.sendMessage);
app.post('/api/feedback', verifyToken, validate(feedbackSchema), chatController.submitFeedback);
app.get('/api/sessions', verifyToken, checkSubscriptionExpiry, sessionController.getSessions);
app.post('/api/sessions', verifyToken, sessionController.createSession);
console.log('✅ [SERVER] Session routes registered');
app.post('/api/dreams/analyze', verifyToken, checkSubscriptionExpiry, checkDailyLimit, validate(dreamSchema), chatController.analyzeDream);
app.post('/api/dreams/refine', verifyToken, checkSubscriptionExpiry, checkDailyLimit, validate(dreamRefineSchema), chatController.refineDream);
console.log('✅ [SERVER] Dreams routes registered');

// ─── AI SUGGESTION ROUTE ───
app.post('/api/ai/suggest', verifyToken, checkHintLimit, async (req, res) => {
    console.log('💡 [AI SUGGEST] Request received');
    try {
        const { messages } = req.body;
        if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Invalid message format.' });
        const contextMessages = messages.slice(-3);
        const suggestion = await generateSuggestion(contextMessages);
        res.json({ suggestion, remainingHints: req.remainingHints });
    } catch (error) {
        console.error('AI Suggestion Error:', error.message);
        res.status(500).json({ error: 'Failed to generate suggestion.' });
    }
});
console.log('✅ [SERVER] AI suggestion route registered');

// ─── ADMIN ROUTES (SECURE TOTP) ───
app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        const admin = await User.findOne({ email: String(email).toLowerCase().trim(), isAdmin: true });
        const dummyHash = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
        const validPassword = admin ? await bcrypt.compare(password, admin.password) : await bcrypt.compare(password, dummyHash);
        if (!admin || !validPassword) {
            console.warn('[ADMIN AUTH FAILED] IP: ' + req.ip);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        if (!admin.adminTotpEnabled) {
            return res.status(403).json({ error: '2FA not configured. Please contact support or use setup endpoint.' });
        }
        const tempToken = jwt.sign({ id: admin._id }, process.env.JWT_SECRET, { expiresIn: '5m' });
        res.json({ success: true, tempToken, requires2FA: true });
    } catch (err) {
        console.error('[ADMIN AUTH ERROR]', err.message);
        res.status(500).json({ error: 'Authentication service unavailable' });
    }
});

// Step 2: Verify TOTP Code
app.post('/api/admin/verify-2fa', require('./authController').verifyAdminTotpLogin);

// Setup Endpoints (Protected)
app.get('/api/admin/setup-2fa', verifyAdminToken, require('./authController').generateAdminTotp);
app.post('/api/admin/enable-2fa', verifyAdminToken, require('./authController').enableAdminTotp);

// Honeypot: Block all other /admin* paths with 404
app.use(/^\/admin/i, (req, res) => {
    console.warn('[SECURITY] Suspicious scan from ' + req.ip);
    res.status(404).json({ error: 'Not Found' });
});

// ✅ GET ALL USERS (KEPT - needed for admin dashboard)
app.get('/api/admin/users', verifyAdminToken, async (req, res) => {
    try {
        const users = await User.find({}).select('email username isAdmin isSuspended createdAt _id');
        res.json(users);
    } catch (err) {
        console.error('[ADMIN] Failed to fetch users:', err.message);
        res.status(500).json({ error: 'Failed to retrieve user list' });
    }
});

// ✅ LEGACY ADMIN ROUTES (Kept for compatibility)
app.post('/api/admin/verify-layer-2', verifyAdminToken, adminController.adminVerifyLayer2);
app.post('/api/admin/verify-layer-3', verifyAdminToken, adminController.adminVerifyLayer3);
app.get('/api/admin/users/:id/details', verifyAdminToken, adminController.getUserDetails);
app.get('/api/admin/users/:id/chat-view', verifyAdminToken, adminController.getUserChatView);
app.post('/api/admin/users/:id/message', verifyAdminToken, validate(adminMessageSchema), adminController.sendUserMessage);
app.get('/api/admin/reports', verifyAdminToken, adminController.getAllReports);
console.log('✅ [SERVER] Admin routes registered');

// ─── REPORTS ───
app.post('/api/reports', verifyToken, validate(reportSchema), reportController.submitReport);
console.log('✅ [SERVER] Report routes registered');

// ─── HISTORY ROUTES ───
console.log('🔧 [SERVER] Registering history routes...');
app.get('/api/history/sessions', verifyToken, checkSubscriptionExpiry, sessionController.getSessions);
app.get('/api/history/messages/:sessionId', verifyToken, checkSubscriptionExpiry, chatController.getHistory);
app.get('/api/history/:sessionId', verifyToken, checkSubscriptionExpiry, chatController.getHistory);
app.put('/api/history/rename/:sessionId', verifyToken, sessionController.renameSession);
app.put('/api/history/pin/:sessionId', verifyToken, sessionController.pinSession);
app.delete('/api/history/delete/:sessionId', verifyToken, sessionController.deleteSession);
console.log('✅ [SERVER] History routes registered');

// ─── DEBUG ROUTES (ADMIN-ONLY) ───
app.get('/api/debug/verify-messages', verifyAdminToken, async (req, res) => {
    try {
        const ChatMessage = require('./ChatMessage');
        const Session = require('./Session');
        const userId = String(req.userId);
        const sessions = await Session.find({ userId }).sort({ updatedAt: -1 }).limit(5);
        let result = { userId, totalSessions: sessions.length, sessions: [] };
        for (const session of sessions) {
            const messages = await ChatMessage.find({ userId, sessionId: session.sessionId }).sort({ createdAt: 1 });
            result.sessions.push({
                sessionId: session.sessionId, name: session.name, messageCount: messages.length,
                messages: messages.map(m => ({ role: m.role, contentLength: m.content ? m.content.length : 0, hasContent: !!m.content }))
            });
        }
        res.json(result);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/debug/conversation/:leadId', verifyAdminToken, async (req, res) => {
    try {
        const ChatMessage = require('./ChatMessage');
        const lead = await Lead.findOne({ _id: req.params.leadId, userId: String(req.userId) });
        if (!lead) return res.json({ exists: false, message: 'Lead not found' });
        const chatMessages = await ChatMessage.find({ userId: String(req.userId), sessionId: String(lead._id) });
        res.json({
            lead: { id: lead._id, name: lead.name, status: lead.status, repliesCount: lead.replies?.length || 0 },
            chatMessageCount: chatMessages.length,
            totalMessages: (lead.replies?.length || 0) + chatMessages.length
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/debug/leads', verifyAdminToken, async (req, res) => {
    try {
        const leads = await Lead.find({ userId: String(req.userId) }).select('name status replies lastContactDate createdAt').sort({ lastContactDate: -1 }).limit(20);
        res.json({ count: leads.length, leads: leads.map(l => ({ id: l._id, name: l.name, status: l.status, repliesCount: l.replies?.length || 0, lastContactDate: l.lastContactDate, createdAt: l.createdAt })) });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── START SERVER ───
const PORT = process.env.PORT || 5001;
const server = app.listen(PORT, () => { 
    console.log('🚀 Server running on port ' + PORT); 
    console.log('✅ [SERVER] All routes registered successfully');
});
server.timeout = 300000;
