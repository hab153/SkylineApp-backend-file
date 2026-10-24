const mongoose = require('mongoose');

const scheduledMessageSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    leadEmail: {
        type: String,
        required: true
    },
    companyName: {
        type: String,
        required: true
    },
    subject: {
        type: String,
        required: true
    },
    body: {
        type: String,
        required: true
    },
    scheduledAt: {
        type: Date,
        required: true,
        index: true // Indexed for efficient cron queries by time
    },
    timezone: {
        type: String,
        required: true
    },
    paceMinutes: {
        type: Number,
        required: true,
        default: 5
    },
    safetyRules: {
        stopOnReply: { type: Boolean, default: true },
        stopOnUnsubscribe: { type: Boolean, default: true },
        skipMissingEmail: { type: Boolean, default: true }
    },
    status: {
        type: String,
        enum: ['pending', 'sending', 'sent', 'failed', 'cancelled'],
        default: 'pending',
        index: true // Composite index with scheduledAt for cron lookups
    },
    approved: {
        type: Boolean,
        default: false
    },
    failureReason: {
        type: String,
        default: null
    }
}, {
    timestamps: true // Adds createdAt and updatedAt automatically
});

// Compound index for efficient cron job queries: find pending messages due now
scheduledMessageSchema.index({ scheduledAt: 1, status: 1 });

module.exports = mongoose.model('ScheduledMessage', scheduledMessageSchema);
