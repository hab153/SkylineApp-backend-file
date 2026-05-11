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
        unique: true,
        index: true
    },
    emailAddress: {
        type: String,
        required: true,
        lowercase: true,
        trim: true
    },
    // ADD THESE TWO FIELDS
    accessToken: {
        type: String,
        required: true
    },
    refreshToken: {
        type: String,
        required: true
    },
    tokenExpiry: { // Optional: helpful to know when it expires
        type: Date
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
