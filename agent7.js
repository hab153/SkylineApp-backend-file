'use strict';

/**
 * agent7.js – Stage 7: Skyline Ranking & Recommendation Engine
 * 
 * The recommendation engine of Skyline's Lead Intelligence System.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Receive scored companies from Stage 6.
 * 2. Compare all companies against each other (not just individually).
 * 3. Apply multi-factor ranking (confidence, data completeness, activity, freshness, etc.)
 * 4. Apply tie-breaking rules for companies with similar scores.
 * 5. Diversify results to avoid repetitive recommendations.
 * 6. Assign final ranking positions.
 * 7. Provide explainable ranking reasons.
 * 8. Return ordered recommendations for Stage 8 (Save).
 * 
 * SKYLINE PHILOSOPHY:
 * Stage 6 asks: "How good is this individual company?"
 * Stage 7 asks: "Out of every company we found, which ones should appear first?"
 * 
 * YOU MUST NOT:
 * - Score companies (Stage 6 handles this).
 * - Save results (Stage 8 handles this).
 * - Learn from outcomes (Stage 9 handles this).
 * - Enrich companies (Stage 5 handles this).
 */

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const DEFAULT_RESULTS_LIMIT = 300;
const MAX_RESULTS_LIMIT = 1000;
const MIN_RESULTS_LIMIT = 10;

// Ranking factor weights (proprietary - Skyline's IP)
const RANKING_WEIGHTS = {
  confidence_score: 0.35,        // Stage 6 confidence score
  data_completeness: 0.15,       // How complete is the profile?
  business_activity: 0.12,       // Hiring, funding, expansion
  data_freshness: 0.10,          // How recent is the information?
  industry_match: 0.08,          // Industry relevance
  location_match: 0.07,          // Geographic relevance
  hiring_intensity: 0.06,        // Number of open positions
  tech_relevance: 0.04,          // Technology stack match
  digital_presence: 0.03         // Website, LinkedIn, etc.
};

// Tie-breaker weights (applied when scores are close)
const TIE_BREAKER_WEIGHTS = {
  data_freshness: 0.30,
  hiring_intensity: 0.25,
  data_completeness: 0.20,
  business_activity: 0.15,
  digital_presence: 0.10
};

// Confidence bands for categorization
const CONFIDENCE_BANDS = [
  { min: 0.95, max: 1.00, label: 'Outstanding Opportunity', emoji: '🏆' },
  { min: 0.90, max: 0.95, label: 'Excellent Opportunity', emoji: '⭐' },
  { min: 0.85, max: 0.90, label: 'Strong Opportunity', emoji: '✅' },
  { min: 0.75, max: 0.85, label: 'Good Opportunity', emoji: '👍' },
  { min: 0.60, max: 0.75, label: 'Moderate Opportunity', emoji: '📊' },
  { min: 0.00, max: 0.60, label: 'Consider with Caution', emoji: '⚠️' }
];

// ────────────────────────────────────────────────────────────────
// 2. Data Completeness Scoring
// ────────────────────────────────────────────────────────────────

function calculateDataCompleteness(company) {
  let score = 0;
  let totalFields = 0;
  const fields = [
    { key: 'name', weight: 0.10 },
    { key: 'company', weight: 0.10 },
    { key: 'domain', weight: 0.15 },
    { key: 'website', weight: 0.10 },
    { key: 'location', weight: 0.10 },
    { key: 'industry', weight: 0.10 },
    { key: 'description', weight: 0.10 },
    { key: 'employees', weight: 0.10 },
    { key: 'tech_stack', weight: 0.08 },
    { key: 'linkedin', weight: 0.07 }
  ];

  for (const field of fields) {
    totalFields += field.weight;
    const value = company[field.key];
    if (value !== undefined && value !== null && value !== '' && 
        !(Array.isArray(value) && value.length === 0)) {
      score += field.weight;
    }
  }

  // Bonus for having multiple signals
  const signals = company.signals || company.score?.signals || {};
  const signalCount = Object.values(signals).filter(s => s && s.score > 0.5).length;
  if (signalCount >= 5) score += 0.10;
  else if (signalCount >= 3) score += 0.05;

  return Math.min(score, 1.0);
}

