const express = require('express');
const router = express.Router();
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
    setupAdminSecurity,      // ✅ NEW
    checkAdminSecurityStatus // ✅ NEW
} = require('./authController');

// ──────────────────────────────
// PUBLIC ROUTES
// ──────────────────────────────
router.post('/register', register);
router.post('/login', login);

// ──────────────────────────────
// PASSWORD RESET ROUTES
// ──────────────────────────────
router.post('/verify-email', verifyEmail);
router.post('/verify-username', verifyUsername);
router.post('/reset-password-email-username', resetPasswordEmailUsername);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

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
