const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    type: {
        type: String,
        enum: ['lead', 'assistant'],
        required: true,
        default: 'lead'
    },
    name: {
        type: String,
        default: function() {
            return this.type === 'assistant' ? 'Assistant Chat' : 'Lead Search';
        }
    },
    pinned: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },

    // ──────────────────────────────────────────────────────────
    // ✅ NEW: Clarification State — Stores pending clarification
    // ──────────────────────────────────────────────────────────
    clarificationState: {
        type: {
            originalMessage: { type: String, default: null },
            parsedRequest: { type: Object, default: null },
            ambiguousValue: { type: String, default: null },
            pendingField: { type: String, default: null },
            ambiguities: { type: Array, default: [] },
            status: { type: String, enum: ['awaiting_clarification', 'resolved', 'expired'], default: null },
            createdAt: { type: Date, default: null }
        },
        default: null
    }
});

// Index for sorting by pinned then updated
SessionSchema.index({ userId: 1, pinned: -1, updatedAt: -1 });
// Ensure sessionId uniqueness
SessionSchema.index({ sessionId: 1 }, { unique: true });

module.exports = mongoose.model('Session', SessionSchema);