// ────────────────────────────────────────────────────────────────
// 3. Business Activity Scoring
// ────────────────────────────────────────────────────────────────

function calculateBusinessActivity(company) {
  let score = 0.20; // Base activity score
  
  // Hiring activity
  if (company.hiring) {
    const hiringCount = typeof company.hiring === 'number' ? company.hiring : 1;
    if (hiringCount >= 20) score += 0.30;
    else if (hiringCount >= 10) score += 0.25;
    else if (hiringCount >= 5) score += 0.20;
    else if (hiringCount >= 1) score += 0.10;
  }

  // Growth signals from description
  if (company.description) {
    const desc = company.description.toLowerCase();
    if (desc.includes('funding') || desc.includes('investment') || desc.includes('raised')) {
      score += 0.15;
    }
    if (desc.includes('expand') || desc.includes('expansion') || desc.includes('new office')) {
      score += 0.12;
    }
    if (desc.includes('growing') || desc.includes('growth') || desc.includes('scale')) {
      score += 0.10;
    }
    if (desc.includes('launch') || desc.includes('new product')) {
      score += 0.08;
    }
  }

  // Hiring from signals
  const signals = company.signals || company.score?.signals || {};
  if (signals.hiring_activity && signals.hiring_activity.score > 0.7) {
    score += 0.10;
  }
  if (signals.growth_signals && signals.growth_signals.score > 0.7) {
    score += 0.10;
  }

  return Math.min(score, 1.0);
}

// ────────────────────────────────────────────────────────────────
// 4. Data Freshness Scoring
// ────────────────────────────────────────────────────────────────

function calculateDataFreshness(company) {
  let score = 0.50; // Default middle score
  
  // Check if we have a scored_at timestamp
  if (company.scored_at) {
    const scoredDate = new Date(company.scored_at);
    const daysAgo = (Date.now() - scoredDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo < 1) score = 0.95;
    else if (daysAgo < 7) score = 0.85;
    else if (daysAgo < 30) score = 0.70;
    else if (daysAgo < 90) score = 0.50;
    else score = 0.30;
  }

  // Check if we have any date from sources
  if (company.metadata && company.metadata.date) {
    const sourceDate = new Date(company.metadata.date);
    const daysAgo = (Date.now() - sourceDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo < 7) score += 0.10;
    else if (daysAgo < 30) score += 0.05;
  }

  return Math.min(score, 1.0);
}

// ────────────────────────────────────────────────────────────────
// 5. Hiring Intensity Scoring
// ────────────────────────────────────────────────────────────────

function calculateHiringIntensity(company) {
  if (!company.hiring) return 0.20;
  
  const hiringCount = typeof company.hiring === 'number' ? company.hiring : 1;
  if (hiringCount >= 50) return 0.95;
  if (hiringCount >= 30) return 0.90;
  if (hiringCount >= 20) return 0.85;
  if (hiringCount >= 10) return 0.75;
  if (hiringCount >= 5) return 0.60;
  if (hiringCount >= 1) return 0.40;
  return 0.20;
}

// ────────────────────────────────────────────────────────────────
// 6. Tech Relevance Scoring
// ────────────────────────────────────────────────────────────────

function calculateTechRelevance(company, searchPackage) {
  const service = searchPackage?.service_needed || '';
  if (!service || !company.tech_stack || company.tech_stack.length === 0) {
    return 0.30;
  }

  const relevantTechs = ['AWS', 'Azure', 'GCP', 'Cloud', 'Kubernetes', 'Docker', 'Security', 'AI', 'ML', 'Analytics'];
  const matchingTechs = company.tech_stack.filter(tech =>
    relevantTechs.some(r => tech.toLowerCase().includes(r.toLowerCase()))
  );

  const matchRatio = matchingTechs.length / company.tech_stack.length;
  if (matchRatio > 0.5) return 0.90;
  if (matchRatio > 0.3) return 0.70;
  if (matchRatio > 0.1) return 0.50;
  return 0.30;
}

