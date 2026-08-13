const Notification = require('./Notification');
const Lead = require('./Lead');
const mongoose = require('mongoose'); // ✅ FIXED - Added mongoose import
const { isValidObjectId, sanitizeQuery } = require('./sanitize');
const { getTotalUnreadCount } = require('./leadController');

// GET /api/my-notifications - FIXED (Proper userId filtering)
const getMyNotifications = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        // ✅ Direct filter
        const notifications = await Notification.find({ userId: req.userId })
            .sort({ createdAt: -1 });
            
        console.log(`📬 [getMyNotifications] Found ${notifications.length} notifications for user ${req.userId}`);
        res.json(notifications);
    } catch (err) {
        console.error('Get notifications error:', err);
        res.status(500).json({ error: err.message });
    }
};

// GET /api/notifications/replies - FIXED (Proper userId filtering)
const getRepliesCount = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        // ✅ Direct filter
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

// ============================================================
// ✅ GET /api/notifications/count - UPDATED
// Returns total unread messages from ALL leads (WhatsApp-style)
// ============================================================
const getNotificationCount = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid user ID' 
            });
        }

        const userId = req.userId;
        
        // ✅ FIXED: mongoose is now defined
        const totalUnread = await Lead.aggregate([
            { $match: { userId: mongoose.Types.ObjectId(userId) } },
            { $group: { _id: null, total: { $sum: '$unreadCount' } } }
        ]);

        const count = totalUnread.length > 0 ? totalUnread[0].total : 0;

        console.log(`📬 [getNotificationCount] Total unread messages: ${count} for user ${userId}`);
        
        res.json({
            success: true,
            count: count
        });

    } catch (err) {
        console.error('❌ [getNotificationCount] Error:', err.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error counting notifications',
            count: 0 
        });
    }
};

// ─── ✅ NEW: Mark notifications as read ───
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
        await Notification.updateMany(
            { userId: userId, isRead: false },
            { $set: { isRead: true } }
        );

        // ✅ Also reset unreadCount for ALL leads
        await Lead.updateMany(
            { userId: userId, unreadCount: { $gt: 0 } },
            { $set: { unreadCount: 0 } }
        );

        console.log(`📬 [markNotificationsRead] Marked all as read for user ${userId}`);

        res.json({
            success: true,
            message: 'All notifications marked as read'
        });

    } catch (err) {
        console.error('❌ [markNotificationsRead] Error:', err.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error marking notifications as read' 
        });
    }
};

// ─── ✅ NEW: Get unread count from leads only ───
const getUnreadLeadCount = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid user ID' 
            });
        }

        const userId = req.userId;
        
        // ✅ Get leads with unread messages
        const leadsWithUnread = await Lead.find({ 
            userId: userId,
            unreadCount: { $gt: 0 }
        })
        .select('name unreadCount')
        .lean();

        const totalUnread = leadsWithUnread.reduce((sum, lead) => sum + lead.unreadCount, 0);

        console.log(`📬 [getUnreadLeadCount] Found ${leadsWithUnread.length} leads with unread messages (${totalUnread} total)`);

        res.json({
            success: true,
            count: totalUnread,
            leads: leadsWithUnread
        });

    } catch (err) {
        console.error('❌ [getUnreadLeadCount] Error:', err.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error getting unread count' 
        });
    }
};

// ─── ✅ NEW: Get leads with unread messages ───
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
    getMyNotifications,
    getRepliesCount,
    getNotificationCount,
    markNotificationsRead,
    getUnreadLeadCount,
    getLeadsWithUnread
};
