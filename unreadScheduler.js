// ============================================================
// unreadScheduler.js
// RUNS EVERY 4 SECONDS - Checks unread counts and pushes to frontend
// Single source of truth - Always reads from database
// Skyline AA-1
// ============================================================

const Lead = require('./Lead');
const sseManager = require('./sseManager');

// ─── Store previous counts to detect changes ───
const previousCounts = new Map();

// ─── Track if scheduler is running ───
let schedulerInterval = null;
let isRunning = false;

// ─── Get unread count for a user from database ───
async function getUserUnreadCount(userId) {
    try {
        if (!userId) return 0;

        const result = await Lead.aggregate([
            { $match: { userId: userId } },
            { $group: { _id: null, totalUnread: { $sum: '$unreadCount' } } }
        ]);

        return result.length > 0 ? result[0].totalUnread : 0;
    } catch (error) {
        console.error('❌ [unreadScheduler] getUserUnreadCount error:', error.message);
        return 0;
    }
}

// ─── Check unread counts for ALL connected users ───
async function checkAllUnreadCounts() {
    try {
        // Get all users with active SSE connections
        const activeUsers = sseManager.getActiveUsers ? sseManager.getActiveUsers() : [];

        if (activeUsers.length === 0) {
            // No users connected, skip
            return;
        }

        let updatedCount = 0;

        for (const userId of activeUsers) {
            try {
                const currentCount = await getUserUnreadCount(userId);
                const previousCount = previousCounts.get(userId) || 0;

                // ✅ Only send if count changed
                if (currentCount !== previousCount) {
                    updatedCount++;

                    console.log(`📨 [unreadScheduler] User ${userId}: ${previousCount} → ${currentCount}`);

                    // Send event to this user's SSE connection
                    if (sseManager.sendToUser) {
                        sseManager.sendToUser(userId, {
                            type: 'unread_update',
                            count: currentCount,
                            hasUnread: currentCount > 0,
                            timestamp: Date.now()
                        });
                    }

                    // Store new count
                    previousCounts.set(userId, currentCount);
                }
            } catch (userError) {
                console.error(`❌ [unreadScheduler] Error processing user ${userId}:`, userError.message);
            }
        }

        if (updatedCount > 0) {
            console.log(`📊 [unreadScheduler] Sent ${updatedCount} updates to ${activeUsers.length} connected users`);
        }

    } catch (error) {
        console.error('❌ [unreadScheduler] checkAllUnreadCounts error:', error.message);
    }
}

// ─── Force check for a specific user ───
async function forceCheckForUser(userId) {
    try {
        if (!userId) return;

        const currentCount = await getUserUnreadCount(userId);
        const previousCount = previousCounts.get(userId) || 0;

        // ✅ Always update previous count
        previousCounts.set(userId, currentCount);

        // Send event even if count didn't change (forced update)
        if (sseManager.sendToUser) {
            sseManager.sendToUser(userId, {
                type: 'unread_update',
                count: currentCount,
                hasUnread: currentCount > 0,
                timestamp: Date.now(),
                forced: true
            });
        }

        console.log(`📨 [unreadScheduler] Force update for user ${userId}: ${currentCount}`);

    } catch (error) {
        console.error(`❌ [unreadScheduler] forceCheckForUser error:`, error.message);
    }
}

// ─── Reset previous counts for a user ───
function resetUserCount(userId) {
    if (userId) {
        previousCounts.delete(userId);
        console.log(`🔄 [unreadScheduler] Reset count for user ${userId}`);
    }
}

// ─── Clear all previous counts ───
function clearAllCounts() {
    previousCounts.clear();
    console.log('🔄 [unreadScheduler] Cleared all previous counts');
}

// ─── Get current stored count for a user ───
function getStoredCount(userId) {
    return previousCounts.get(userId) || 0;
}

// ─── Start the scheduler ───
function startUnreadScheduler() {
    if (isRunning) {
        console.log('⚠️ [unreadScheduler] Already running');
        return;
    }

    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }

    console.log('⏰ [unreadScheduler] Starting - checking every 4 seconds');
    isRunning = true;

    // ✅ Run once immediately
    setTimeout(function() {
        checkAllUnreadCounts();
    }, 500);

    // ✅ Then every 4 seconds
    schedulerInterval = setInterval(checkAllUnreadCounts, 4000);
}

// ─── Stop the scheduler ───
function stopUnreadScheduler() {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
        isRunning = false;
        console.log('⏰ [unreadScheduler] Stopped');
    }
}

// ─── Check if scheduler is running ───
function isSchedulerRunning() {
    return isRunning;
}

module.exports = {
    startUnreadScheduler,
    stopUnreadScheduler,
    checkAllUnreadCounts,
    forceCheckForUser,
    resetUserCount,
    clearAllCounts,
    getStoredCount,
    isSchedulerRunning
};
