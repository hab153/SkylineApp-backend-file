const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const {
    register,
    login,
    logout,
    revokeAllTokens,
    verifyEmail,                  // ✅ NEW
    verifyUsername,               // ✅ NEW
    resetPasswordEmailUsername,   // ✅ NEW
    forgotPassword,
    resetPassword,
    verifyAge,
    changeEmail,
    verifyLayer2,
    verifyLayer3,
    deleteAccount
} = require('./authController');

// ──────────────────────────────
// PUBLIC ROUTES
// ──────────────────────────────
router.post('/register', register);
router.post('/login', login);

// ──────────────────────────────
// PASSWORD RESET ROUTES
// ──────────────────────────────
// ✅ NEW: Email + Username verification (no email required)
router.post('/verify-email', verifyEmail);
router.post('/verify-username', verifyUsername);
router.post('/reset-password-email-username', resetPasswordEmailUsername);

// Kept for backward compatibility (email-based reset)
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

module.exports = router;
