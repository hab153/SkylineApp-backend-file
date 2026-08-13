// ============================================================
// unreadRoutes.js
// UNREAD ROUTES - Single Source of Truth
// Routes for frontend to interact with unread system
// Skyline AA-1
// ============================================================

const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const unreadController = require('./unreadController');

// ─── GET UNREAD STATUS ───
// Returns: { success: true, hasUnread: boolean, count: number }
// Used by frontend to check if there are any unread messages
router.get('/status', verifyToken, unreadController.getUnreadStatus);

// ─── CLEAR ALL UNREAD ───
// Resets all unread counts to 0 for the user
// Used when user marks all as read
router.post('/clear', verifyToken, unreadController.clearAllUnread);

// ─── GET LEADS WITH UNREAD ───
// Returns list of leads that have unread messages
// Used for notification list
router.get('/leads', verifyToken, unreadController.getLeadsWithUnread);

// ─── GET UNREAD COUNT FOR SPECIFIC LEAD ───
// Returns unread count for a single lead
// Used when checking a specific conversation
router.get('/lead/:leadId', verifyToken, async (req, res) => {
    try {
        const { leadId } = req.params;
        const userId = req.userId;
        
        const count = await unreadController.getLeadUnreadCount(leadId, userId);
        
        res.json({
            success: true,
            count: count
        });
    } catch (error) {
        console.error('❌ [unreadRoutes] Error getting lead unread:', error.message);
        res.status(500).json({
            success: false,
            message: 'Server Error',
            count: 0
        });
    }
});

// ─── RESET UNREAD FOR SPECIFIC LEAD ───
// Sets unread count to 0 for a specific lead
// Used when user opens a chat
router.post('/reset/:leadId', verifyToken, async (req, res) => {
    try {
        const { leadId } = req.params;
        const userId = req.userId;
        
        const result = await unreadController.resetUnread(leadId, userId);
        
        if (result) {
            res.json({
                success: true,
                message: 'Unread reset successfully'
            });
        } else {
            res.status(404).json({
                success: false,
                message: 'Lead not found'
            });
        }
    } catch (error) {
        console.error('❌ [unreadRoutes] Error resetting unread:', error.message);
        res.status(500).json({
            success: false,
            message: 'Server Error'
        });
    }
});

console.log('✅ [UNREAD ROUTES] Registered:');
console.log('   📋 GET  /api/unread/status      - Get unread status');
console.log('   📋 POST /api/unread/clear       - Clear all unread');
console.log('   📋 GET  /api/unread/leads       - Get leads with unread');
console.log('   📋 GET  /api/unread/lead/:id    - Get unread for lead');
console.log('   📋 POST /api/unread/reset/:id   - Reset unread for lead');

module.exports = router;
