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
        enum: ['New', 'Queued', 'Contacted', 'Replied', 'Interested', 'Not Interested', 'Closed'], 
        default: 'New' 
    },
    sequenceStep: { 
        type: Number, 
        default: 0 
        // 0 = Not Started
        // 1 = Day 1 Email Sent
        // 2 = Day 3 Follow-up Sent
        // 3 = Day 6 Break-up Sent
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
        from: { type: String, enum: ['lead', 'ai'] }
    }],

    createdAt: { type: Date, default: Date.now }
});

LeadSchema.index({ nextActionDate: 1, status: 1 });
module.exports = mongoose.model('Lead', LeadSchema);
