// ============================================================
// notificationRoutes.js
// NOTIFICATION ROUTES - Single Source of Truth
// Skyline AA-1
// ============================================================

const express = require('express');
const router = express.Router();
const { verifyToken } = require('./authMiddleware');
const notificationController = require('./notificationController');

// ─── GET UNREAD COUNT ───
// Returns: { success: true, count: number }
// Used by frontend to check if there are any unread notifications
router.get('/unread-count', verifyToken, notificationController.getNotificationCount);

// ─── GET ALL NOTIFICATIONS ───
// Returns: List of notifications for the user
router.get('/', verifyToken, notificationController.getMyNotifications);

// ─── MARK ONE NOTIFICATION AS READ ───
router.patch('/:id/read', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.userId;
        const Notification = require('./Notification');
        const { isValidObjectId } = require('./sanitize');

        if (!isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid notification ID'
            });
        }

        const notification = await Notification.findOne({ _id: id, userId: userId });

        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'Notification not found'
            });
        }

        notification.isRead = true;
        await notification.save();

        // ✅ Get updated unread count
        const unreadCount = await Notification.countDocuments({
            userId: userId,
            isRead: false
        });

        res.json({
            success: true,
            message: 'Notification marked as read',
            unreadCount: unreadCount
        });

    } catch (error) {
        console.error('❌ [markNotificationRead] Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Server Error'
        });
    }
});

// ─── MARK ALL AS READ ───
router.patch('/read-all', verifyToken, notificationController.markNotificationsRead);

// ─── GET REPLIES COUNT ───
router.get('/replies', verifyToken, notificationController.getRepliesCount);

// ─── GET LEADS WITH UNREAD ───
router.get('/unread-leads', verifyToken, notificationController.getLeadsWithUnread);

console.log('✅ [NOTIFICATION ROUTES] Registered:');
console.log('   📋 GET    /api/notifications/unread-count');
console.log('   📋 GET    /api/notifications');
console.log('   📋 PATCH  /api/notifications/:id/read');
console.log('   📋 PATCH  /api/notifications/read-all');
console.log('   📋 GET    /api/notifications/replies');
console.log('   📋 GET    /api/notifications/unread-leads');

module.exports = router;
