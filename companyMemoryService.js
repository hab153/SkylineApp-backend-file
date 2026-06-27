// companyMemoryService.js
const crypto = require('crypto');
const Company = require('./Company');
const SearchCache = require('./SearchCache');

// Helper: extract domain from email or URL
function extractDomain(input) {
    if (!input) return null;
    let str = input.toLowerCase().trim();
    if (str.includes('@')) {
        str = str.split('@')[1];
    }
    str = str.replace(/^(https?:\/\/)?(www\.)?/, '');
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

// ─── FIXED: Get cached results – returns complete leads if available ───
async function getCachedSearchResults(queryHash) {
    try {
        const cached = await SearchCache.findOne({ 
            queryHash, 
            expiresAt: { $gt: new Date() } 
        });
        
        if (!cached) return null;
        
        // NEW: If cache has complete leads stored directly, return them
        if (cached.leads && Array.isArray(cached.leads) && cached.leads.length > 0) {
            console.log(`💾 [CACHE] Found ${cached.leads.length} complete leads`);
            return cached.leads;
        }
        
        // LEGACY: If cache has company IDs (old format), populate and return
        if (cached.companyIds && cached.companyIds.length > 0) {
            console.log(`💾 [CACHE] Found ${cached.companyIds.length} company IDs (legacy format)`);
            const companies = await Company.find({ 
                '_id': { $in: cached.companyIds } 
            });
            return companies;
        }
        
        return null;
    } catch (error) {
        console.error('❌ [CACHE] Error getting cached results:', error);
        return null;
    }
}

// ─── FIXED: Save search cache – stores complete leads ───
async function saveSearchCache(queryHash, queryParams, data, ttlDays = 90) {
    try {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + ttlDays);
        
        // Detect if data is complete leads (has messages field) or company IDs
        const isCompleteLead = data && data.length > 0 && data[0].messages && data[0].name;
        
        let updateData = {
            queryParams,
            expiresAt,
            createdAt: new Date(),
        };
        
        if (isCompleteLead) {
            // NEW: Store complete leads
            updateData.leads = data;
            updateData.companyIds = []; // Clear old field
            updateData._format = 'leads';
            console.log(`💾 [CACHE] Storing ${data.length} complete leads`);
        } else {
            // LEGACY: Store company IDs (fallback)
            updateData.companyIds = data;
            updateData.leads = [];
            updateData._format = 'companyIds';
            console.log(`💾 [CACHE] Storing ${data.length} company IDs (legacy)`);
        }
        
        await SearchCache.findOneAndUpdate(
            { queryHash },
            updateData,
            { upsert: true, new: true }
        );
        
        return true;
    } catch (error) {
        console.error('❌ [CACHE] Error saving cache:', error);
        return false;
    }
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
