// ============================================================
// unreadController.js
// Single source of truth for unread messages
// ============================================================

const Lead = require('./Lead');
const { isValidObjectId } = require('./sanitize');

// ─── ✅ GET UNREAD STATUS ───
// Returns: { hasUnread: boolean, count: number }
const getUnreadStatus = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ 
                success: false, 
                message: 'Unauthorized' 
            });
        }

        const userId = req.userId;

        // ✅ Get total unread count from ALL leads
        const result = await Lead.aggregate([
            { $match: { userId: mongoose.Types.ObjectId(userId) } },
            { $group: { _id: null, total: { $sum: '$unreadCount' } } }
        ]);

        const count = result.length > 0 ? result[0].total : 0;

        res.json({
            success: true,
            hasUnread: count > 0,
            count: count
        });

    } catch (error) {
        console.error('❌ [getUnreadStatus] Error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error getting unread status',
            hasUnread: false,
            count: 0
        });
    }
};

// ─── ✅ CLEAR ALL UNREAD ───
// Resets unreadCount to 0 for ALL leads
const clearUnread = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ 
                success: false, 
                message: 'Unauthorized' 
            });
        }

        const userId = req.userId;

        // ✅ Reset unreadCount for ALL leads
        const result = await Lead.updateMany(
            { userId: userId, unreadCount: { $gt: 0 } },
            { $set: { unreadCount: 0 } }
        );

        console.log(`📬 [clearUnread] Cleared unread for ${result.modifiedCount} leads for user ${userId}`);

        res.json({
            success: true,
            message: 'All unread messages cleared',
            clearedCount: result.modifiedCount
        });

    } catch (error) {
        console.error('❌ [clearUnread] Error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error clearing unread' 
        });
    }
};

// ─── ✅ GET LEADS WITH UNREAD ───
// Returns list of leads with unread messages
const getLeadsWithUnread = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ 
                success: false, 
                message: 'Unauthorized' 
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

        res.json({
            success: true,
            count: leads.length,
            leads: leads
        });

    } catch (error) {
        console.error('❌ [getLeadsWithUnread] Error:', error.message);
        res.status(500).json({ 
            success: false, 
            message: 'Server Error' 
        });
    }
};

// ─── ✅ GET TOTAL UNREAD COUNT (for badge) ───
const getUnreadCount = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({ 
                success: false, 
                message: 'Unauthorized' 
            });
        }

        const userId = req.userId;

        const result = await Lead.aggregate([
            { $match: { userId: mongoose.Types.ObjectId(userId) } },
            { $group: { _id: null, total: { $sum: '$unreadCount' } } }
        ]);

        const count = result.length > 0 ? result[0].total : 0;

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

module.exports = {
    getUnreadStatus,
    clearUnread,
    getLeadsWithUnread,
    getUnreadCount
};
