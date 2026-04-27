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
        index: true // Index to quickly find all messages in a chat session
    },
    title: {
        type: String,
        default: 'New Dream' // Default title, updated after first message
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
    // ADDED: Feedback field for Like/Dislike
    feedback: {
        type: String,
        enum: ['like', 'dislike', null],
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model('Message', MessageSchema);
