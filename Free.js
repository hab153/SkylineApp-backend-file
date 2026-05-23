'use strict';

const axios = require('axios');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const MAX_COMPANIES_RETURNED = 10; // Limit to top 10 companies for Step 2
const TAVILY_LIMIT           = 1000;
const CURRENT_YEAR           = new Date().getFullYear();

// ─── CONTENT QUALITY FILTER — LOW-VALUE PAGE SIGNALS ─────────────────────────
const LOW_VALUE_URL_PATTERNS = [
    /\/blog\//i, /\/article\//i, /\/news\//i, /\/tutorial\//i,
    /\/how-to\//i, /\/guide\//i, /\/tips\//i, /\/resources\//i,
    /\/learn\//i, /\/wiki\//i, /\/forum\//i, /\.pdf$/i,
    /reddit\.com/i, /medium\.com/i, /quora\.com/i, /wikipedia\.org/i,
    /stackoverflow\.com/i, /hubspot\.com\/blog/i, /moz\.com\/blog/i,
];

const HIGH_VALUE_TITLE_SIGNALS = [
    'agency', 'studio', 'solutions', 'services', 'group', 'partners',
    'consulting', 'technologies', 'software', 'platform', 'media',
    'marketing', 'creative', 'digital', 'design', 'development',
    'co.', 'inc', 'ltd', 'llc', 'corp',
];

const LOW_VALUE_TITLE_SIGNALS = [
    'how to', 'guide', 'tutorial', 'best practices', 'tips for',
    'what is', 'introduction to', 'overview of', 'list of',
    'top 10', 'top 5', '10 ways', '5 ways', '7 ways',
    'blog post', 'article', 'free download', 'pdf',
];

// ─── QUOTA TRACKERS ────────────────────────────────────────────────────────────
const tavilyQuota = { used: 0, limit: TAVILY_LIMIT, lastReset: Date.now() };

function checkTavilyReset() {
    const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - tavilyQuota.lastReset >= ONE_MONTH) {
        tavilyQuota.used      = 0;
        tavilyQuota.lastReset = Date.now();
    }
}
function getTavilyRemaining() { checkTavilyReset(); return tavilyQuota.limit - tavilyQuota.used; }
function recordTavilyUsage()  { tavilyQuota.used += 1; }

