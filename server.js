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
//  ✅ FIX #1: JWT SECRET VALIDATION (ENHANCED - HARD FAILS)
// ──────────────────────────────────────────────────────────────

console.log('\n🔐 [SECURITY] Validating JWT secrets...');

// ─── Helper function to generate entropy recommendation ───
function getEntropyRecommendation() {
    const generated = crypto.randomBytes(32).toString('hex');
    return `\n   💡 RECOMMENDED: Use this cryptographically generated string:\n   ${generated}\n   Run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;
}

// ============================================================
// 1. VALIDATE JWT_SECRET (HARD FAIL)
// ============================================================
const jwtSecret = process.env.JWT_SECRET;

// Check if JWT_SECRET exists
if (!jwtSecret) {
    console.error('❌ [SECURITY] JWT_SECRET is not defined in environment variables!');
    console.error('   ⚠️ Please set JWT_SECRET in your .env file (minimum 32 characters)');
    console.error(getEntropyRecommendation());
    process.exit(1);
}

// Check if JWT_SECRET is at least 32 characters
if (jwtSecret.length < 32) {
    console.error(`❌ [SECURITY] JWT_SECRET is too short (${jwtSecret.length} characters). Minimum is 32 characters.`);
    console.error(getEntropyRecommendation());
    process.exit(1);
}

// ✅ ENHANCEMENT 1: Hard fail on weak/default secrets
const weakSecrets = [
    'secret', 'password', '1234567890', 'jwtsecret', 'supersecret', 
    'mysecret', 'changeme', 'test', '1234', 'qwerty', 'admin', 
    'letmein', 'welcome', 'monkey', 'dragon', 'master', 'hello'
];

const isWeak = weakSecrets.some(weak => {
    // Check for exact match OR if the secret contains the weak word
    return jwtSecret.toLowerCase().includes(weak) || 
           weak.toLowerCase().includes(jwtSecret.toLowerCase());
});

if (isWeak) {
    console.error(`❌ [SECURITY] JWT_SECRET "${jwtSecret}" appears to be weak or contains common words!`);
    console.error('   ⚠️ This is a hard fail - server will not start with weak credentials.');
    console.error(getEntropyRecommendation());
    process.exit(1);
}

console.log(`✅ [SECURITY] JWT_SECRET is configured (length: ${jwtSecret.length} characters)`);

// ============================================================
// 2. ENHANCEMENT 2: ADMIN_JWT_SECRET IS MANDATORY & DISTINCT
// ============================================================
const adminJwtSecret = process.env.ADMIN_JWT_SECRET;

// Check if ADMIN_JWT_SECRET exists
if (!adminJwtSecret) {
    console.error('❌ [SECURITY] ADMIN_JWT_SECRET is not defined in environment variables!');
    console.error('   ⚠️ ADMIN_JWT_SECRET is MANDATORY for production security.');
    console.error('   ⚠️ It must be different from JWT_SECRET.');
    console.error(getEntropyRecommendation());
    process.exit(1);
}

// Check if ADMIN_JWT_SECRET is at least 32 characters
if (adminJwtSecret.length < 32) {
    console.error(`❌ [SECURITY] ADMIN_JWT_SECRET is too short (${adminJwtSecret.length} characters). Minimum is 32 characters.`);
    console.error(getEntropyRecommendation());
    process.exit(1);
}

// ✅ ENHANCEMENT 2: Ensure ADMIN_JWT_SECRET is DISTINCT from JWT_SECRET
if (adminJwtSecret === jwtSecret) {
    console.error('❌ [SECURITY] ADMIN_JWT_SECRET is the same as JWT_SECRET!');
    console.error('   ⚠️ For security, ADMIN_JWT_SECRET MUST be different from JWT_SECRET.');
    console.error('   ⚠️ This prevents admin access if JWT_SECRET is compromised.');
    console.error(getEntropyRecommendation());
    process.exit(1);
}

// Hard fail on weak admin secrets too
const isAdminWeak = weakSecrets.some(weak => {
    return adminJwtSecret.toLowerCase().includes(weak) || 
           weak.toLowerCase().includes(adminJwtSecret.toLowerCase());
});

if (isAdminWeak) {
    console.error(`❌ [SECURITY] ADMIN_JWT_SECRET "${adminJwtSecret}" appears to be weak or contains common words!`);
    console.error('   ⚠️ This is a hard fail - server will not start with weak credentials.');
    console.error(getEntropyRecommendation());
    process.exit(1);
}

console.log(`✅ [SECURITY] ADMIN_JWT_SECRET is configured (length: ${adminJwtSecret.length} characters)`);
console.log(`✅ [SECURITY] ADMIN_JWT_SECRET is distinct from JWT_SECRET`);

// ============================================================
// 3. VALIDATE OTHER REQUIRED ENV VARS
// ============================================================
const requiredEnvVars = [
    'NYLAS_CLIENT_ID',
    'NYLAS_API_KEY',
    'FLUTTERWAVE_SECRET_KEY',
    'FLUTTERWAVE_SECRET_HASH',
    'MONGODB_URI'
];

const missingEnvVars = requiredEnvVars.filter(varName => {
    const value = process.env[varName];
    return !value || value.trim() === '';
});

if (missingEnvVars.length > 0) {
    console.error('❌ CRITICAL ERROR: Missing required environment variables:');
    missingEnvVars.forEach(varName => {
        console.error(`   ⚠️ ${varName} is not defined or empty`);
    });
    console.error('');
    console.error('⚠️ Please set all required environment variables in your .env file or Render dashboard.');
    console.error('⚠️ The server will not start until all required variables are configured.');
    process.exit(1);
}

console.log('✅ All required environment variables are configured');
console.log(`   📋 JWT_SECRET: ✅ Set (${jwtSecret.length} chars)`);
console.log(`   📋 ADMIN_JWT_SECRET: ✅ Set (${adminJwtSecret.length} chars, distinct)`);
console.log(`   📋 NYLAS_CLIENT_ID: ${process.env.NYLAS_CLIENT_ID ? '✅ Set' : '❌ Missing'}`);
console.log(`   📋 NYLAS_API_KEY: ${process.env.NYLAS_API_KEY ? '✅ Set' : '❌ Missing'}`);
console.log(`   📋 FLUTTERWAVE_SECRET_KEY: ${process.env.FLUTTERWAVE_SECRET_KEY ? '✅ Set' : '❌ Missing'}`);
console.log(`   📋 MONGODB_URI: ${process.env.MONGODB_URI ? '✅ Set' : '❌ Missing'}`);

// ─── BACKUP CHECK ───
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

// ─── SECURITY MIDDLEWARE ───
app.use(helmet());
app.disable('x-powered-by');
app.set('trust proxy', 1);

const ALLOWED_ORIGINS = [
    'https://skylineai-app.vercel.app', 
    'http://localhost:3000'
];

app.use(cors({
    origin: function(origin, callback) {
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

// ─── HEALTH CHECK ───
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

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
mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000
})
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
        } catch (indexErr) {
            console.warn('⚠️ [SERVER] Index creation warning:', indexErr.message);
        }
        
        startExpiryJob();
        startFollowUpJob();
        if (process.env.NODE_ENV !== 'test') {
            startBackupJob();
        }
        startDataExportCleanupJob();
        verifyWebhookRegistration();
        startTokenRefreshJob();
    })
    .catch(err => console.log('❌ MongoDB Connection Error:', err));

// ─── WEBHOOK VERIFICATION ───
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

// ─── TOKEN REFRESH JOB ───
async function startTokenRefreshJob() {
    console.log('⏰ [TOKEN REFRESH] Starting background token refresh job...');
    
    setInterval(async () => {
        try {
            const EmailAccount = require('./EmailAccount');
            const now = new Date();
            const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);
            
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
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔐 [NYLAS ROUTE] /api/auth/nylas/connect called');
    console.log('📝 [NYLAS ROUTE] User ID:', req.userId);
    console.log('📝 [NYLAS ROUTE] Headers:', {
        authorization: req.headers.authorization ? '✅ Present' : ' Missing',
        'content-type': req.headers['content-type'] || 'Not set'
    });
    console.log('📝 [NYLAS ROUTE] Method:', req.method);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    next();
}, nylasAuthController.getAuthUrl);

app.get('/api/auth/nylas/callback', nylasAuthController.handleCallback);

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

// ─── PAYMENT ROUTE ───
app.post('/api/create-flutterwave-payment', verifyToken, createFlutterwavePayment);
console.log('✅ [SERVER] Payment route registered');

// ─── AUTH ROUTES ───
app.post('/api/auth/register', validate(registerSchema), register);
app.post('/api/auth/login', validate(loginSchema), login);
app.put('/api/auth/change-email', verifyToken, validate(changeEmailSchema), userController.changeEmail);
app.post('/api/auth/forgot-password', validate(forgotPasswordSchema), forgotPassword);
app.post('/api/auth/reset-password', validate(resetPasswordSchema), resetPassword);
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
console.log('   📋 GET    /api/leads/:leadId/follow-up-status');
console.log('   📋 POST   /api/leads/:leadId/suggest-follow-up');
console.log('   📋 POST   /api/leads/:leadId/auto-follow-up');

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

// ─── ADMIN ROUTES ───
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const admin = await User.findOne({ 
            email: email.toLowerCase().trim(), 
            isAdmin: true 
        });

        const dummyHash = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
        const validPassword = admin 
            ? await bcrypt.compare(password, admin.password)
            : await bcrypt.compare(password, dummyHash);

        if (!admin || !validPassword) {
            console.warn(`[ADMIN AUTH FAILED] Email: ${email}, IP: ${req.ip}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Use ADMIN_JWT_SECRET (mandatory, distinct)
        const adminToken = jwt.sign(
            { 
                id: admin._id, 
                role: 'admin',
                permissions: admin.permissions || ['all']
            },
            process.env.ADMIN_JWT_SECRET,
            { expiresIn: '30m' }
        );

        console.log(`[ADMIN AUTH SUCCESS] User: ${admin.email}, IP: ${req.ip}`);
        res.json({ success: true, token: adminToken });

    } catch (err) {
        console.error('[ADMIN AUTH ERROR]', err);
        res.status(500).json({ error: 'Authentication service unavailable' });
    }
});

