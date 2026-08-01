const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { verifyToken } = require('./authMiddleware');
const {
    register,
    login,
    logout,
    revokeAllTokens,
    verifyEmail,
    verifyUsername,
    resetPasswordEmailUsername,
    forgotPassword,
    resetPassword,
    verifyAge,
    changeEmail,
    verifyLayer2,
    verifyLayer3,
    deleteAccount,
    setupAdminSecurity,
    checkAdminSecurityStatus
} = require('./authController');

// ─── ✅ RATE LIMITERS FOR AUTH ENDPOINTS ───

// Strict limiter for password reset endpoints (5 attempts per hour)
const resetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // 5 attempts per hour
    keyGenerator: (req) => {
        // Use email if present, otherwise IP
        return req.body.email || req.ip;
    },
    message: {
        success: false,
        message: 'Too many password reset attempts. Please try again in 1 hour.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false
});

// Medium limiter for verification endpoints (10 attempts per hour)
const verifyLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 attempts per hour
    keyGenerator: (req) => {
        return req.body.email || req.body.identifier || req.ip;
    },
    message: {
        success: false,
        message: 'Too many verification attempts. Please try again in 1 hour.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false
});

// Strict limiter for login attempts (5 per 15 minutes)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per 15 minutes
    keyGenerator: (req) => {
        return req.body.identifier || req.body.email || req.ip;
    },
    message: {
        success: false,
        message: 'Too many login attempts. Please try again in 15 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false
});

// Strict limiter for registration (3 per hour)
const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // 3 attempts per hour per IP
    keyGenerator: (req) => req.ip,
    message: {
        success: false,
        message: 'Too many registration attempts. Please try again in 1 hour.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false
});

// ──────────────────────────────
// PUBLIC ROUTES (with rate limiting)
// ──────────────────────────────
router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);

// ──────────────────────────────
// PASSWORD RESET ROUTES (with strict rate limiting)
// ──────────────────────────────
router.post('/verify-email', verifyLimiter, verifyEmail);
router.post('/verify-username', verifyLimiter, verifyUsername);
router.post('/reset-password-email-username', resetLimiter, resetPasswordEmailUsername);
router.post('/forgot-password', resetLimiter, forgotPassword);
router.post('/reset-password', resetLimiter, resetPassword);

// ──────────────────────────────
// PROTECTED ROUTES (require authentication)
// ──────────────────────────────
router.post('/logout', verifyToken, logout);
router.post('/revoke-tokens', verifyToken, revokeAllTokens);
router.put('/change-email', verifyToken, changeEmail);
router.put('/verify-age', verifyToken, verifyAge);
router.post('/verify-layer-2', verifyToken, verifyLayer2);
router.post('/verify-layer-3', verifyToken, verifyLayer3);
router.delete('/delete-account', verifyToken, deleteAccount);

// ──────────────────────────────
// ✅ ADMIN SECURITY SETUP ROUTES
// ──────────────────────────────
// Check if admin has completed security setup
router.get('/admin/security-status', verifyToken, checkAdminSecurityStatus);

// Setup admin security questions (only for admins)
router.post('/admin/setup-security', verifyToken, setupAdminSecurity);

module.exports = router;