// ─── RETRY HELPER ─────────────────────────────────────────────────────────────
async function withRetry(fn, label, retries = 2, delayMs = 800) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();        } catch (err) {            const isLast = attempt === retries;
            console.warn(`⚠️ [${label}] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
            if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        }
    }
    return null;
}

// ─── PAGE BUSINESS RELEVANCE SCORER ──────────────────────────────────────────
// Scores a search result 0–100 for B2B business entity relevance.
function _scorePageBusinessRelevance(result) {
    const url     = (result.url     || '').toLowerCase();
    const title   = (result.title   || '').toLowerCase();
    const snippet = (result.snippet || '').toLowerCase();

    let score = 50; // neutral baseline

    // Hard reject: known low-value URL patterns
    for (const pattern of LOW_VALUE_URL_PATTERNS) {
        if (pattern.test(url)) {
            score -= 35;
            break;
        }
    }

    // Bonus: high-value URL structure signals
    if (/\/about/i.test(url) || /\/team/i.test(url) || /\/contact/i.test(url) || /\/company/i.test(url)) {
        score += 15;
    }

    // Title signals
    for (const signal of HIGH_VALUE_TITLE_SIGNALS) {
        if (title.includes(signal)) { score += 12; break; }
    }
    for (const signal of LOW_VALUE_TITLE_SIGNALS) {
        if (title.includes(signal)) { score -= 20; break; }
    }

    // Snippet contact/email signals
    if (snippet.includes('@'))                     score += 10;
    if (snippet.includes('contact'))               score += 5;
    if (/ceo|founder|owner|director/.test(snippet)) score += 10;
    if (/agency|studio|solutions|services/.test(snippet)) score += 8;

    // Penalise generic informational content
    if (/how to|what is|tutorial|step.by.step|learn how/.test(snippet)) score -= 15;
    if (/read more|subscribe|newsletter|download free/.test(snippet))   score -= 10;

    return Math.max(0, Math.min(100, score));
}
// ─── TAVILY SEARCH ─────────────────────────────────────────────────────────────
async function searchWithTavily(query, tavilyKey, options = {}) {
    if (getTavilyRemaining() <= 0) throw new Error('Tavily quota exhausted');

    return withRetry(async () => {
        const response = await axios.post('https://api.tavily.com/search', {
            api_key:             tavilyKey,
            query,
            search_depth:        'advanced',
            max_results:         options.maxResults || 5,
            include_answer:      false,
            include_raw_content: false,
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 12000 });

        recordTavilyUsage();
        return (response.data?.results || []).map(r => ({
            title:   r.title   || '',
            url:     r.url     || '',
            snippet: r.content || '',
            date:    r.published_date || null,
        }));
    }, `Tavily:${query.slice(0, 40)}`) ?? [];
}

// ─── DISCOVERY LAYER (STEP 1) ──────────────────────────────────────────────────
// Scrapes multiple sources to find matching companies based on user criteria.
async function _runDiscovery(intentParams, tavilyKey, requestedCount) {
    console.log(`🔎 [DISCOVERY] Starting discovery for: ${intentParams.industry} in ${intentParams.location || 'Global'}`);    
    
    const industry = intentParams.industry || '';
    const location = intentParams.location ? `"${intentParams.location}"` : '';
    
    // Build precise search queries
    const queries = [
        `${industry} companies ${location}`,
        `${industry} businesses ${location}`,
        `top ${industry} firms ${location}`,
        `${industry} agencies ${location}`,
        `${industry} startups ${location}`,
    ].filter(q => q.trim().length > 5);

    const seenDomains = new Set();
    const candidates  = [];
    
    // Execute Search Queries
    const maxQueries = 6;
    const queriesToRun = queries.slice(0, maxQueries);
        console.log(`🔎 [DISCOVERY] Running ${queriesToRun.length} discovery queries...`);
    for (const query of queriesToRun) {
        if (candidates.length >= requestedCount * 3) break; 
        
        try {
            const results = await searchWithTavily(query, tavilyKey, { maxResults: 5 });
            
            for (const res of results) {
                let domain = '';
                try {
                    const urlObj = new URL(res.url);
                    domain = urlObj.hostname.replace('www.', '');
                } catch (e) { continue; }

                // Skip if we've already seen this domain (Duplicate Removal)
                if (seenDomains.has(domain)) continue;
                
                // Skip known non-company domains (Irrelevant Result Removal)
                const SKIP_DISCOVERY_DOMAINS = [
                    'linkedin.com', 'facebook.com', 'twitter.com', 'instagram.com',
                    'crunchbase.com', 'apollo.io', 'hunter.io', 'zoominfo.com',
                    'yelp.com', 'yellowpages.com', 'trustpilot.com', 'glassdoor.com',
                    'medium.com', 'reddit.com', 'quora.com', 'wikipedia.org',
                    'youtube.com', 'vimeo.com', 'tiktok.com', 'pinterest.com',
                    'github.com', 'gitlab.com', 'stackoverflow.com',
                    'indeed.com', 'monster.com', 'careerbuilder.com',
                    'amazon.com', 'ebay.com', 'etsy.com', 'shopify.com',
                    'wordpress.com', 'wix.com', 'squarespace.com',
                    'google.com', 'bing.com', 'yahoo.com',
                    'bbc.com', 'cnn.com', 'reuters.com', 'bloomberg.com',
                    'forbes.com', 'entrepreneur.com', 'inc.com', 'techcrunch.com',
                ];
                
                if (SKIP_DISCOVERY_DOMAINS.some(d => domain.includes(d))) continue;
                
                // Basic validation: must look like a company page
                if (LOW_VALUE_URL_PATTERNS.some(p => p.test(res.url))) continue;

                seenDomains.add(domain);
                candidates.push({
                    company: res.title || domain,
                    domain: domain,
                    source_url: res.url,
                    snippet: res.snippet || ''
                });
            }
        } catch (err) {
            console.warn(`⚠️ [DISCOVERY] Query failed: ${query} - ${err.message}`);
        }    }

    console.log(`✅ [DISCOVERY] Found ${candidates.length} raw candidates.`);    return candidates;
}

// ─── FILTERING LAYER (STEP 2) ──────────────────────────────────────────────────
// Identifies real businesses and removes irrelevant results.
async function _runFiltering(rawCandidates) {
    console.log(`🧹 [FILTERING] Starting filtering for ${rawCandidates.length} candidates...`);
    
    const filtered = [];
    const seenDomains = new Set();
    
    for (const candidate of rawCandidates) {
        const domain = candidate.domain.toLowerCase();        
        
        // 1. Duplicate Handling
        if (seenDomains.has(domain)) continue;
        
        // 2. Hard Filters (Domain Quality & Business Relevance)
        const isLowValueUrl = LOW_VALUE_URL_PATTERNS.some(p => p.test(candidate.source_url));
        const isLowValueTitle = LOW_VALUE_TITLE_SIGNALS.some(s => (candidate.company || '').toLowerCase().includes(s));
        
        if (isLowValueUrl || isLowValueTitle) {
            console.log(`🔴 [FILTERING] Hard reject (low value): ${candidate.company} (${domain})`);
            continue;
        }
        
        // 3. Content Signals (Relevance Scoring)
        const mockResult = {
            url: candidate.source_url,
            title: candidate.company,
            snippet: candidate.snippet
        };
        const relevanceScore = _scorePageBusinessRelevance(mockResult);
        
        // Threshold: Only keep candidates with moderate-to-high relevance
        if (relevanceScore < 40) {
            console.log(`🔴 [FILTERING] Soft reject (low score ${relevanceScore}): ${candidate.company} (${domain})`);
            continue;
        }
        
        seenDomains.add(domain);
        filtered.push({
            company: candidate.company,
            domain: domain,
            source_url: candidate.source_url,
            relevance_score: relevanceScore
        });    }
    
    console.log(`✅ [FILTERING] ${filtered.length} candidates passed filtering.`);
    return filtered;}

// ─── DECISION MAKER FINDER (STEP 3) ──────────────────────────────────────────
// For each company, find the specific person (CEO, Founder, etc.)
async function _findDecisionMakers(companies, jobTitle, tavilyKey) {
    console.log(`🕵️ [STEP 3] Finding ${jobTitle}s for ${companies.length} companies...`);
    
    const enrichedCompanies = [];
    
    // Process in batches to avoid rate limits
    for (const company of companies) {
        try {
            // Search specifically for the person
            const query = `"${company.company}" "${jobTitle}" email OR LinkedIn site:linkedin.com`;
            const results = await searchWithTavily(query, tavilyKey, { maxResults: 3 });
            
            let bestPerson = null;
            
            for (const res of results) {
                // Simple extraction logic (can be improved with AI parsing later)
                const snippet = res.snippet.toLowerCase();
                const title = res.title.toLowerCase();
                
                // Check if the result actually mentions the job title and company
                if ((snippet.includes(jobTitle.toLowerCase()) || title.includes(jobTitle.toLowerCase())) && 
                    snippet.includes(company.company.toLowerCase())) {
                    
                    // Try to extract a name (very basic heuristic)
                    // In a production app, you would use an LLM here to parse the name from the snippet
                    const nameMatch = res.title.match(/^([A-Z][a-z]+ [A-Z][a-z]+)/); 
                    const extractedName = nameMatch ? nameMatch[1] : `${jobTitle} at ${company.company}`;
                    
                    bestPerson = {
                        name: extractedName,
                        role: jobTitle,
                        source: res.url,
                        confidence: 0.8 // Default confidence for found matches
                    };
                    break; // Take the first good match
                }
            }
            
            enrichedCompanies.push({
                ...company,
                contact: bestPerson || { name: 'Unknown', role: jobTitle, confidence: 0.5 }
            });
            
        } catch (err) {
            console.warn(`⚠️ [STEP 3] Failed to find contact for ${company.company}: ${err.message}`);
            enrichedCompanies.push({                ...company,
                contact: { name: 'Unknown', role: jobTitle, confidence: 0.5 }
            });
        }
    }
    
    console.log(`✅ [STEP 3] Enriched ${enrichedCompanies.length} companies with contacts.`);
    return enrichedCompanies;
}

// ─── MAIN: generateFreeResponse (STEP 2 + STEP 3) ─────────────────────────────
// This function performs Step 2 (Search/Filter) AND Step 3 (Find People).
async function generateFreeResponse(message, history, userProfile, onProgress) {
    try {
        console.log('🟢 [AI ENGINE] Step 2 & 3 Pipeline started...');
        onProgress?.('🔍 Searching for companies...');

        const tavilyKey = process.env.TAVILY_API_KEY;
        if (!tavilyKey) throw new Error('Missing TAVILY_API_KEY');

        // Simple intent parsing for Step 2 (Industry/Location/Role)
        const intentParams = {
            industry: message, // Using the whole message as industry context for now
            location: 'Global',
            target_role: 'CEO' // Default, but should come from user input in future
        };

        // 1. Discovery (Scrapes multiple sources)
        const rawCandidates = await _runDiscovery(intentParams, tavilyKey, MAX_COMPANIES_RETURNED);
        
        if (rawCandidates.length === 0) {
            return {
                reply: 'No companies found matching your criteria.',
                updatedHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: 'No companies found.' }],
            };
        }

        onProgress?.('🧹 Filtering irrelevant results...');

        // 2. Filtering (Identifies real businesses, removes duplicates/irrelevant)
        const filteredCompanies = await _runFiltering(rawCandidates);

        if (filteredCompanies.length === 0) {
            return {
                reply: 'Found potential matches, but none passed our quality filters for real businesses.',
                updatedHistory: [...history, { role: 'user', content: message }, { role: 'assistant', content: 'No valid businesses found.' }],
            };
        }

        onProgress?.('🕵️ Finding Decision Makers...');
        // 3. Find Decision Makers (Step 3)
        // Use the jobTitle from intentParams (e.g., "CEO", "Founder")
        const targetRole = intentParams.target_role || 'CEO';
        const enrichedLeads = await _findDecisionMakers(filteredCompanies, targetRole, tavilyKey);

        // Format the output for the frontend
        const leadList = enrichedLeads.map(c => ({
            company: c.company,
            domain: c.domain,
            contactName: c.contact.name,
            contactRole: c.contact.role,
            confidence: c.contact.confidence
        }));

        const replyText = `I found ${leadList.length} companies and their ${targetRole}s:\n\n` + 
                          leadList.map(l => `• **${l.company}**: ${l.contactName} (${l.contactRole})`).join('\n');

        return {
            reply: replyText,
            leads: leadList, // Structured data for frontend display
            updatedHistory: [
                ...history,
                { role: 'user', content: message },
                { role: 'assistant', content: `[Found ${leadList.length} decision makers]` }
            ],
        };

    } catch (error) {
        console.error('❌ [AI ENGINE] Fatal error:', error.message);
        return { reply: 'An error occurred during search.', updatedHistory: history };
    }
}

module.exports = { generateFreeResponse };
