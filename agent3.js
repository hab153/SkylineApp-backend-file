'use strict';

const axios = require('axios');

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const TAVILY_KEYS = [];
for (let i = 1; i <= 8; i++) {
  const key = process.env[`TAVILY_API_KEY${i}`];
  if (key) {
    TAVILY_KEYS.push(key);
  }
}

const DEFAULT_KEYS = ['dummy_key_1', 'dummy_key_2', 'dummy_key_3'];
const TAVILY_API_KEYS = TAVILY_KEYS.length > 0 ? TAVILY_KEYS : DEFAULT_KEYS;

const MAX_RESULTS_PER_SEARCH = 10;
const MAX_SEARCHES_PER_HYPOTHESIS = 5;
const MAX_QUERIES_PER_HYPOTHESIS = 4;
const SEARCH_TIMEOUT_MS = 15000;
const MAX_CONCURRENT_SEARCHES = 5;
const MIN_CANDIDATES_PER_HYPOTHESIS = 20;
const MAX_CANDIDATES_TOTAL = 5000;

let currentKeyIndex = 0;
let keyUsageCount = {};
let keyResetDate = new Date();

TAVILY_API_KEYS.forEach((_, index) => {
  keyUsageCount[index] = 0;
});

// ────────────────────────────────────────────────────────────────
// ✅ FIX #70: Structured logger that ONLY emits a fixed event label
// plus sanitized numeric/boolean/null metadata.
// No free-form strings are ever passed to console.log.
// This prevents ANY tainted data (including TAVILY_API_KEYS values)
// from flowing into log output.
// ────────────────────────────────────────────────────────────────
function logInfo(event, meta) {
  if (!meta || typeof meta !== 'object') {
    console.log('[Stage3]', event);
    return;
  }
  // Only allow number, boolean, null values in metadata
  const safe = {};
  for (const k of Object.keys(meta)) {
    const v = meta[k];
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      safe[k] = v;
    }
  }
  console.log('[Stage3]', event, JSON.stringify(safe));
}

// ────────────────────────────────────────────────────────────────
// 2. Utility: Retry helper
// ────────────────────────────────────────────────────────────────

async function withRetry(fn, retries = 2, delayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
        logInfo('non_retryable_error', { status: err.response.status });
        return null;
      }
      logInfo('retry_attempt', { attempt: attempt + 1, givingUp: isLast });
      if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 3. Tavily API Key Rotation
// ────────────────────────────────────────────────────────────────

function getNextTavilyKey() {
  const now = new Date();
  const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());

  if (keyResetDate < monthAgo) {
    logInfo('new_month_reset');
    TAVILY_API_KEYS.forEach((_, index) => {
      keyUsageCount[index] = 0;
    });
    keyResetDate = now;
    currentKeyIndex = 0;
  }

  const maxSearchesPerKey = 1000;
  const totalKeys = TAVILY_API_KEYS.length;

  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const index = (currentKeyIndex + attempt) % totalKeys;
    if (keyUsageCount[index] < maxSearchesPerKey) {
      currentKeyIndex = index;
      keyUsageCount[index] = (keyUsageCount[index] || 0) + 1;
      logInfo('key_selected', { keyIndex: index + 1, totalKeys: totalKeys, usage: keyUsageCount[index], limit: maxSearchesPerKey });
      return TAVILY_API_KEYS[index];
    }
  }

  logInfo('all_keys_exhausted_reset');
  TAVILY_API_KEYS.forEach((_, index) => {
    keyUsageCount[index] = 0;
  });
  currentKeyIndex = 0;
  keyUsageCount[0] = 1;
  logInfo('key_selected', { keyIndex: 1, totalKeys: totalKeys, usage: 1, limit: maxSearchesPerKey });
  return TAVILY_API_KEYS[0];
}

