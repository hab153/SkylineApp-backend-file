// Lead.js
const mongoose = require('mongoose');
const { encrypt, decrypt } = require('./encryption');

const LeadSchema = new mongoose.Schema({
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
    },
    // Contact Information
    name: { type: String, required: true },
    email: { 
        type: String, 
        required: true, 
        index: true,
        get: function(value) {
            if (!value) return null;
            try { return decrypt(value); } catch { return value; }
        },
        set: function(value) {
            if (!value) return null;
            try { return encrypt(value); } catch { return value; }
        }
    },
    linkedinUrl: { type: String, default: '' },
    company: { type: String, default: '' },
    jobTitle: { type: String, default: '' },

    // Sequence Tracking
    status: { 
        type: String, 
        enum: ['New', 'Queued', 'Contacted', 'Replied', 'Interested', 'Not Interested', 'Closed', 'Failed'], 
        default: 'New' 
    },
    sequenceStep: { 
        type: Number, 
        default: 0 
    },
    lastContactDate: { type: Date, default: null },
    nextActionDate: { type: Date, default: null }, 

    // AI Analysis Data
    sentiment: { 
        type: String, 
        enum: ['Positive', 'Neutral', 'Negative', 'Unknown'], 
        default: 'Unknown' 
    },

    // Conversation History
    replies: [{
        date: { type: Date, default: Date.now },
        content: String,
        subject: String,
        from: { type: String, enum: ['lead', 'ai', 'customer'] },
        emailId: String
    }],

    // ✅ UNREAD COUNT — WhatsApp-style dedicated field
    unreadCount: {
        type: Number,
        default: 0,
        min: 0
    },

    // ✅ THREAD ID - For tracking email conversations
    threadId: {
        type: String,
        default: null,
        index: true
    },

    // AUTO-REPLY SETTINGS
    autoReplyEnabled: {
        type: Boolean,
        default: false
    },
    autoReplyInstructions: {
        type: String,
        default: ''
    },

    // FOLLOW-UP SYSTEM FIELDS
    autoFollowUpEnabled: {
        type: Boolean,
        default: false
    },
    followUpScheduledDate: {
        type: Date,
        default: null
    },
    lastFollowUpSent: {
        type: Date,
        default: null
    },
    followUpCount: {
        type: Number,
        default: 0
    },

    // CONFIDENCE SCORING FIELDS
    confidenceScore: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    confidenceTier: {
        type: String,
        enum: ['High', 'Medium', 'Low'],
        default: 'Low'
    },
    confidenceColor: {
        type: String,
        default: '#ef4444'
    },

    createdAt: { type: Date, default: Date.now }
}, {
    toJSON: { getters: true },
    toObject: { getters: true }
});

LeadSchema.index({ nextActionDate: 1, status: 1 });
LeadSchema.index({ autoFollowUpEnabled: 1, followUpScheduledDate: 1 });
LeadSchema.index({ threadId: 1 });

LeadSchema.pre('save', function(next) {
    if (this.isModified('lastContactDate') || this.isModified('replies')) {
        console.log('💾 [MODEL-LEAD] Saving Lead:', this._id, 'Name:', this.name);
        console.log('💾 [MODEL-LEAD] Status:', this.status);
        console.log('💾 [MODEL-LEAD] Replies Count:', this.replies ? this.replies.length : 0);
    }
    next();
});

module.exports = mongoose.model('Lead', LeadSchema);
