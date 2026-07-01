const Notification = require('./Notification');
const Lead = require('./Lead');
const { isValidObjectId, sanitizeQuery } = require('./sanitize');

// GET /api/my-notifications
const getMyNotifications = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const query = sanitizeQuery({ userId: req.userId });
        const notifications = await Notification.find(query).sort({ createdAt: -1 });
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
        const query = sanitizeQuery({ userId: req.userId, status: 'Replied' });
        const repliedLeads = await Lead.find(query).sort({ lastContactDate: -1 });
        res.json({ count: repliedLeads.length, leads: repliedLeads });
    } catch (err) {
        console.error('Get replies count error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
};

// GET /api/notifications/count
const getNotificationCount = async (req, res) => {
    try {
        if (!isValidObjectId(req.userId)) {
            return res.status(400).json({ message: 'Invalid user ID' });
        }
        const query = sanitizeQuery({ userId: req.userId, isRead: false });
        const count = await Notification.countDocuments(query);
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
