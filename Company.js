// Company.js
const mongoose = require('mongoose');

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
    employeeCount: { type: String, default: '' }, // e.g., "11-50"
    emails: [{ type: String }],
    researchSummary: { type: String, default: '' },
    leadScore: { type: Number, default: 0, min: 0, max: 100 },
    confidenceTier: { 
        type: String, 
        enum: ['High', 'Medium', 'Low'], 
        default: 'Low' 
    },
    lastUpdated: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});

// Index for faster lookups
CompanySchema.index({ domain: 1 });
CompanySchema.index({ leadScore: -1 });

module.exports = mongoose.model('Company', CompanySchema);