function getTavilyUsageStats() {
  const stats = {};
  TAVILY_API_KEYS.forEach((_, index) => {
    stats['key' + (index + 1)] = {
      used: keyUsageCount[index] || 0,
      remaining: Math.max(0, 1000 - (keyUsageCount[index] || 0))
    };
  });
  return stats;
}

// ────────────────────────────────────────────────────────────────
// 4. Tavily Search Helper with Key Rotation
// ────────────────────────────────────────────────────────────────

async function searchTavily(query, maxResults = MAX_RESULTS_PER_SEARCH) {
  if (TAVILY_API_KEYS.length === 0 || TAVILY_API_KEYS[0] === 'dummy_key_1') {
    logInfo('mock_mode', { reason: 1 });
    return generateMockResults(query, maxResults);
  }

  const apiKey = getNextTavilyKey();

  if (!apiKey) {
    logInfo('no_key_available');
    return [];
  }

  try {
    const response = await withRetry(() => axios.post(
      'https://api.tavily.com/search',
      {
        api_key: apiKey,
        query: query,
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: SEARCH_TIMEOUT_MS
      }
    ));

    if (!response) return [];

    return (response.data?.results || []).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content || '',
      date: r.published_date || null,
      source: 'tavily'
    }));

  } catch (error) {
    logInfo('search_failed', { hasMessage: !!error.message });
    return [];
  }
}

// ────────────────────────────────────────────────────────────────
// 5. Mock Search Results
// ────────────────────────────────────────────────────────────────

function generateMockResults(query, maxResults) {
  const mockCompanies = [
    { title: 'ABC Healthcare GmbH', url: 'https://abchealthcare.de', snippet: 'Leading healthcare provider in Germany.' },
    { title: 'Deutsche Bank AG', url: 'https://deutsche-bank.de', snippet: 'One of Germany\'s largest financial institutions.' },
    { title: 'SAP SE', url: 'https://sap.com', snippet: 'Global enterprise software company.' },
    { title: 'Siemens Healthineers', url: 'https://siemens-healthineers.com', snippet: 'Medical technology company.' },
    { title: 'Klarna', url: 'https://klarna.com', snippet: 'Fintech company providing buy now pay later services.' },
    { title: 'Helios Kliniken', url: 'https://helios-gesundheit.de', snippet: 'One of Europe\'s largest hospital operators.' },
    { title: 'Commerzbank', url: 'https://commerzbank.de', snippet: 'Major German bank.' },
    { title: 'Zalando', url: 'https://zalando.de', snippet: 'Europe\'s leading online fashion platform.' },
    { title: 'Delivery Hero', url: 'https://deliveryhero.com', snippet: 'Global food delivery platform.' },
    { title: 'N26', url: 'https://n26.com', snippet: 'Digital bank offering mobile banking services.' },
    { title: 'Axa Germany', url: 'https://axa.de', snippet: 'Major insurance company.' },
    { title: 'DHL Group', url: 'https://dhl.com', snippet: 'Global logistics provider.' },
    { title: 'E.ON', url: 'https://eon.com', snippet: 'Energy company with renewable energy investments.' },
    { title: 'Deutsche Telekom', url: 'https://telekom.de', snippet: 'Major telecommunications provider.' },
    { title: 'Bayer AG', url: 'https://bayer.com', snippet: 'Pharmaceutical and life sciences company.' },
  ];

  const keywords = query.toLowerCase().split(' ').filter(w => w.length > 3);
  const filtered = mockCompanies.filter(c => {
    const text = (c.title + ' ' + c.snippet).toLowerCase();
    return keywords.some(k => text.includes(k)) || keywords.length === 0;
  });

  return filtered.slice(0, maxResults);
}

// ────────────────────────────────────────────────────────────────
// 6. Query Expansion
// ────────────────────────────────────────────────────────────────

