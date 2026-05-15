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
    accessToken: {
        type: String,
        // FIX: removed required:true — token may be null during refresh failure.
        // Blocking saves here causes the refreshFailCount to never persist.
        default: null
    },
    refreshToken: {
        type: String,
        // FIX: removed required:true — Nylas dev mode may not return a refresh
        // token if offline_access scope was missing at connect time.
        // Records without a refreshToken are now skipped by the proactive job.
        default: null
    },
    tokenExpiry: {
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
    },
    // RETRY LOGIC FIELDS
    refreshFailCount: { 
        type: Number, 
        default: 0 
    },
    lastRefreshError: { 
        type: String, 
        default: null 
    }
}, { timestamps: true });

module.exports = mongoose.model('EmailAccount', EmailAccountSchema);
