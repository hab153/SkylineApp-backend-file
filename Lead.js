// Lead.js
const mongoose = require('mongoose');

const LeadSchema = new mongoose.Schema({
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true,
        index: true 
    },
    // Contact Information
    name: { type: String, required: true },
    email: { type: String, required: true, index: true },
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
        from: { type: String, enum: ['lead', 'ai'] },
        emailId: String
    }],

    // AUTO-REPLY SETTINGS
    autoReplyEnabled: {
        type: Boolean,
        default: false
    },
    autoReplyInstructions: {
        type: String,
        default: ''
    },

    // ─── FOLLOW-UP SYSTEM FIELDS (NEW) ──────────────────────────────
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

    // ─── CONFIDENCE SCORING FIELDS ──────────────────────────────
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
        default: '#ef4444' // Red
    },

    createdAt: { type: Date, default: Date.now }
});

LeadSchema.index({ nextActionDate: 1, status: 1 });
// Index for follow-up job queries
LeadSchema.index({ autoFollowUpEnabled: 1, followUpScheduledDate: 1 });

module.exports = mongoose.model('Lead', LeadSchema);
