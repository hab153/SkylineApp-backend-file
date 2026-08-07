// sseManager.js — Shared SSE state (no circular dependencies)
var sseClients = {};

function addClient(userId, res) {
    sseClients[String(userId)] = res;
}

function removeClient(userId) {
    delete sseClients[String(userId)];
}

function notifyUser(userId, eventData) {
    var uid = String(userId);
    var client = sseClients[uid];
    if (client) {
        try {
            client.write('data: ' + JSON.stringify(eventData) + '\n\n');
            console.log('📡 [SSE] Pushed event to user ' + uid);
        } catch (e) {
            delete sseClients[uid];
        }
    }
}

function getClientCount() {
    return Object.keys(sseClients).length;
}

module.exports = {
    addClient: addClient,
    removeClient: removeClient,
    notifyUser: notifyUser,
    getClientCount: getClientCount
};
