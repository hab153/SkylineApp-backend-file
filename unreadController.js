// ============================================================
// unreadController.js
// SINGLE SOURCE OF TRUTH - Unread Notification System
// Handles all database operations for unread counts
// Skyline AA-1
// ============================================================

const Lead = require('./Lead');
const mongoose = require('mongoose');
const { isValidObjectId } = require('./sanitize');

// ─── GET UNREAD STATUS FOR A USER ───
// Returns: { success: true, hasUnread: boolean, count: number }
const getUnreadStatus = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized',
                hasUnread: false,
                count: 0
            });
        }

        const userId = new mongoose.Types.ObjectId(req.userId);

        // ✅ Aggregate all unread counts from user's leads
        const result = await Lead.aggregate([
            { $match: { userId: userId } },
            { $group: { _id: null, totalUnread: { $sum: '$unreadCount' } } }
        ]);

        const count = result.length > 0 ? result[0].totalUnread : 0;

        return res.json({
            success: true,
            hasUnread: count > 0,
            count: count
        });

    } catch (error) {
        console.error('❌ [getUnreadStatus] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Server Error',
            hasUnread: false,
            count: 0
        });
    }
};

// ─── INCREMENT UNREAD COUNT FOR A SPECIFIC LEAD ───
// Used when a new message arrives
const incrementUnread = async (leadId, userId) => {
    try {
        if (!leadId || !userId) return null;
        if (!isValidObjectId(leadId) || !isValidObjectId(userId)) return null;

        const result = await Lead.findOneAndUpdate(
            { _id: leadId, userId: userId },
            { $inc: { unreadCount: 1 } },
            { new: true }
        );

        return result;
    } catch (error) {
        console.error('❌ [incrementUnread] Error:', error.message);
        return null;
    }
};

// ─── RESET UNREAD COUNT FOR A SPECIFIC LEAD ───
// Used when user opens a chat
const resetUnread = async (leadId, userId) => {
    try {
        if (!leadId || !userId) return null;
        if (!isValidObjectId(leadId) || !isValidObjectId(userId)) return null;

        const result = await Lead.findOneAndUpdate(
            { _id: leadId, userId: userId },
            { $set: { unreadCount: 0 } },
            { new: true }
        );

        return result;
    } catch (error) {
        console.error('❌ [resetUnread] Error:', error.message);
        return null;
    }
};

// ─── CLEAR ALL UNREAD FOR A USER ───
// Used when user marks all as read
const clearAllUnread = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        const userId = new mongoose.Types.ObjectId(req.userId);

        const result = await Lead.updateMany(
            { userId: userId, unreadCount: { $gt: 0 } },
            { $set: { unreadCount: 0 } }
        );

        return res.json({
            success: true,
            message: 'All unread cleared',
            clearedCount: result.modifiedCount
        });

    } catch (error) {
        console.error('❌ [clearAllUnread] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Server Error'
        });
    }
};

// ─── GET UNREAD COUNT FOR A SINGLE LEAD ───
// Used when checking a specific conversation
const getLeadUnreadCount = async (leadId, userId) => {
    try {
        if (!leadId || !userId) return 0;
        if (!isValidObjectId(leadId) || !isValidObjectId(userId)) return 0;

        const lead = await Lead.findOne(
            { _id: leadId, userId: userId },
            { unreadCount: 1 }
        );

        return lead ? lead.unreadCount || 0 : 0;
    } catch (error) {
        console.error('❌ [getLeadUnreadCount] Error:', error.message);
        return 0;
    }
};

// ─── GET ALL LEADS WITH UNREAD ───
// Used for notification list
const getLeadsWithUnread = async (req, res) => {
    try {
        if (!req.userId || !isValidObjectId(req.userId)) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        const userId = new mongoose.Types.ObjectId(req.userId);

        const leads = await Lead.find(
            { userId: userId, unreadCount: { $gt: 0 } },
            { name: 1, email: 1, unreadCount: 1, lastContactDate: 1 }
        )
        .sort({ lastContactDate: -1 })
        .lean();

        return res.json({
            success: true,
            count: leads.length,
            leads: leads
        });

    } catch (error) {
        console.error('❌ [getLeadsWithUnread] Error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Server Error'
        });
    }
};

module.exports = {
    getUnreadStatus,
    incrementUnread,
    resetUnread,
    clearAllUnread,
    getLeadUnreadCount,
    getLeadsWithUnread
};
