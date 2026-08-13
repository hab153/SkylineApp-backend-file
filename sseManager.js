// ============================================================
// sseManager.js — Shared SSE state (no circular dependencies)
// Manages all Server-Sent Event connections
// Skyline AA-1
// ============================================================

var sseClients = {};

// ─── ADD CLIENT ───
function addClient(userId, res) {
    var uid = String(userId);
    sseClients[uid] = res;
    console.log('📡 [SSE] Client added: ' + uid + ' (total: ' + getClientCount() + ')');
}

// ─── REMOVE CLIENT ───
function removeClient(userId) {
    var uid = String(userId);
    if (sseClients[uid]) {
        delete sseClients[uid];
        console.log('📡 [SSE] Client removed: ' + uid + ' (total: ' + getClientCount() + ')');
    }
}

// ─── NOTIFY A SPECIFIC USER ───
function notifyUser(userId, eventData) {
    var uid = String(userId);
    var client = sseClients[uid];
    if (client) {
        try {
            client.write('data: ' + JSON.stringify(eventData) + '\n\n');
            console.log('📡 [SSE] Pushed event to user ' + uid);
            return true;
        } catch (e) {
            console.error('❌ [SSE] Error pushing to user ' + uid + ':', e.message);
            delete sseClients[uid];
            return false;
        }
    }
    return false;
}

// ─── NOTIFY ALL CLIENTS ───
function notifyAll(eventData) {
    var sent = 0;
    var userIds = Object.keys(sseClients);
    for (var i = 0; i < userIds.length; i++) {
        var uid = userIds[i];
        var client = sseClients[uid];
        if (client) {
            try {
                client.write('data: ' + JSON.stringify(eventData) + '\n\n');
                sent++;
            } catch (e) {
                delete sseClients[uid];
            }
        }
    }
    console.log('📡 [SSE] Broadcast to ' + sent + ' clients');
    return sent;
}

// ─── SEND TO USER (alias for notifyUser) ───
function sendToUser(userId, eventData) {
    return notifyUser(userId, eventData);
}

// ─── GET ALL ACTIVE USER IDs ───
function getActiveUsers() {
    return Object.keys(sseClients);
}

// ─── GET CLIENT COUNT ───
function getClientCount() {
    return Object.keys(sseClients).length;
}

// ─── CHECK IF USER IS CONNECTED ───
function isUserConnected(userId) {
    var uid = String(userId);
    return !!sseClients[uid];
}

// ─── GET CLIENT FOR USER (for debugging) ───
function getClient(userId) {
    var uid = String(userId);
    return sseClients[uid] || null;
}

// ─── CLEAR ALL CLIENTS ───
function clearAllClients() {
    var count = getClientCount();
    sseClients = {};
    console.log('📡 [SSE] Cleared all ' + count + ' clients');
}

// ─── HEARTBEAT - Keep connections alive ───
function sendHeartbeat() {
    var userIds = Object.keys(sseClients);
    for (var i = 0; i < userIds.length; i++) {
        var uid = userIds[i];
        var client = sseClients[uid];
        if (client) {
            try {
                client.write('data: ' + JSON.stringify({ type: 'heartbeat', time: Date.now() }) + '\n\n');
            } catch (e) {
                delete sseClients[uid];
            }
        }
    }
}

// ─── START HEARTBEAT (every 30 seconds) ───
var heartbeatInterval = null;

function startHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    console.log('❤️ [SSE] Heartbeat started (every 30 seconds)');
    heartbeatInterval = setInterval(sendHeartbeat, 30000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
        console.log('❤️ [SSE] Heartbeat stopped');
    }
}

// ─── EXPORTS ───
module.exports = {
    // Existing
    addClient: addClient,
    removeClient: removeClient,
    notifyUser: notifyUser,
    getClientCount: getClientCount,
    
    // NEW
    sendToUser: sendToUser,
    notifyAll: notifyAll,
    getActiveUsers: getActiveUsers,
    isUserConnected: isUserConnected,
    getClient: getClient,
    clearAllClients: clearAllClients,
    startHeartbeat: startHeartbeat,
    stopHeartbeat: stopHeartbeat,
    sendHeartbeat: sendHeartbeat
};
