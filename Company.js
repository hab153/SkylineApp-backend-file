// Company.js
const mongoose = require('mongoose');
const { encrypt, decrypt } = require('./encryption');

const CompanySchema = new mongoose.Schema({
    domain: { 
        type: String, 
        required: true, 
        unique: true, 
        index: true,
        lowercase: true,
        trim: true
    },
    name: { type: String, required: true },
    industry: { type: String, default: '' },
    country: { type: String, default: '' },
    employeeCount: { type: String, default: '' },
    emails: [{
        type: String,
        // ✅ Encrypt each email when saving, decrypt when reading
        get: function(value) {
            if (!value) return null;
            try { return decrypt(value); } catch { return value; }
        },
        set: function(value) {
            if (!value) return null;
            try { return encrypt(value); } catch { return value; }
        }
    }],
    researchSummary: { type: String, default: '' },
    leadScore: { type: Number, default: 0, min: 0, max: 100 },
    confidenceTier: { 
        type: String, 
        enum: ['High', 'Medium', 'Low'], 
        default: 'Low' 
    },
    lastUpdated: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
}, {
    // Enable getters
    toJSON: { getters: true },
    toObject: { getters: true }
});

// Indexes
CompanySchema.index({ domain: 1 });
CompanySchema.index({ leadScore: -1 });

module.exports = mongoose.model('Company', CompanySchema);
