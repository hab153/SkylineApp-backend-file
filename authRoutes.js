const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const {
    register,
    login,
    logout,
    revokeAllTokens,
    forgotPassword,    // ✅ NEW
    resetPassword,     // ✅ NEW
    verifyAge,
    changeEmail,
    verifyLayer2,
    verifyLayer3,
    deleteAccount
} = require('./authController');

// Public routes
router.post('/register', register);
router.post('/login', login);

// ✅ NEW: Password reset routes
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// Protected routes (require authentication)
router.post('/logout', verifyToken, logout);
router.post('/revoke-tokens', verifyToken, revokeAllTokens);
router.put('/change-email', verifyToken, changeEmail);
router.put('/verify-age', verifyToken, verifyAge);
router.post('/verify-layer-2', verifyToken, verifyLayer2);
router.post('/verify-layer-3', verifyToken, verifyLayer3);
router.delete('/delete-account', verifyToken, deleteAccount);

module.exports = router;
