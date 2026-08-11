// ============================================================
// unreadController.js
// SINGLE SOURCE OF TRUTH for unread messages
// ============================================================

const Lead = require('./Lead');
const Notification = require('./Notification');

// ─── In-memory cache ───
var unreadCache = new Map();
var CACHE_TTL = 10000; // 10 seconds

// ─── Get unread count ───
async function getUnreadCount(userId) {
    try {
        var cacheKey = String(userId);
        var cached = unreadCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            return cached.count;
        }

        // Method 1: Count from Leads (unreadCount field)
        var leadCount = await Lead.countDocuments({
            userId: userId,
            unreadCount: { $gt: 0 }
        });

        // Method 2: Count from Notifications
        var notifCount = await Notification.countDocuments({
            userId: userId,
            isRead: false
        });

        // Method 3: Count from replies array (fallback)
        var replyCount = 0;
        try {
            var leadsWithReplies = await Lead.find({
                userId: userId,
                'replies.read': false
            }).select('replies').lean();

            for (var i = 0; i < leadsWithReplies.length; i++) {
                var replies = leadsWithReplies[i].replies || [];
                for (var j = 0; j < replies.length; j++) {
                    if (replies[j].read === false) {
                        replyCount++;
                    }
                }
            }
        } catch (err) {
            console.warn('[UNREAD] Reply count error:', err.message);
        }

        var totalUnread = leadCount + notifCount + replyCount;

        unreadCache.set(cacheKey, {
            count: totalUnread,
            timestamp: Date.now()
        });

        return totalUnread;

    } catch (error) {
        console.error('❌ [UNREAD] Error:', error.message);
        return 0;
    }
}

// ─── Clear cache ───
function clearUnreadCache(userId) {
    var cacheKey = String(userId);
    unreadCache.delete(cacheKey);
}

// ─── GET /api/unread/status ───
async function getUnreadStatus(req, res) {
    try {
        var userId = req.userId;
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized' 
            });
        }

        var count = await getUnreadCount(userId);
        
        res.json({
            success: true,
            hasUnread: count > 0,
            count: count,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ [UNREAD STATUS] Error:', error.message);
        res.status(500).json({
            success: false,
            hasUnread: false,
            error: 'Failed to get unread status'
        });
    }
}

// ─── POST /api/unread/clear ───
async function clearUnread(req, res) {
    try {
        var userId = req.userId;
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                error: 'Unauthorized' 
            });
        }

        // Clear all unread counts
        await Lead.updateMany(
            { userId: userId },
            { $set: { unreadCount: 0 } }
        );

        // Mark all notifications as read
        await Notification.updateMany(
            { userId: userId, isRead: false },
            { $set: { isRead: true } }
        );

        // Mark all replies as read
        await Lead.updateMany(
            { userId: userId, 'replies.read': false },
            { $set: { 'replies.$[].read': true } }
        );

        // Clear cache
        clearUnreadCache(userId);

        res.json({
            success: true,
            message: 'All unread messages cleared',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ [UNREAD CLEAR] Error:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to clear unread messages'
        });
    }
}

module.exports = {
    getUnreadCount,
    getUnreadStatus,
    clearUnread,
    clearUnreadCache
};
