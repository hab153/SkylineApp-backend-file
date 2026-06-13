// companyMemoryService.js
const crypto = require('crypto');
const Company = require('./Company');
const SearchCache = require('./SearchCache');

// Helper: extract domain from email or URL
function extractDomain(input) {
    if (!input) return null;
    let str = input.toLowerCase().trim();
    // If it's an email, take part after @
    if (str.includes('@')) {
        str = str.split('@')[1];
    }
    // Remove http://, https://, www.
    str = str.replace(/^(https?:\/\/)?(www\.)?/, '');
    // Remove path and query parameters
    const slashIndex = str.indexOf('/');
    if (slashIndex !== -1) str = str.substring(0, slashIndex);
    return str;
}

// Helper: calculate lead score based on available data
function calculateLeadScore(companyData) {
    let score = 0;
    if (companyData.emails && companyData.emails.length > 0) score += 30;
    if (companyData.researchSummary && companyData.researchSummary.length > 50) score += 20;
    if (companyData.employeeCount && companyData.employeeCount !== 'Unknown') score += 15;
    if (companyData.industry && companyData.industry !== 'Unknown') score += 15;
    if (companyData.country && companyData.country !== 'Unknown') score += 10;
    // Extra 10 points for confidence if all fields are filled
    if (companyData.emails && companyData.emails.length > 0 && companyData.researchSummary && companyData.employeeCount) score += 10;
    return Math.min(score, 100);
}

// Helper: determine confidence tier from score
function getConfidenceTier(score) {
    if (score >= 70) return 'High';
    if (score >= 40) return 'Medium';
    return 'Low';
}

// Save or update a company from lead data
async function saveCompanyFromLead(lead) {
    const domain = extractDomain(lead.email || lead.website || lead.domain);
    if (!domain) return null;
    
    const companyData = {
        domain,
        name: lead.company || lead.name || domain,
        industry: lead.industry || '',
        country: lead.country || '',
        employeeCount: lead.companySize || '',
        emails: lead.email ? [lead.email] : [],
        researchSummary: lead.research || lead.messages?.[0]?.body || '',
    };
    
    // Calculate score and tier
    const score = calculateLeadScore(companyData);
    companyData.leadScore = score;
    companyData.confidenceTier = getConfidenceTier(score);
    companyData.lastUpdated = new Date();
    
    const company = await Company.findOneAndUpdate(
        { domain },
        { $set: companyData },
        { upsert: true, new: true }
    );
    return company;
}

// Get companies from cache by query hash
async function getCachedSearchResults(queryHash) {
    const cached = await SearchCache.findOne({ 
        queryHash, 
        expiresAt: { $gt: new Date() } 
    }).populate('companyIds');
    if (!cached) return null;
    return cached.companyIds;
}

// Save search cache – TTL now 90 days (changed from 30)
async function saveSearchCache(queryHash, queryParams, companyIds, ttlDays = 90) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + ttlDays);
    
    await SearchCache.findOneAndUpdate(
        { queryHash },
        { 
            queryParams, 
            companyIds, 
            expiresAt,
            createdAt: new Date()
        },
        { upsert: true }
    );
}

// Generate consistent hash from search parameters
function generateQueryHash(params) {
    const { industry, region, jobTitle, companySize } = params;
    const normalized = `${industry}|${region}|${jobTitle}|${companySize}`.toLowerCase().trim();
    return crypto.createHash('md5').update(normalized).digest('hex');
}

module.exports = {
    extractDomain,
    calculateLeadScore,
    getConfidenceTier,
    saveCompanyFromLead,
    getCachedSearchResults,
    saveSearchCache,
    generateQueryHash
};
