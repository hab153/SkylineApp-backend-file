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
    // ✅ REMOVED: resetPasswordEmailUsername - VULNERABLE ENDPOINT DELETED
    forgotPassword,
    resetPassword,
    verifyLayer2,
    verifyLayer3,
    setupAdminSecurity,
    checkAdminSecurityStatus
} = require('./authController');

// Import user-specific routes from userController
const {
    changeEmail,
    verifyAge,
    deleteUserAccount,
    deactivateUserAccount,
    restoreUserAccount,
    getDeletionStatus
} = require('./userController');

// ─── ✅ RATE LIMITERS FOR AUTH ENDPOINTS ───

// Strict limiter for password reset endpoints (5 attempts per hour)
const resetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // 5 attempts per hour
    keyGenerator: (req) => {
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
// ✅ REMOVED: /reset-password-email-username - VULNERABLE ENDPOINT DELETED
// ──────────────────────────────
router.post('/verify-email', verifyLimiter, verifyEmail);
router.post('/verify-username', verifyLimiter, verifyUsername);
router.post('/forgot-password', resetLimiter, forgotPassword);
router.post('/reset-password', resetLimiter, resetPassword);

// ──────────────────────────────
// PROTECTED ROUTES (require authentication)
// ──────────────────────────────
router.post('/logout', verifyToken, logout);
router.post('/revoke-tokens', verifyToken, revokeAllTokens);
router.put('/change-email', verifyToken, changeEmail);
router.put('/verify-age', verifyToken, verifyAge);

// GDPR Account Management
router.delete('/delete-account', verifyToken, deleteUserAccount);
router.post('/deactivate-account', verifyToken, deactivateUserAccount);
router.post('/restore-account', verifyToken, restoreUserAccount);
router.get('/deletion-status', verifyToken, getDeletionStatus);

// Admin Security Setup (Protected)
router.post('/admin/setup-security', verifyToken, setupAdminSecurity);
router.get('/admin/security-status', verifyToken, checkAdminSecurityStatus);

// Admin Layer Verification (Protected)
router.post('/admin/verify-layer-2', verifyToken, verifyLayer2);
router.post('/admin/verify-layer-3', verifyToken, verifyLayer3);

console.log('✅ [AUTH ROUTES] Routes registered successfully');

module.exports = router;