// ────────────────────────────────────────────────────────────────
// 7. Digital Presence Scoring
// ────────────────────────────────────────────────────────────────

function calculateDigitalPresence(company) {
  let score = 0.20;

  if (company.website) score += 0.25;
  if (company.linkedin) score += 0.20;
  if (company.description && company.description.length > 100) score += 0.15;
  if (company.tech_stack && company.tech_stack.length > 0) score += 0.10;
  if (company.domain) score += 0.10;

  return Math.min(score, 1.0);
}

// ────────────────────────────────────────────────────────────────
// 8. Calculate Final Ranking Score
// ────────────────────────────────────────────────────────────────

function calculateRankingScore(company, searchPackage) {
  const baseConfidence = company.score?.overall || company.confidence || 0.30;

  // Calculate all factors
  const factors = {
    confidence_score: baseConfidence,
    data_completeness: calculateDataCompleteness(company),
    business_activity: calculateBusinessActivity(company),
    data_freshness: calculateDataFreshness(company),
    industry_match: company.score?.signals?.industry_match?.score || 0.30,
    location_match: company.score?.signals?.location_match?.score || 0.30,
    hiring_intensity: calculateHiringIntensity(company),
    tech_relevance: calculateTechRelevance(company, searchPackage),
    digital_presence: calculateDigitalPresence(company)
  };

  // Calculate weighted score
  let totalScore = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(RANKING_WEIGHTS)) {
    if (factors[key] !== undefined) {
      totalScore += factors[key] * weight;
      totalWeight += weight;
    }
  }

  const weightedScore = totalWeight > 0 ? totalScore / totalWeight : baseConfidence;

  return {
    score: Math.min(Math.max(weightedScore, 0.05), 0.98),
    factors: factors,
    raw_score: weightedScore
  };
}

// ────────────────────────────────────────────────────────────────
// 9. Tie Breaking
// ────────────────────────────────────────────────────────────────

function applyTieBreaker(companyA, companyB) {
  let scoreA = 0;
  let scoreB = 0;

  // Calculate tie-breaker scores
  const tieFactors = ['data_freshness', 'hiring_intensity', 'data_completeness', 'business_activity', 'digital_presence'];

  for (const factor of tieFactors) {
    const weight = TIE_BREAKER_WEIGHTS[factor] || 0.10;
    let valueA = 0.30;
    let valueB = 0.30;

    switch (factor) {
      case 'data_freshness':
        valueA = calculateDataFreshness(companyA);
        valueB = calculateDataFreshness(companyB);
        break;
      case 'hiring_intensity':
        valueA = calculateHiringIntensity(companyA);
        valueB = calculateHiringIntensity(companyB);
        break;
      case 'data_completeness':
        valueA = calculateDataCompleteness(companyA);
        valueB = calculateDataCompleteness(companyB);
        break;
      case 'business_activity':
        valueA = calculateBusinessActivity(companyA);
        valueB = calculateBusinessActivity(companyB);
        break;
      case 'digital_presence':
        valueA = calculateDigitalPresence(companyA);
        valueB = calculateDigitalPresence(companyB);
        break;
    }

    scoreA += valueA * weight;
    scoreB += valueB * weight;
  }

  return { scoreA, scoreB };
}

// ────────────────────────────────────────────────────────────────
// 10. Get Confidence Band
// ────────────────────────────────────────────────────────────────

function getConfidenceBand(score) {
  for (const band of CONFIDENCE_BANDS) {
    if (score >= band.min && score < band.max) {
      return band;
    }
  }
  return CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1];
}

// ────────────────────────────────────────────────────────────────
// 11. Generate Ranking Explanation
// ────────────────────────────────────────────────────────────────

