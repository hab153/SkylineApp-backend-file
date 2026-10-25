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
        index: true
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
    // ✅ UPDATED: Expanded enum to support pause/cancel states
    status: {
        type: String,
        enum: ['pending', 'sending', 'sent', 'failed', 'cancelled', 'paused'],
        default: 'pending',
        index: true
    },
    approved: {
        type: Boolean,
        default: false
    },
    failureReason: {
        type: String,
        default: null
    },
    // ✅ NEW: Preserves original send time when paused for accurate resume calculation
    originalScheduledAt: {
        type: Date,
        default: null
    },
    // ✅ NEW: Audit trail for pause duration and debugging
    pausedAt: {
        type: Date,
        default: null
    }
}, {
    timestamps: true
});

// Compound index for efficient cron job queries: find pending messages due now
scheduledMessageSchema.index({ scheduledAt: 1, status: 1 });
// ✅ NEW: Index for fast user-level automation queries
scheduledMessageSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('ScheduledMessage', scheduledMessageSchema);
