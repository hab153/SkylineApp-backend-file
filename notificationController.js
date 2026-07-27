const Notification = require('./Notification');
const Lead = require('./Lead');
const { isValidObjectId, sanitizeQuery } = require('./sanitize');

// GET /api/my-notifications - FIXED (Proper userId filtering)
const getMyNotifications = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        // ✅ FIX: Direct filter
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
        
        // ✅ FIX: Direct filter
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

// GET /api/notifications/count - FIXED (Proper userId filtering)
const getNotificationCount = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        
        // ✅ FIX: Direct filter
        const count = await Notification.countDocuments({ 
            userId: req.userId,
            isRead: false 
        });
        
        console.log(`📬 [getNotificationCount] Found ${count} unread notifications for user ${req.userId}`);
        res.json({ count });
    } catch (err) {
        console.error('Get notification count error:', err);
        res.status(500).json({ message: 'Server Error counting notifications' });
    }
};

module.exports = {
    getMyNotifications,
    getRepliesCount,
    getNotificationCount
};
