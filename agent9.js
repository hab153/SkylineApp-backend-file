'use strict';

/**
 * agent9.js – Stage 9: Skyline Knowledge Repository & Intelligent Retrieval Engine
 * 
 * The knowledge repository and retrieval engine of Skyline's Lead Intelligence System.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Store completed prospecting packages as reusable knowledge assets.
 * 2. Intelligently retrieve packages based on semantic similarity.
 * 3. Match requests by meaning, not exact wording.
 * 4. Handle quantity matching (return requested amount or max available).
 * 5. Auto-delete packages older than 2 months.
 * 6. Block requests after 20 identical matches for 24 hours.
 * 7. Prevent duplicate storage of identical packages.
 * 8. Provide fast retrieval without re-running Stages 1-8.
 * 
 * SKYLINE PHILOSOPHY:
 * Every completed search increases Skyline's intelligence.
 * Instead of forgetting, Skyline remembers.
 * Every completed request becomes knowledge that may help future users.
 * 
 * YOU MUST NOT:
 * - Return data that doesn't exist.
 * - Claim to have more leads than actually stored.
 * - Keep data older than 2 months.
 * - Allow unlimited identical requests without cooldown.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const REPOSITORY_DIR = process.env.SKYLINE_REPO_DIR || './knowledge_repository';
const MAX_PACKAGE_AGE_DAYS = 60; // 2 months
const MAX_IDENTICAL_REQUESTS = 20;
const COOLDOWN_HOURS = 24;
const MAX_RETURNED_LEADS = 1000;
const SIMILARITY_THRESHOLD = 0.65;

// ────────────────────────────────────────────────────────────────
// 2. Repository Initialization
// ────────────────────────────────────────────────────────────────

function initializeRepository() {
    if (!fs.existsSync(REPOSITORY_DIR)) {
        fs.mkdirSync(REPOSITORY_DIR, { recursive: true });
        console.log(`📁 [Stage9] Repository created at: ${REPOSITORY_DIR}`);
    }

    // Create subdirectories
    const subdirs = ['packages', 'metadata', 'indexes', 'cooldowns'];
    for (const dir of subdirs) {
        const fullPath = path.join(REPOSITORY_DIR, dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
    }

    // Load or create index
    const indexFile = path.join(REPOSITORY_DIR, 'indexes', 'master_index.json');
    if (!fs.existsSync(indexFile)) {
        fs.writeFileSync(indexFile, JSON.stringify({ packages: [], version: 1, updated: new Date().toISOString() }, null, 2));
    }

    console.log('✅ [Stage9] Repository initialized');
    return true;
}

// ────────────────────────────────────────────────────────────────
// 3. Package ID Generation
// ────────────────────────────────────────────────────────────────

function generatePackageId(request) {
    const normalized = normalizeRequest(request);
    const hash = crypto.createHash('sha256')
        .update(JSON.stringify(normalized))
        .digest('hex')
        .substring(0, 16);
    return `pkg_${hash}_${Date.now().toString(36)}`;
}

function normalizeRequest(request) {
    // Extract key features for matching
    const normalized = {
        industry: extractIndustry(request),
        location: extractLocation(request),
        role: extractRole(request),
        intent: extractIntent(request),
        keywords: extractKeywords(request),
        original: request
    };
    return normalized;
}

// ────────────────────────────────────────────────────────────────
// 4. Semantic Matching Helpers
// ────────────────────────────────────────────────────────────────

function extractIndustry(text) {
    const industries = [
        'cybersecurity', 'fintech', 'healthcare', 'saas', 'manufacturing',
        'real estate', 'legal', 'education', 'retail', 'logistics',
        'energy', 'agriculture', 'construction', 'consulting', 'marketing',
        'media', 'entertainment', 'gaming', 'biotech', 'pharma',
        'automotive', 'aerospace', 'defense', 'telecom', 'banking',
        'insurance', 'hospitality', 'food', 'beverage', 'fashion',
        'beauty', 'wellness', 'fitness', 'sports', 'nonprofit'
    ];
    const lower = text.toLowerCase();
    for (const ind of industries) {
        if (lower.includes(ind)) return ind;
    }
    return null;
}

function extractLocation(text) {
    const locations = [
        'usa', 'uk', 'germany', 'canada', 'australia', 'france',
        'spain', 'italy', 'japan', 'china', 'india', 'brazil',
        'mexico', 'netherlands', 'sweden', 'norway', 'denmark',
        'switzerland', 'austria', 'belgium', 'ireland', 'new zealand',
        'singapore', 'malaysia', 'south africa', 'nigeria', 'kenya',
        'egypt', 'israel', 'uae', 'saudi arabia', 'qatar'
    ];
    const lower = text.toLowerCase();
    for (const loc of locations) {
        if (lower.includes(loc)) return loc;
    }
    return null;
}

function extractRole(text) {
    const roles = [
        'ceo', 'cto', 'cfo', 'coo', 'cmo', 'founder', 'co-founder',
        'director', 'vp', 'head', 'manager', 'lead', 'executive',
        'president', 'chairman', 'partner', 'principal', 'owner'
    ];
    const lower = text.toLowerCase();
    for (const role of roles) {
        if (lower.includes(role)) return role;
    }
    return null;
}

function extractIntent(text) {
    const intents = [
        'find', 'search', 'discover', 'research', 'investigate',
        'explore', 'identify', 'locate', 'uncover', 'reveal',
        'generate', 'create', 'build', 'compile', 'assemble'
    ];
    const lower = text.toLowerCase();
    for (const intent of intents) {
        if (lower.includes(intent)) return intent;
    }
    return 'find';
}

function extractKeywords(text) {
    const words = text.toLowerCase().split(/\s+/);
    const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'to', 'of', 'and', 'or', 'but', 'so', 'for', 'nor', 'yet', 'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being']);
    return words.filter(w => !stopWords.has(w) && w.length > 3).slice(0, 10);
}

function calculateSimilarity(request1, request2) {
    // Extract features from both requests
    const features1 = {
        industry: extractIndustry(request1),
        location: extractLocation(request1),
        role: extractRole(request1),
        keywords: extractKeywords(request1)
    };
    const features2 = {
        industry: extractIndustry(request2),
        location: extractLocation(request2),
        role: extractRole(request2),
        keywords: extractKeywords(request2)
    };

    let score = 0;
    let total = 0;

    // Industry match (weight: 0.35)
    if (features1.industry && features2.industry) {
        total += 0.35;
        if (features1.industry === features2.industry) score += 0.35;
    }

    // Location match (weight: 0.25)
    if (features1.location && features2.location) {
        total += 0.25;
        if (features1.location === features2.location) score += 0.25;
    }

    // Role match (weight: 0.20)
    if (features1.role && features2.role) {
        total += 0.20;
        if (features1.role === features2.role) score += 0.20;
    }

    // Keyword overlap (weight: 0.20)
    if (features1.keywords.length > 0 && features2.keywords.length > 0) {
        total += 0.20;
        const overlap = features1.keywords.filter(k => features2.keywords.includes(k));
        const maxKeywords = Math.max(features1.keywords.length, features2.keywords.length);
        if (maxKeywords > 0) {
            score += (overlap.length / maxKeywords) * 0.20;
        }
    }

    // If no features matched, calculate a basic text similarity
    if (total === 0) {
        const words1 = new Set(request1.toLowerCase().split(/\s+/));
        const words2 = new Set(request2.toLowerCase().split(/\s+/));
        const intersection = new Set([...words1].filter(x => words2.has(x)));
        const union = new Set([...words1, ...words2]);
        return intersection.size / union.size;
    }

    return score / total;
}

// ────────────────────────────────────────────────────────────────
// 5. Package Storage
// ────────────────────────────────────────────────────────────────

function storePackage(packageData) {
    try {
        // Generate package ID
        const packageId = packageData.package_id || generatePackageId(packageData.request);

        // Extract normalized request for indexing
        const normalized = normalizeRequest(packageData.request);

        // Build the full package
        const fullPackage = {
            package_id: packageId,
            request: packageData.request,
            normalized_request: normalized,
            search_parameters: packageData.search_parameters || {},
            companies: packageData.companies || [],
            total_companies: packageData.companies?.length || 0,
            stats: packageData.stats || {},
            metadata: {
                created_at: new Date().toISOString(),
                last_validated: new Date().toISOString(),
                last_updated: new Date().toISOString(),
                version: 1,
                user_id: packageData.userId || 'anonymous',
                request_count: 1,
                last_requested: new Date().toISOString()
            },
            freshness: {
                created_at: new Date().toISOString(),
                last_validation: new Date().toISOString(),
                last_update: new Date().toISOString(),
                expires_at: new Date(Date.now() + MAX_PACKAGE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString()
            },
            _original: packageData
        };

        // Save package to file
        const packagePath = path.join(REPOSITORY_DIR, 'packages', `${packageId}.json`);
        fs.writeFileSync(packagePath, JSON.stringify(fullPackage, null, 2));

        // Update index
        const indexFile = path.join(REPOSITORY_DIR, 'indexes', 'master_index.json');
        const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        index.packages.push({
            package_id: packageId,
            request: packageData.request,
            normalized: normalized,
            total_companies: fullPackage.total_companies,
            created_at: fullPackage.metadata.created_at,
            expires_at: fullPackage.freshness.expires_at
        });
        index.updated = new Date().toISOString();
        fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

        console.log(`✅ [Stage9] Package stored: ${packageId} with ${fullPackage.total_companies} companies`);
        return packageId;

    } catch (error) {
        console.error('❌ [Stage9] Failed to store package:', error.message);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// 6. Package Retrieval
// ────────────────────────────────────────────────────────────────

function retrievePackage(request, limit = null) {
    try {
        // Step 1: Clean expired packages
        cleanExpiredPackages();

        // Step 2: Check cooldown
        const cooldownStatus = checkCooldown(request);
        if (cooldownStatus.blocked) {
            return {
                success: false,
                blocked: true,
                message: `This request has been made ${cooldownStatus.count} times. Please wait ${cooldownStatus.remaining_hours} hours.`,
                cooldown_until: cooldownStatus.cooldown_until
            };
        }

        // Step 3: Find matching package
        const match = findMatchingPackage(request);
        if (!match) {
            return {
                success: false,
                found: false,
                message: 'No matching knowledge package found.'
            };
        }

        // Step 4: Load the package
        const packagePath = path.join(REPOSITORY_DIR, 'packages', `${match.package_id}.json`);
        if (!fs.existsSync(packagePath)) {
            // Remove from index if file missing
            removeFromIndex(match.package_id);
            return {
                success: false,
                found: false,
                message: 'Package file not found.'
            };
        }

        const fullPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

        // Step 5: Apply quantity limit
        const requestedLimit = limit || fullPackage.total_companies;
        const returnLimit = Math.min(requestedLimit, fullPackage.total_companies);

        let companies = fullPackage.companies;
        if (returnLimit < fullPackage.total_companies) {
            // Return top N companies
            companies = companies.slice(0, returnLimit);
        }

        // Step 6: Update metadata (request count, last requested)
        fullPackage.metadata.request_count = (fullPackage.metadata.request_count || 0) + 1;
        fullPackage.metadata.last_requested = new Date().toISOString();
        fs.writeFileSync(packagePath, JSON.stringify(fullPackage, null, 2));

        // Step 7: Record this request for cooldown tracking
        recordRequest(request);

        console.log(`✅ [Stage9] Retrieved package: ${match.package_id} (${companies.length} companies)`);

        return {
            success: true,
            found: true,
            package_id: match.package_id,
            request: fullPackage.request,
            normalized_match: match.normalized,
            companies: companies,
            total_available: fullPackage.total_companies,
            returned: companies.length,
            metadata: fullPackage.metadata,
            similarity_score: match.similarity_score,
            freshness: fullPackage.freshness,
            stats: fullPackage.stats
        };

    } catch (error) {
        console.error('❌ [Stage9] Failed to retrieve package:', error.message);
        return {
            success: false,
            found: false,
            error: error.message
        };
    }
}

// ────────────────────────────────────────────────────────────────
// 7. Find Matching Package
// ────────────────────────────────────────────────────────────────

function findMatchingPackage(request) {
    const indexFile = path.join(REPOSITORY_DIR, 'indexes', 'master_index.json');
    if (!fs.existsSync(indexFile)) {
        return null;
    }

    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    let bestMatch = null;
    let bestScore = 0;

    for (const pkg of index.packages) {
        // Skip expired packages
        if (pkg.expires_at && new Date(pkg.expires_at) < new Date()) {
            continue;
        }

        const similarity = calculateSimilarity(request, pkg.request || '');
        if (similarity > SIMILARITY_THRESHOLD && similarity > bestScore) {
            bestScore = similarity;
            bestMatch = {
                ...pkg,
                similarity_score: similarity
            };
        }
    }

    return bestMatch;
}

// ────────────────────────────────────────────────────────────────
// 8. Cooldown Management
// ────────────────────────────────────────────────────────────────

function checkCooldown(request) {
    const cooldownFile = path.join(REPOSITORY_DIR, 'cooldowns', 'cooldowns.json');
    if (!fs.existsSync(cooldownFile)) {
        return { blocked: false, count: 0 };
    }

    const cooldowns = JSON.parse(fs.readFileSync(cooldownFile, 'utf8'));
    const requestKey = generateRequestKey(request);

    const entry = cooldowns[requestKey];
    if (!entry) {
        return { blocked: false, count: 0 };
    }

    const now = Date.now();

    // If cooldown has expired, reset
    if (entry.cooldown_until && entry.cooldown_until < now) {
        delete cooldowns[requestKey];
        fs.writeFileSync(cooldownFile, JSON.stringify(cooldowns, null, 2));
        return { blocked: false, count: 0 };
    }

    // If request count exceeds limit, block
    if (entry.count >= MAX_IDENTICAL_REQUESTS) {
        const remainingHours = Math.ceil((entry.cooldown_until - now) / (60 * 60 * 1000));
        return {
            blocked: true,
            count: entry.count,
            cooldown_until: entry.cooldown_until,
            remaining_hours: Math.max(0, remainingHours)
        };
    }

    return { blocked: false, count: entry.count };
}

function recordRequest(request) {
    const cooldownFile = path.join(REPOSITORY_DIR, 'cooldowns', 'cooldowns.json');
    let cooldowns = {};
    if (fs.existsSync(cooldownFile)) {
        cooldowns = JSON.parse(fs.readFileSync(cooldownFile, 'utf8'));
    }

    const requestKey = generateRequestKey(request);
    const now = Date.now();

    if (!cooldowns[requestKey]) {
        cooldowns[requestKey] = {
            count: 1,
            first_request: now,
            cooldown_until: now + COOLDOWN_HOURS * 60 * 60 * 1000
        };
    } else {
        cooldowns[requestKey].count += 1;
        // Reset cooldown timer only if not already blocked
        if (cooldowns[requestKey].cooldown_until < now) {
            cooldowns[requestKey].cooldown_until = now + COOLDOWN_HOURS * 60 * 60 * 1000;
        }
    }

    fs.writeFileSync(cooldownFile, JSON.stringify(cooldowns, null, 2));
}

function generateRequestKey(request) {
    const normalized = normalizeRequest(request);
    return crypto.createHash('sha256')
        .update(JSON.stringify(normalized))
        .digest('hex')
        .substring(0, 16);
}

// ────────────────────────────────────────────────────────────────
// 9. Cleanup: Expired Packages
// ────────────────────────────────────────────────────────────────

function cleanExpiredPackages() {
    const indexFile = path.join(REPOSITORY_DIR, 'indexes', 'master_index.json');
    if (!fs.existsSync(indexFile)) {
        return 0;
    }

    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const now = Date.now();
    let removed = 0;

    const validPackages = [];

    for (const pkg of index.packages) {
        // Check if package has expired
        const expiresAt = pkg.expires_at ? new Date(pkg.expires_at).getTime() : null;
        const created = pkg.created_at ? new Date(pkg.created_at).getTime() : null;

        // If expires_at is set and expired, remove
        if (expiresAt && expiresAt < now) {
            // Delete the package file
            const packagePath = path.join(REPOSITORY_DIR, 'packages', `${pkg.package_id}.json`);
            if (fs.existsSync(packagePath)) {
                fs.unlinkSync(packagePath);
                console.log(`🗑️ [Stage9] Removed expired package: ${pkg.package_id}`);
            }
            removed++;
            continue;
        }

        // If created date is older than max age, remove
        if (created && (now - created) > MAX_PACKAGE_AGE_DAYS * 24 * 60 * 60 * 1000) {
            // Delete the package file
            const packagePath = path.join(REPOSITORY_DIR, 'packages', `${pkg.package_id}.json`);
            if (fs.existsSync(packagePath)) {
                fs.unlinkSync(packagePath);
                console.log(`🗑️ [Stage9] Removed old package (${MAX_PACKAGE_AGE_DAYS} days): ${pkg.package_id}`);
            }
            removed++;
            continue;
        }

        validPackages.push(pkg);
    }

    // Update index with only valid packages
    if (removed > 0) {
        index.packages = validPackages;
        index.updated = new Date().toISOString();
        fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    }

    return removed;
}

function removeFromIndex(packageId) {
    const indexFile = path.join(REPOSITORY_DIR, 'indexes', 'master_index.json');
    if (!fs.existsSync(indexFile)) return;

    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index.packages = index.packages.filter(p => p.package_id !== packageId);
    index.updated = new Date().toISOString();
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
}

// ────────────────────────────────────────────────────────────────
// 10. Statistics & Health
// ────────────────────────────────────────────────────────────────

function getRepositoryStats() {
    const indexFile = path.join(REPOSITORY_DIR, 'indexes', 'master_index.json');
    if (!fs.existsSync(indexFile)) {
        return {
            total_packages: 0,
            total_companies: 0,
            oldest_package: null,
            newest_package: null,
            average_companies_per_package: 0
        };
    }

    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const packages = index.packages || [];

    let totalCompanies = 0;
    let oldest = null;
    let newest = null;

    for (const pkg of packages) {
        totalCompanies += pkg.total_companies || 0;
        if (!oldest || pkg.created_at < oldest) oldest = pkg.created_at;
        if (!newest || pkg.created_at > newest) newest = pkg.created_at;
    }

    return {
        total_packages: packages.length,
        total_companies: totalCompanies,
        oldest_package: oldest,
        newest_package: newest,
        average_companies_per_package: packages.length > 0 ? Math.round(totalCompanies / packages.length) : 0
    };
}

// ────────────────────────────────────────────────────────────────
// 11. Main Stage 9 Function: Knowledge Repository
// ────────────────────────────────────────────────────────────────

async function manageKnowledge(request, options = {}) {
    const {
        action = 'retrieve', // 'retrieve' | 'store' | 'stats' | 'cleanup'
        packageData = null,
        userId = 'anonymous',
        limit = null,
        forceNew = false
    } = options;

    // Initialize repository
    initializeRepository();

    // Clean expired packages on every call
    cleanExpiredPackages();

    if (action === 'stats') {
        return {
            success: true,
            stats: getRepositoryStats()
        };
    }

    if (action === 'cleanup') {
        const removed = cleanExpiredPackages();
        return {
            success: true,
            removed: removed,
            stats: getRepositoryStats()
        };
    }

    if (action === 'store') {
        if (!packageData) {
            return {
                success: false,
                error: 'No package data provided for storage'
            };
        }

        const packageId = storePackage(packageData);
        return {
            success: !!packageId,
            package_id: packageId,
            stats: getRepositoryStats()
        };
    }

    // Default: retrieve
    if (!request) {
        return {
            success: false,
            error: 'No request provided for retrieval'
        };
    }

    // If forceNew is true, skip retrieval and return not found
    if (forceNew) {
        return {
            success: false,
            found: false,
            message: 'Force new search requested.',
            force_new: true
        };
    }

    const result = retrievePackage(request, limit);
    return result;
}

// ────────────────────────────────────────────────────────────────
// 12. checkExisting - Wrapper for Free.js compatibility
// ────────────────────────────────────────────────────────────────

function checkExisting(request) {
    try {
        // Clean expired packages first
        cleanExpiredPackages();

        // Find matching package
        const match = findMatchingPackage(request);
        
        if (!match) {
            return {
                exists: false,
                message: 'No data found'
            };
        }

        // Check cooldown
        const cooldownStatus = checkCooldown(request);
        if (cooldownStatus.blocked) {
            return {
                exists: true,
                blocked: true,
                packageId: match.package_id,
                message: `This request has been made ${cooldownStatus.count} times. Please wait ${cooldownStatus.remaining_hours} hours.`,
                cooldown_until: cooldownStatus.cooldown_until
            };
        }

        // Load the package to get more details
        const packagePath = path.join(REPOSITORY_DIR, 'packages', `${match.package_id}.json`);
        if (!fs.existsSync(packagePath)) {
            removeFromIndex(match.package_id);
            return { exists: false, message: 'Package file not found' };
        }

        const fullPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

        return {
            exists: true,
            blocked: false,
            packageId: match.package_id,
            totalAvailable: fullPackage.total_companies || 0,
            age: Math.floor((Date.now() - new Date(fullPackage.metadata?.created_at || Date.now()).getTime()) / (1000 * 60 * 60 * 24)),
            isStale: false,
            similarity_score: match.similarity_score || 0
        };

    } catch (error) {
        console.error('❌ [Stage9] checkExisting error:', error.message);
        return { exists: false, message: 'Error checking repository' };
    }
}

// ────────────────────────────────────────────────────────────────
// 13. retrievePackageWrapper - Wrapper for Free.js compatibility
// ────────────────────────────────────────────────────────────────

function retrievePackageWrapper(request, limit = null) {
    const result = retrievePackage(request, limit);
    
    if (result.success && result.found) {
        return {
            found: true,
            packageId: result.package_id,
            totalAvailable: result.total_available,
            leads: (result.companies || []).map(c => {
                // Check if company has outreach data
                const hasOutreach = c.outreach || c.messages;
                return {
                    name: c.name || c.company_name || c.company || 'Unknown',
                    company: c.company || c.company_name || c.name || 'Unknown',
                    domain: c.domain || c.company_domain || null,
                    email: c.email || c.contact_email || null,
                    messages: hasOutreach ? [
                        {
                            type: 'initial',
                            subject: c.outreach?.subject || (c.messages && c.messages[0]?.subject) || `Introduction: ${c.name || 'Your Company'}`,
                            body: c.outreach?.body || (c.messages && c.messages[0]?.body) || `Hi,\n\nI came across your company and wanted to reach out.\n\nBest,\nAlex`
                        },
                        {
                            type: 'followup',
                            subject: `Re: ${c.outreach?.subject || (c.messages && c.messages[0]?.subject) || `Introduction: ${c.name || 'Your Company'}`}`,
                            body: `Hi,\n\nJust following up on my previous message.\n\nBest,\nAlex`
                        },
                        {
                            type: 'breakup',
                            subject: `Closing the loop`,
                            body: `Hi,\n\nAssuming timing isn't right, I'll stop following up. Reach out whenever it makes sense.\n\nBest,\nAlex`
                        }
                    ] : [
                        {
                            type: 'initial',
                            subject: `Introduction: ${c.name || 'Your Company'}`,
                            body: `Hi,\n\nI came across your company and wanted to reach out.\n\nBest,\nAlex`
                        }
                    ],
                    leadScore: c.leadScore || c.confidence || 0.5,
                    ...c
                };
            }) || [],
            companies: result.companies || [],
            emails: result.companies?.map(c => c.email || c.contact_email).filter(Boolean) || [],
            messages: result.companies?.map(c => c.messages || c.outreach).filter(Boolean) || [],
            metadata: result.metadata || {},
            isStale: false,
            age: Math.floor((Date.now() - new Date(result.metadata?.created_at || Date.now()).getTime()) / (1000 * 60 * 60 * 24)),
            similarity_score: result.similarity_score || 0
        };
    }

    return {
        found: false,
        message: result.message || 'No data found'
    };
}

// ────────────────────────────────────────────────────────────────
// 14. storePackageWrapper - Wrapper for Free.js compatibility
// ────────────────────────────────────────────────────────────────

function storePackageWrapper(packageData) {
    return storePackage(packageData);
}

// ────────────────────────────────────────────────────────────────
// 15. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
    // Main functions for Free.js compatibility
    checkExisting,
    retrievePackage: retrievePackageWrapper,
    storePackage: storePackageWrapper,

    // Legacy functions
    manageKnowledge,
    storePackage,
    retrievePackage,
    findMatchingPackage,
    checkCooldown,
    recordRequest,
    cleanExpiredPackages,
    getRepositoryStats,
    initializeRepository,
    generatePackageId,
    normalizeRequest,
    calculateSimilarity,

    // Configuration constants
    MAX_PACKAGE_AGE_DAYS,
    MAX_IDENTICAL_REQUESTS,
    COOLDOWN_HOURS,
    SIMILARITY_THRESHOLD,
    MAX_RETURNED_LEADS,
    REPOSITORY_DIR
};
