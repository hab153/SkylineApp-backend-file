const Notification = require('./Notification');
const Lead = require('./Lead');
const mongoose = require('mongoose');
const { isValidObjectId, sanitizeQuery } = require('./sanitize');

// ─── GET UNREAD COUNT ───
// Returns: { success: true, count: number }
// This is the SINGLE SOURCE OF TRUTH for unread count
const getUnreadCount = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid user ID'
            });
        }

        const userId = req.userId;
        
        // ✅ Count unread notifications from Notification collection
        const count = await Notification.countDocuments({
            userId: userId,
            isRead: false
        });

        console.log(`📬 [getUnreadCount] ${count} unread notifications for user ${userId}`);

        res.json({
            success: true,
            count: count
        });

    } catch (error) {
        console.error('❌ [getUnreadCount] Error:', error.message);
        res.status(500).json({
            success: false,
            message: 'Server Error',
            count: 0
        });
    }
};

// GET /api/my-notifications
const getMyNotifications = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        const notifications = await Notification.find({ userId: req.userId })
            .sort({ createdAt: -1 });
            
        console.log(`📬 [getMyNotifications] Found ${notifications.length} notifications for user ${req.userId}`);
        res.json(notifications);
    } catch (err) {
        console.error('Get notifications error:', err);
        res.status(500).json({ error: err.message });
    }
};

// GET /api/notifications/replies
const getRepliesCount = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        const repliedLeads = await Lead.find({ 
            userId: req.userId,
            status: 'Replied' 
        }).sort({ lastContactDate: -1 });
        
        console.log(`📬 [getRepliesCount] Found ${repliedLeads.length} replied leads for user ${req.userId}`);
        res.json({ count: repliedLeads.length, leads: repliedLeads });
    } catch (err) {
        console.error('Get replies count error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// ─── MARK ALL AS READ ───
const markNotificationsRead = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid user ID'
            });
        }

        const userId = req.userId;
        
        // ✅ Mark all notifications as read
        const result = await Notification.updateMany(
            { userId: userId, isRead: false },
            { $set: { isRead: true } }
        );

        console.log(`📬 [markNotificationsRead] Marked ${result.modifiedCount} notifications as read for user ${userId}`);

        res.json({
            success: true,
            message: 'All notifications marked as read',
            clearedCount: result.modifiedCount
        });

    } catch (err) {
        console.error('❌ [markNotificationsRead] Error:', err.message);
        res.status(500).json({
            success: false,
            message: 'Server Error marking notifications as read'
        });
    }
};

// ─── GET LEADS WITH UNREAD ───
const getLeadsWithUnread = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid user ID'
            });
        }

        const userId = req.userId;
        
        const leads = await Lead.find({ 
            userId: userId,
            unreadCount: { $gt: 0 }
        })
        .select('name email unreadCount lastContactDate')
        .sort({ lastContactDate: -1 })
        .lean();

        console.log(`📬 [getLeadsWithUnread] Found ${leads.length} leads with unread messages`);

        res.json({
            success: true,
            leads: leads
        });

    } catch (err) {
        console.error('❌ [getLeadsWithUnread] Error:', err.message);
        res.status(500).json({
            success: false,
            message: 'Server Error getting leads with unread'
        });
    }
};

module.exports = {
    getUnreadCount,
    getMyNotifications,
    getRepliesCount,
    markNotificationsRead,
    getLeadsWithUnread
};
