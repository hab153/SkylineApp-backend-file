// Message.js
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    sessionId: {
        type: String,
        required: true,
        index: true
    },
    title: {
        type: String,
        default: 'New Dream'
    },
    role: {
        type: String,
        enum: ['user', 'ai'],
        required: true
    },
    content: {
        type: String,
        required: true
    },
    // THESE FIELDS ARE MISSING AND NEED TO BE ADDED:
    notificationType: {
        type: String,
        enum: ['reply', 'admin'],
        default: null
    },
    leadId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lead',
        default: null
    },
    isRead: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Message', MessageSchema);