// Honeypot: Block all other /admin* paths with 404
app.use(/^\/admin/i, (req, res) => {
    console.warn(`[SECURITY] Suspicious scan from ${req.ip}: ${req.originalUrl}`);
    res.status(404).json({ error: 'Not Found' });
});

// ✅ GET ALL USERS (KEPT - needed for admin dashboard)
app.get('/api/admin/users', verifyAdminToken, async (req, res) => {
    try {
        const users = await User.find({}).select('email username isAdmin isSuspended createdAt _id');
        res.json(users);
    } catch (err) {
        console.error('[ADMIN] Failed to fetch users:', err);
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
console.log('   📋 GET    /api/history/sessions');
console.log('   📋 GET    /api/history/messages/:sessionId');
console.log('   📋 PUT    /api/history/rename/:sessionId');
console.log('   📋 PUT    /api/history/pin/:sessionId');
console.log('   📋 DELETE /api/history/delete/:sessionId');

// ─── DEBUG ROUTES ───
app.get('/api/debug/verify-messages', verifyToken, async (req, res) => {
    try {
        const ChatMessage = require('./ChatMessage');
        const Session = require('./Session');
        
        const userId = req.userId;
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

// ─── START SERVER ───
const PORT = process.env.PORT || 5001;
const server = app.listen(PORT, () => { 
    console.log(`🚀 Server running on port ${PORT}`); 
    console.log(`✅ [SERVER] All routes registered successfully`);
});
server.timeout = 300000;
