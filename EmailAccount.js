// EmailAccount.js
const mongoose = require('mongoose');

const EmailAccountSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    nylasGrantId: {
        type: String,
        required: true,
        unique: true, // Ensures one grant per account
        index: true
    },
    emailAddress: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    provider: {
        type: String,
        enum: ['gmail', 'outlook', 'yahoo'],
        default: 'gmail'
    },
    isConnected: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

module.exports = mongoose.model('EmailAccount', EmailAccountSchema);
