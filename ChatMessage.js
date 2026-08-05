// ChatMessage.js
const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema({
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
    role: {
        type: String,
        enum: ['user', 'ai'],
        required: true
    },
    content: {
        type: String,
        required: true
    },
    title: {
        type: String,
        default: ''
    },
    feedback: {
        type: String,
        enum: ['like', 'dislike', null],
        default: null
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    }
});

// ✅ SPEED: Compound index for faster chat queries

ChatMessageSchema.index({ userId: 1, sessionId: 1 });
ChatMessageSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