function expandQuery(industry, location, service, targetType) {
  const queries = [];
  const country = location || 'Germany';

  const baseQueries = [
    industry + ' companies ' + country,
    industry + ' businesses ' + country,
    industry + ' startups ' + country,
    'top ' + industry + ' companies ' + country,
    'leading ' + industry + ' firms ' + country,
  ];

  if (location) {
    baseQueries.push(industry + ' companies in ' + location);
    baseQueries.push(industry + ' ' + location + ' list');
    baseQueries.push(industry + ' ' + location + ' directory');
  }

  if (service) {
    baseQueries.push(industry + ' companies using ' + service);
    baseQueries.push(industry + ' ' + service + ' solutions ' + country);
    baseQueries.push(industry + ' ' + service + ' providers ' + country);
  }

  if (targetType === 'Startups') {
    baseQueries.push(industry + ' startups ' + country);
    baseQueries.push(industry + ' early stage ' + country);
  } else if (targetType === 'SME') {
    baseQueries.push(industry + ' SMEs ' + country);
    baseQueries.push(industry + ' mid-size companies ' + country);
  } else if (targetType === 'Enterprise') {
    baseQueries.push(industry + ' enterprises ' + country);
    baseQueries.push(industry + ' large companies ' + country);
  }

  baseQueries.push(industry + ' ' + country + ' about us team');
  baseQueries.push(industry + ' ' + country + ' contact us');

  return [...new Set(baseQueries)].slice(0, MAX_QUERIES_PER_HYPOTHESIS);
}

// ────────────────────────────────────────────────────────────────
// 7. Execute a Single Hypothesis Search
// ────────────────────────────────────────────────────────────────

async function executeHypothesisSearch(hypothesis, searchPackage, onProgress) {
  const { industry, confidence } = hypothesis;
  const location = searchPackage.countries?.[0] || 'Global';
  const service = searchPackage.service_needed || null;
  const targetType = searchPackage.target_type || 'Companies';

  logInfo('hypothesis_start', { confidence: confidence });
  onProgress?.('Searching...');

  const queries = expandQuery(industry, location, service, targetType);
  logInfo('queries_generated', { count: queries.length });

  const searchPromises = queries.map(query => searchTavily(query, MAX_RESULTS_PER_SEARCH));
  const results = await Promise.all(searchPromises);

  let allResults = [];
  results.forEach((result, index) => {
    if (result && result.length > 0) {
      const query = queries[index] || 'unknown';
      allResults = allResults.concat(
        result.map(r => ({
          ...r,
          query: query,
          industry: industry,
          hypothesis_confidence: confidence
        }))
      );
    }
  });

  const seenUrls = new Set();
  const uniqueResults = allResults.filter(r => {
    if (seenUrls.has(r.url)) return false;
    seenUrls.add(r.url);
    return true;
  });

  logInfo('hypothesis_complete', { uniqueResults: uniqueResults.length, queriesUsed: queries.length });

  return {
    hypothesis: industry,
    confidence: confidence,
    queries_used: queries,
    results: uniqueResults,
    total_found: uniqueResults.length
  };
}

// ────────────────────────────────────────────────────────────────
// 8. Extract Companies from Search Results
// ────────────────────────────────────────────────────────────────

function extractCompaniesFromResults(searchResults, source) {
  if (!searchResults || searchResults.length === 0) return [];

  const companies = [];
  const seenDomains = new Set();

  for (const result of searchResults) {
    let domain = null;
    try {
      const urlObj = new URL(result.url);
      domain = urlObj.hostname.replace('www.', '');
    } catch {
      // Skip invalid URLs
    }

    if (!domain) continue;

    const skipDomains = ['youtube.com', 'twitter.com', 'linkedin.com', 'facebook.com',
                        'instagram.com', 'reddit.com', 'medium.com', 'wikipedia.org',
                        'getprospect.com', 'apollo.io', 'zoominfo.com', 'crunchbase.com',
                        'github.com', 'glassdoor.com', 'indeed.com', 'xing.com', 'personio.de'];
    if (skipDomains.some(skip => domain.includes(skip))) continue;

    if (seenDomains.has(domain)) continue;
    seenDomains.add(domain);

    let name = result.title || domain;
    name = name
      .replace(/\s*[|\-–].*$/, '')
      .replace(/\s*•\s*.*$/, '')
      .replace(/\b(Ltd|LLC|Inc|Limited|PLC|Corp|Corporation|GmbH|AG)\b/gi, '')
      .trim();

    if (name.length < 2) name = domain.split('.')[0];

    companies.push({
      name: name,
      domain: domain,
      website: result.url,
      source: source || 'tavily',
      source_url: result.url,
      snippet: result.snippet || '',
      industry: result.industry || null,
      hypothesis_confidence: result.hypothesis_confidence || 0.5,
      query: result.query || null,
      date: result.date || null,
      raw_title: result.title || null
    });
  }

  return companies;
}