function generateRankingExplanation(company, rankingScore, rank, total) {
  const band = getConfidenceBand(rankingScore.score);
  const factors = rankingScore.factors;

  const explanations = [];

  // Overall quality
  explanations.push(`${band.emoji} Rank #${rank} of ${total} — ${band.label}`);

  // Top contributing factors
  const sortedFactors = Object.entries(factors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  for (const [key, value] of sortedFactors) {
    if (value > 0.7) {
      const labels = {
        confidence_score: 'Strong confidence',
        data_completeness: 'Rich data profile',
        business_activity: 'Active business signals',
        data_freshness: 'Fresh information',
        industry_match: 'Strong industry match',
        location_match: 'Strong location match',
        hiring_intensity: 'Strong hiring activity',
        tech_relevance: 'Relevant technology stack',
        digital_presence: 'Strong digital presence'
      };
      explanations.push(`✓ ${labels[key] || key}: ${Math.round(value * 100)}%`);
    }
  }

  // Add note if there are areas for improvement
  const lowFactors = Object.entries(factors)
    .filter(([key, value]) => value < 0.4 && key !== 'confidence_score')
    .slice(0, 2);

  if (lowFactors.length > 0) {
    const labels = {
      data_completeness: 'Data profile could be richer',
      business_activity: 'Limited business activity detected',
      hiring_intensity: 'Limited hiring activity',
      tech_relevance: 'Technology stack information limited',
      digital_presence: 'Digital presence could be stronger'
    };
    for (const [key, value] of lowFactors) {
      explanations.push(`ℹ️ ${labels[key] || key}: ${Math.round(value * 100)}%`);
    }
  }

  return explanations;
}

// ────────────────────────────────────────────────────────────────
// 12. Main Stage 7 Function: Ranking
// ────────────────────────────────────────────────────────────────

function rankCompanies({
  companies,
  searchPackage,
  userId = 'anonymous',
  onProgress = null,
  limit = DEFAULT_RESULTS_LIMIT,
  diversify = true
}) {
  console.log(`🏆 [Stage7] Starting ranking for user ${userId}...`);
  console.log(`📊 [Stage7] Received ${companies?.length || 0} companies from Stage 6`);
  onProgress?.('🏆 Ranking companies...');

  // ─── Validate input ───
  if (!companies || companies.length === 0) {
    return {
      success: false,
      error: 'No companies provided to Stage 7',
      ranked_companies: [],
      stats: {
        total_input: 0,
        ranked: 0,
        returned: 0
      }
    };
  }

  // ─── Calculate ranking scores for each company ───
  const withRanking = companies.map((company, index) => {
    const rankingScore = calculateRankingScore(company, searchPackage);
    return {
      ...company,
      ranking: rankingScore
    };
  });

  // ─── Sort by ranking score ───
  const sorted = withRanking.sort((a, b) => {
    const diff = b.ranking.score - a.ranking.score;
    if (Math.abs(diff) < 0.01) {
      // Apply tie-breaker for very close scores
      const tieResult = applyTieBreaker(a, b);
      return tieResult.scoreB - tieResult.scoreA;
    }
    return diff;
  });

  // ─── Apply diversity (optional) ───
  let ranked = sorted;
  if (diversify) {
    ranked = applyDiversity(sorted, limit);
  }

  // ─── Limit results ───
  const resultLimit = Math.min(Math.max(limit, MIN_RESULTS_LIMIT), MAX_RESULTS_LIMIT);
  const finalRanked = ranked.slice(0, resultLimit);

  // ─── Assign final ranks and explanations ───
  const withRanks = finalRanked.map((company, index) => {
    const rank = index + 1;
    const band = getConfidenceBand(company.ranking.score);
    const explanations = generateRankingExplanation(company, company.ranking, rank, finalRanked.length);

    return {
      ...company,
      rank: rank,
      rank_label: band.label,
      rank_emoji: band.emoji,
      rank_explanations: explanations,
      score_components: company.ranking.factors
    };
  });

  // ─── Calculate stats ───
  const stats = {
    total_input: companies.length,
    ranked: withRanking.length,
    returned: withRanks.length,
    confidence_distribution: {
      outstanding: withRanks.filter(c => c.ranking.score >= 0.95).length,
      excellent: withRanks.filter(c => c.ranking.score >= 0.90 && c.ranking.score < 0.95).length,
      strong: withRanks.filter(c => c.ranking.score >= 0.85 && c.ranking.score < 0.90).length,
      good: withRanks.filter(c => c.ranking.score >= 0.75 && c.ranking.score < 0.85).length,
      moderate: withRanks.filter(c => c.ranking.score >= 0.60 && c.ranking.score < 0.75).length,
      caution: withRanks.filter(c => c.ranking.score < 0.60).length
    },
    average_score: withRanks.reduce((sum, c) => sum + c.ranking.score, 0) / (withRanks.length || 1),
    top_score: withRanks.length > 0 ? withRanks[0].ranking.score : 0
  };

  console.log(`✅ [Stage7] Ranking complete: ${withRanks.length} companies returned`);
  console.log(`📊 [Stage7] Top score: ${(stats.top_score * 100).toFixed(1)}%`);
  console.log(`📊 [Stage7] Average score: ${(stats.average_score * 100).toFixed(1)}%`);

  return {
    success: true,
    companies: withRanks,
    stats: stats,
    userId: userId,
    search_package: searchPackage,
    timestamp: new Date().toISOString()
  };
}

// ────────────────────────────────────────────────────────────────
// 13. Apply Diversity to Rankings
// ────────────────────────────────────────────────────────────────

function applyDiversity(sortedCompanies, limit) {
  if (sortedCompanies.length <= limit) return sortedCompanies;

  const result = [];
  const industries = new Map();
  const remaining = [...sortedCompanies];
  const targetIndustries = 5; // Try to get at least 5 different industries

  // First pass: get top companies from different industries
  let attempts = 0;
  while (result.length < Math.min(limit, targetIndustries * 2) && remaining.length > 0 && attempts < 100) {
    attempts++;
    const company = remaining.shift();
    const industry = company.industry || 'Unknown';

    if (!industries.has(industry)) {
      industries.set(industry, 0);
    }

    const count = industries.get(industry);
    if (count < 3) { // Allow up to 3 from same industry
      industries.set(industry, count + 1);
      result.push(company);
    } else {
      // Put it back at the end for later
      remaining.push(company);
    }
  }

  // Second pass: add remaining companies to fill the limit
  while (result.length < limit && remaining.length > 0) {
    const company = remaining.shift();
    const industry = company.industry || 'Unknown';
    if (!industries.has(industry)) {
      industries.set(industry, 0);
    }
    const count = industries.get(industry);
    // Allow more from same industry if we need to fill
    if (count < 5) {
      industries.set(industry, count + 1);
      result.push(company);
    } else {
      // Skip this one and try next
      remaining.push(company);
    }
  }

  // If we still don't have enough, just take from the front
  while (result.length < limit && sortedCompanies.length > result.length) {
    result.push(sortedCompanies[result.length]);
  }

  return result;
}

// ────────────────────────────────────────────────────────────────
// 14. Helper: Get Ranking Statistics
// ────────────────────────────────────────────────────────────────

function getRankingStats(companies) {
  if (!companies || companies.length === 0) {
    return {
      total: 0,
      average_rank_score: 0,
      top_score: 0,
      bottom_score: 0,
      confidence_bands: {}
    };
  }

  const scores = companies.map(c => c.ranking?.score || 0);
  const bands = {};

  for (const company of companies) {
    const band = getConfidenceBand(company.ranking?.score || 0);
    bands[band.label] = (bands[band.label] || 0) + 1;
  }

  return {
    total: companies.length,
    average_rank_score: scores.reduce((a, b) => a + b, 0) / scores.length,
    top_score: Math.max(...scores),
    bottom_score: Math.min(...scores),
    confidence_bands: bands
  };
}

// ────────────────────────────────────────────────────────────────
// 15. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
  rankCompanies,
  calculateRankingScore,
  calculateDataCompleteness,
  calculateBusinessActivity,
  calculateDataFreshness,
  calculateHiringIntensity,
  calculateTechRelevance,
  calculateDigitalPresence,
  applyTieBreaker,
  getConfidenceBand,
  generateRankingExplanation,
  applyDiversity,
  getRankingStats,
  RANKING_WEIGHTS,
  TIE_BREAKER_WEIGHTS,
  CONFIDENCE_BANDS,
  DEFAULT_RESULTS_LIMIT,
  MAX_RESULTS_LIMIT,
  MIN_RESULTS_LIMIT
};