// ────────────────────────────────────────────────────────────────
// 9. Main Stage 3 Function
// ────────────────────────────────────────────────────────────────

async function multiSourceSearch({
  hypotheses,
  searchPackage,
  userId = 'anonymous',
  onProgress = null,
  sources = ['tavily']
}) {
  logInfo('search_start', { hypothesisCount: hypotheses.length });
  onProgress?.('Searching multiple sources...');

  if (!hypotheses || hypotheses.length === 0) {
    return {
      success: false,
      error: 'No hypotheses provided to Stage 3',
      candidates: [],
      stats: { searched: 0, found: 0, returned: 0, hypotheses: 0 }
    };
  }

  const startTime = Date.now();
  let allResults = [];
  let hypothesisResults = [];
  let totalSearches = 0;

  const sortedHypotheses = [...hypotheses].sort((a, b) => b.confidence - a.confidence);

  const chunks = [];
  for (let i = 0; i < sortedHypotheses.length; i += MAX_CONCURRENT_SEARCHES) {
    chunks.push(sortedHypotheses.slice(i, i + MAX_CONCURRENT_SEARCHES));
  }

  for (const chunk of chunks) {
    const chunkPromises = chunk.map(h =>
      executeHypothesisSearch(h, searchPackage, onProgress)
    );
    const chunkResults = await Promise.all(chunkPromises);
    chunkResults.forEach(r => {
      if (r && r.results) {
        hypothesisResults.push(r);
        allResults = allResults.concat(r.results);
        totalSearches += r.queries_used?.length || 0;
      }
    });
  }

  logInfo('raw_results_collected', { count: allResults.length, hypotheses: hypothesisResults.length });
  onProgress?.('Extracting companies...');

  let allCompanies = [];
  for (const source of sources) {
    const companies = extractCompaniesFromResults(allResults, source);
    allCompanies = allCompanies.concat(companies);
  }

  const limit = Math.min(searchPackage.requested_results * 3 || 500, MAX_CANDIDATES_TOTAL);
  const limitedCompanies = allCompanies.slice(0, limit);

  const endTime = Date.now();
  const duration = endTime - startTime;

  const stats = {
    searched: totalSearches,
    found: allResults.length,
    returned: limitedCompanies.length,
    hypotheses: hypothesisResults.length,
    duration_ms: duration,
    sources: sources,
    tavily_usage: getTavilyUsageStats()
  };

  logInfo('search_complete', { candidates: limitedCompanies.length, durationMs: duration, searches: totalSearches });

  return {
    success: true,
    candidates: limitedCompanies,
    hypothesis_results: hypothesisResults,
    stats: stats,
    userId: userId,
    search_package: searchPackage
  };
}

// ────────────────────────────────────────────────────────────────
// 10. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
  multiSourceSearch,
  searchTavily,
  getNextTavilyKey,
  getTavilyUsageStats,
  expandQuery,
  executeHypothesisSearch,
  extractCompaniesFromResults,
  generateMockResults,
  MAX_RESULTS_PER_SEARCH,
  MAX_QUERIES_PER_HYPOTHESIS,
  MAX_CONCURRENT_SEARCHES,
  MAX_CANDIDATES_TOTAL
};
