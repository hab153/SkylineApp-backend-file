'use strict';

/**
 * agent6.js – Stage 6: Skyline Intelligence Engine
 * 
 * The decision-making engine of Skyline's Lead Intelligence System.
 * 
 * PRIMARY RESPONSIBILITIES:
 * 1. Receive enriched company profiles from Stage 5.
 * 2. For each company, analyze observable signals against user requirements.
 * 3. Assign confidence scores based on evidence, not facts.
 * 4. Provide explainable reasoning for every score.
 * 5. Combine multiple signals into one overall assessment.
 * 6. Return scored companies for Stage 7 (Ranking).
 * 
 * SKYLINE PHILOSOPHY:
 * The confidence score is NOT a statement of fact.
 * Skyline is NOT claiming: "This company definitely needs X."
 * Instead: "Based on observed evidence, this company appears to be a strong prospect."
 * 
 * YOU MUST NOT:
 * - Make absolute claims ("will buy", "definitely needs").
 * - Invent evidence that isn't observable.
 * - Score without explaining reasoning.
 * - Rank companies (Stage 7 handles this).
 * - Save results (Stage 8 handles this).
 * - Learn from outcomes (Stage 9 handles this).
 */

// ────────────────────────────────────────────────────────────────
// 1. Configuration
// ────────────────────────────────────────────────────────────────

const SCORING_MODEL = 'gpt-4o-mini';
const MAX_OUTPUT_TOKENS = 800;
const MAX_COMPANIES_TO_SCORE = 500;
const MAX_CONCURRENT_SCORES = 5;
const MIN_CONFIDENCE_SCORE = 0.05;
const MAX_CONFIDENCE_SCORE = 0.98;
const DEFAULT_CONFIDENCE = 0.30;

// ────────────────────────────────────────────────────────────────
// 2. Signal Weights (Proprietary - Skyline's IP)
// ────────────────────────────────────────────────────────────────

/**
 * These weights represent Skyline's assessment of how important
 * each signal is for evaluating business opportunities.
 * 
 * These can be adjusted over time as Skyline learns from real outcomes.
 * This is where Skyline's competitive advantage lives.
 */
const SIGNAL_WEIGHTS = {
  // Industry match is critical
  industry_match: 0.25,
  
  // Location/geographic match is important
  location_match: 0.15,
  
  // Hiring signals indicate investment and growth
  hiring_activity: 0.15,
  
  // Technology stack indicates digital maturity
  tech_relevance: 0.12,
  
  // Company size indicates organizational complexity
  size_match: 0.10,
  
  // Growth signals (funding, expansion) indicate momentum
  growth_signals: 0.10,
  
  // Digital presence indicates active business
  digital_presence: 0.08,
  
  // Description relevance provides context
  description_relevance: 0.05
};

// ────────────────────────────────────────────────────────────────
// 3. Industry Relevance Scoring
// ────────────────────────────────────────────────────────────────

/**
 * Maps industries to relevance for different services.
 * This is Skyline's business knowledge base.
 * These are estimates based on observable business patterns.
 */
const INDUSTRY_RELEVANCE = {
  'cybersecurity': {
    'Healthcare': 0.95,
    'Banking': 0.94,
    'Fintech': 0.92,
    'Insurance': 0.88,
    'Government': 0.87,
    'Energy': 0.85,
    'Telecommunications': 0.84,
    'SaaS': 0.82,
    'E-commerce': 0.80,
    'Manufacturing': 0.75,
    'Legal': 0.74,
    'Education': 0.70,
    'Retail': 0.65,
    'Nonprofit': 0.55,
    'Real Estate': 0.45,
    'Hospitality': 0.40,
    'Agriculture': 0.35,
    'Construction': 0.30
  },
  'ai automation': {
    'SaaS': 0.92,
    'E-commerce': 0.88,
    'Healthcare': 0.85,
    'Finance': 0.84,
    'Logistics': 0.82,
    'Manufacturing': 0.80,
    'Customer Support': 0.78,
    'Marketing': 0.76,
    'Retail': 0.72,
    'Energy': 0.65,
    'Education': 0.60,
    'Agriculture': 0.50
  },
  'cloud infrastructure': {
    'SaaS': 0.95,
    'E-commerce': 0.90,
    'Fintech': 0.88,
    'Healthcare': 0.85,
    'Government': 0.82,
    'Manufacturing': 0.78,
    'Telecommunications': 0.76,
    'Energy': 0.72,
    'Education': 0.65,
    'Retail': 0.62
  },
  'data analytics': {
    'SaaS': 0.90,
    'E-commerce': 0.88,
    'Healthcare': 0.85,
    'Fintech': 0.84,
    'Manufacturing': 0.80,
    'Retail': 0.78,
    'Logistics': 0.76,
    'Insurance': 0.74,
    'Energy': 0.70,
    'Telecommunications': 0.68
  },
  'consulting': {
    'Healthcare': 0.88,
    'Banking': 0.86,
    'Insurance': 0.84,
    'Energy': 0.82,
    'Government': 0.80,
    'Manufacturing': 0.78,
    'Aerospace': 0.76,
    'Telecommunications': 0.74,
    'SaaS': 0.72,
    'Retail': 0.65
  }
};

// ────────────────────────────────────────────────────────────────
// 4. Utility: Retry helper
// ────────────────────────────────────────────────────────────────

async function withRetry(fn, label, retries = 2, delayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      if (err.response?.status && err.response.status < 500 && err.response.status !== 429) {
        console.warn(`⛔ [Stage6] Non-retryable (${err.response.status}): ${err.message}`);
        return null;
      }
      console.warn(`⚠️ [Stage6] attempt ${attempt + 1} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying'}`);
      if (!isLast) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 5. Signal Extraction Functions
// ────────────────────────────────────────────────────────────────

function extractSignalScores(company, searchPackage) {
  const service = searchPackage.service_needed || '';
  const targetIndustry = searchPackage.industries?.[0] || '';
  const targetCountry = searchPackage.countries?.[0] || '';
  const targetType = searchPackage.target_type || 'Companies';
  
  const signals = {
    industry_match: { score: 0, evidence: [] },
    location_match: { score: 0, evidence: [] },
    hiring_activity: { score: 0, evidence: [] },
    tech_relevance: { score: 0, evidence: [] },
    size_match: { score: 0, evidence: [] },
    growth_signals: { score: 0, evidence: [] },
    digital_presence: { score: 0, evidence: [] },
    description_relevance: { score: 0, evidence: [] }
  };
  
  // ─── 1. Industry Match ───
  if (company.industry && service) {
    const industryRelevanceMap = INDUSTRY_RELEVANCE[service.toLowerCase()] || {};
    const industryKey = Object.keys(industryRelevanceMap).find(
      key => company.industry.toLowerCase().includes(key.toLowerCase()) || 
             key.toLowerCase().includes(company.industry.toLowerCase())
    );
    
    if (industryKey) {
      signals.industry_match.score = industryRelevanceMap[industryKey] || 0.5;
      signals.industry_match.evidence.push(`Industry "${company.industry}" has high relevance for ${service} services`);
    } else {
      // Check for partial match
      const partialMatch = Object.keys(industryRelevanceMap).find(
        key => company.industry.toLowerCase().includes(key.toLowerCase().slice(0, 4))
      );
      if (partialMatch) {
        signals.industry_match.score = industryRelevanceMap[partialMatch] * 0.7;
        signals.industry_match.evidence.push(`Industry "${company.industry}" partially matches relevant industries`);
      } else {
        signals.industry_match.score = 0.2;
        signals.industry_match.evidence.push(`Industry "${company.industry}" has limited observable relevance for ${service}`);
      }
    }
  } else if (company.industry && targetIndustry) {
    // User specified an industry
    const sim = company.industry.toLowerCase().includes(targetIndustry.toLowerCase()) || 
                targetIndustry.toLowerCase().includes(company.industry.toLowerCase());
    signals.industry_match.score = sim ? 0.85 : 0.30;
    signals.industry_match.evidence.push(sim ? `Industry matches user request: ${targetIndustry}` : `Industry "${company.industry}" differs from requested "${targetIndustry}"`);
  } else {
    signals.industry_match.score = 0.30;
    signals.industry_match.evidence.push('Industry information not available');
  }
  
  // ─── 2. Location Match ───
  if (company.location && targetCountry) {
    const locationLower = company.location.toLowerCase();
    const countryLower = targetCountry.toLowerCase();
    if (locationLower.includes(countryLower) || countryLower.includes(locationLower)) {
      signals.location_match.score = 0.95;
      signals.location_match.evidence.push(`Company location matches: ${targetCountry}`);
    } else {
      // Check for nearby/related locations
      const nearbyCountries = ['germany', 'austria', 'switzerland', 'belgium', 'netherlands', 'luxembourg'];
      if (nearbyCountries.some(c => locationLower.includes(c) && countryLower !== 'global')) {
        signals.location_match.score = 0.60;
        signals.location_match.evidence.push(`Company located in nearby region`);
      } else {
        signals.location_match.score = 0.15;
        signals.location_match.evidence.push(`Company location "${company.location}" differs from requested "${targetCountry}"`);
      }
    }
  } else if (company.location) {
    signals.location_match.score = 0.50;
    signals.location_match.evidence.push(`Location available: ${company.location}`);
  } else {
    signals.location_match.score = 0.30;
    signals.location_match.evidence.push('Location information not available');
  }
  
  // ─── 3. Hiring Activity ───
  if (company.hiring) {
    const hiringCount = typeof company.hiring === 'number' ? company.hiring : 1;
    if (hiringCount >= 10) {
      signals.hiring_activity.score = 0.90;
      signals.hiring_activity.evidence.push(`High hiring activity: ${hiringCount} open positions`);
    } else if (hiringCount >= 3) {
      signals.hiring_activity.score = 0.70;
      signals.hiring_activity.evidence.push(`Moderate hiring activity: ${hiringCount} open positions`);
    } else {
      signals.hiring_activity.score = 0.50;
      signals.hiring_activity.evidence.push(`Limited hiring activity detected`);
    }
    
    // Bonus for security-related hiring
    const securityKeywords = ['security', 'cyber', 'cloud', 'devops', 'engineer', 'architect'];
    const description = company.description || '';
    const hasSecurityHiring = securityKeywords.some(k => description.toLowerCase().includes(k));
    if (hasSecurityHiring) {
      signals.hiring_activity.score = Math.min(signals.hiring_activity.score + 0.15, 0.98);
      signals.hiring_activity.evidence.push('Security/technology hiring detected');
    }
  } else {
    signals.hiring_activity.score = 0.20;
    signals.hiring_activity.evidence.push('No observable hiring activity');
  }
  
  // ─── 4. Technology Relevance ───
  if (company.tech_stack && company.tech_stack.length > 0) {
    const relevantTechs = ['AWS', 'Azure', 'GCP', 'Kubernetes', 'Docker', 'Cloud', 'AI', 'ML', 'Security'];
    const matchingTechs = company.tech_stack.filter(tech => 
      relevantTechs.some(r => tech.toLowerCase().includes(r.toLowerCase()))
    );
    
    const matchRatio = matchingTechs.length / company.tech_stack.length;
    if (matchRatio > 0.5) {
      signals.tech_relevance.score = 0.90;
      signals.tech_relevance.evidence.push(`Technology stack includes relevant technologies: ${matchingTechs.join(', ')}`);
    } else if (matchRatio > 0.2) {
      signals.tech_relevance.score = 0.65;
      signals.tech_relevance.evidence.push(`Technology stack has some relevant technologies: ${matchingTechs.join(', ')}`);
    } else {
      signals.tech_relevance.score = 0.40;
      signals.tech_relevance.evidence.push(`Limited relevant technology signals detected`);
    }
  } else {
    signals.tech_relevance.score = 0.25;
    signals.tech_relevance.evidence.push('Technology stack information not available');
  }
  
  // ─── 5. Size Match ───
  if (company.employees) {
    const employees = company.employees;
    if (employees >= 1000) {
      signals.size_match.score = 0.90;
      signals.size_match.evidence.push(`Enterprise-size organization: ${employees} employees`);
    } else if (employees >= 100) {
      signals.size_match.score = 0.75;
      signals.size_match.evidence.push(`Mid-size organization: ${employees} employees`);
    } else if (employees >= 10) {
      signals.size_match.score = 0.55;
      signals.size_match.evidence.push(`Small organization: ${employees} employees`);
    } else {
      signals.size_match.score = 0.30;
      signals.size_match.evidence.push(`Very small organization: ${employees} employees`);
    }
  } else {
    signals.size_match.score = 0.40;
    signals.size_match.evidence.push('Employee count not available');
  }
  
  // ─── 6. Growth Signals ───
  let growthScore = 0.20;
  const growthEvidence = [];
  
  if (company.description) {
    const desc = company.description.toLowerCase();
    if (desc.includes('funding') || desc.includes('investment') || desc.includes('raised')) {
      growthScore += 0.25;
      growthEvidence.push('Funding/investment detected');
    }
    if (desc.includes('expand') || desc.includes('expansion') || desc.includes('new office')) {
      growthScore += 0.20;
      growthEvidence.push('Expansion activity detected');
    }
    if (desc.includes('growing') || desc.includes('growth') || desc.includes('scale')) {
      growthScore += 0.15;
      growthEvidence.push('Growth mentioned');
    }
    if (desc.includes('product') && (desc.includes('launch') || desc.includes('new'))) {
      growthScore += 0.10;
      growthEvidence.push('Product development activity');
    }
  }
  
  if (company.hiring && typeof company.hiring === 'number' && company.hiring > 5) {
    growthScore += 0.15;
    growthEvidence.push(`Significant hiring activity (${company.hiring} positions)`);
  }
  
  signals.growth_signals.score = Math.min(growthScore, 0.98);
  signals.growth_signals.evidence = growthEvidence.length > 0 ? growthEvidence : ['No observable growth signals'];
  
  // ─── 7. Digital Presence ───
  let presenceScore = 0.30;
  const presenceEvidence = [];
  
  if (company.website) {
    presenceScore += 0.25;
    presenceEvidence.push('Professional website detected');
  }
  if (company.linkedin) {
    presenceScore += 0.20;
    presenceEvidence.push('LinkedIn presence detected');
  }
  if (company.description && company.description.length > 100) {
    presenceScore += 0.15;
    presenceEvidence.push('Detailed business description available');
  }
  if (company.tech_stack && company.tech_stack.length > 0) {
    presenceScore += 0.10;
    presenceEvidence.push('Technology stack information available');
  }
  
  signals.digital_presence.score = Math.min(presenceScore, 0.98);
  signals.digital_presence.evidence = presenceEvidence.length > 0 ? presenceEvidence : ['Limited digital presence detected'];
  
  // ─── 8. Description Relevance ───
  if (company.description && service) {
    const desc = company.description.toLowerCase();
    const serviceWords = service.toLowerCase().split(' ');
    const matchCount = serviceWords.filter(word => desc.includes(word)).length;
    if (matchCount >= 2) {
      signals.description_relevance.score = 0.85;
      signals.description_relevance.evidence.push(`Description aligns with ${service} services`);
    } else if (matchCount >= 1) {
      signals.description_relevance.score = 0.60;
      signals.description_relevance.evidence.push(`Description partially aligns with ${service}`);
    } else {
      signals.description_relevance.score = 0.30;
      signals.description_relevance.evidence.push(`Limited description relevance detected`);
    }
  } else if (company.description) {
    signals.description_relevance.score = 0.50;
    signals.description_relevance.evidence.push('Description available but relevance unknown');
  } else {
    signals.description_relevance.score = 0.20;
    signals.description_relevance.evidence.push('No description available');
  }
  
  return signals;
}

// ────────────────────────────────────────────────────────────────
// 6. Calculate Overall Confidence Score
// ────────────────────────────────────────────────────────────────

function calculateOverallScore(signals) {
  let totalScore = 0;
  let totalWeight = 0;
  const contributions = [];
  
  for (const [key, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    if (signals[key]) {
      const weightedScore = signals[key].score * weight;
      totalScore += weightedScore;
      totalWeight += weight;
      contributions.push({
        signal: key,
        weight: weight,
        score: signals[key].score,
        weighted: weightedScore,
        evidence: signals[key].evidence
      });
    }
  }
  
  // Normalize
  const normalizedScore = totalWeight > 0 ? totalScore / totalWeight : DEFAULT_CONFIDENCE;
  
  // Clamp
  const finalScore = Math.min(Math.max(normalizedScore, MIN_CONFIDENCE_SCORE), MAX_CONFIDENCE_SCORE);
  
  return {
    score: Math.round(finalScore * 100) / 100,
    contributions: contributions,
    evidence_count: Object.values(signals).reduce((sum, s) => sum + (s.evidence?.length || 0), 0)
  };
}

// ────────────────────────────────────────────────────────────────
// 7. Generate Explainable Reasoning
// ────────────────────────────────────────────────────────────────

function generateReasoning(company, signals, overallScore, searchPackage) {
  const reasoning = [];
  const service = searchPackage.service_needed || 'the requested services';
  
  // Start with company identity
  reasoning.push(`${company.name || 'This company'} operates in the ${company.industry || 'unknown'} industry`);
  
  // Add location
  if (company.location) {
    reasoning.push(`is based in ${company.location}`);
  }
  
  // Add size
  if (company.employees) {
    reasoning.push(`employs approximately ${company.employees} people`);
  }
  
  // Add strongest signals
  const sortedSignals = Object.entries(signals)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 4);
  
  for (const [key, signal] of sortedSignals) {
    if (signal.score >= 0.6 && signal.evidence.length > 0) {
      reasoning.push(signal.evidence[0]);
    }
  }
  
  // Add overall assessment
  if (overallScore >= 0.80) {
    reasoning.push(`Overall: Strong evidence suggests this company is a promising prospect for ${service}`);
  } else if (overallScore >= 0.60) {
    reasoning.push(`Overall: Moderate evidence suggests this company may be a good prospect for ${service}`);
  } else if (overallScore >= 0.40) {
    reasoning.push(`Overall: Limited evidence available; this company may be a lower-priority prospect for ${service}`);
  } else {
    reasoning.push(`Overall: Limited evidence; this company may not be a strong prospect for ${service}`);
  }
  
  return reasoning;
}

// ────────────────────────────────────────────────────────────────
// 8. Score a Single Company
// ────────────────────────────────────────────────────────────────

function scoreSingleCompany(company, searchPackage) {
  const name = company.name || company.company || 'Unknown Company';
  console.log(`📊 [Stage6] Scoring: ${name}`);
  
  // Extract signals
  const signals = extractSignalScores(company, searchPackage);
  
  // Calculate overall score
  const overall = calculateOverallScore(signals);
  
  // Generate reasoning
  const reasoning = generateReasoning(company, signals, overall.score, searchPackage);
  
  // Build scored company object
  const scoredCompany = {
    ...company,
    score: {
      overall: overall.score,
      signals: {
        industry_match: signals.industry_match,
        location_match: signals.location_match,
        hiring_activity: signals.hiring_activity,
        tech_relevance: signals.tech_relevance,
        size_match: signals.size_match,
        growth_signals: signals.growth_signals,
        digital_presence: signals.digital_presence,
        description_relevance: signals.description_relevance
      },
      contributions: overall.contributions,
      reasoning: reasoning,
      confidence_interpretation: {
        level: overall.score >= 0.80 ? 'high' : overall.score >= 0.60 ? 'medium' : 'low',
        description: overall.score >= 0.80 
          ? 'Based on observable evidence, this company appears to be a strong prospect' 
          : overall.score >= 0.60 
          ? 'Based on observable evidence, this company appears to be a moderate prospect'
          : 'Based on observable evidence, this company appears to be a lower-priority prospect'
      }
    },
    scored_at: new Date().toISOString()
  };
  
  console.log(`✅ [Stage6] ${name}: Score ${overall.score} (${scoredCompany.score.confidence_interpretation.level})`);
  
  return scoredCompany;
}

// ────────────────────────────────────────────────────────────────
// 9. Main Stage 6 Function: Skyline Intelligence
// ────────────────────────────────────────────────────────────────

async function scoreCompanies({ 
  companies, 
  searchPackage, 
  userId = 'anonymous', 
  onProgress = null,
  limit = MAX_COMPANIES_TO_SCORE
}) {
  console.log(`🧠 [Stage6] Starting Skyline Intelligence for user ${userId}...`);
  console.log(`📊 [Stage6] Received ${companies?.length || 0} companies from Stage 5`);
  onProgress?.('🧠 Analyzing company intelligence...');
  
  // ─── Validate input ───
  if (!companies || companies.length === 0) {
    return {
      success: false,
      error: 'No companies provided to Stage 6',
      companies: [],
      stats: {
        total_input: 0,
        scored: 0,
        high_confidence: 0,
        medium_confidence: 0,
        low_confidence: 0
      }
    };
  }
  
  // ─── Limit companies to score ───
  const companiesToScore = companies.slice(0, limit);
  const skipped = companies.length - companiesToScore.length;
  
  console.log(`📊 [Stage6] Scoring ${companiesToScore.length} companies (${skipped} skipped due to limit)`);
  
  // ─── Score each company ───
  const scoredCompanies = [];
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;
  
  for (let i = 0; i < companiesToScore.length; i++) {
    const company = companiesToScore[i];
    onProgress?.(`🧠 Scoring ${i + 1}/${companiesToScore.length}: ${company.name || company.company || 'Unknown'}...`);
    
    const scored = scoreSingleCompany(company, searchPackage);
    scoredCompanies.push(scored);
    
    // Track counts
    if (scored.score.confidence_interpretation.level === 'high') highCount++;
    else if (scored.score.confidence_interpretation.level === 'medium') mediumCount++;
    else lowCount++;
  }
  
  // ─── Calculate stats ───
  const stats = {
    total_input: companies.length,
    scored: scoredCompanies.length,
    skipped: skipped,
    high_confidence: highCount,
    medium_confidence: mediumCount,
    low_confidence: lowCount,
    average_score: scoredCompanies.reduce((sum, c) => sum + c.score.overall, 0) / (scoredCompanies.length || 1)
  };
  
  console.log(`✅ [Stage6] Scoring complete: ${highCount} high, ${mediumCount} medium, ${lowCount} low confidence`);
  console.log(`📊 [Stage6] Average score: ${(stats.average_score * 100).toFixed(1)}%`);
  
  return {
    success: true,
    companies: scoredCompanies,
    stats: stats,
    userId: userId,
    search_package: searchPackage,
    timestamp: new Date().toISOString()
  };
}

// ────────────────────────────────────────────────────────────────
// 10. Helper: Get Scoring Statistics
// ────────────────────────────────────────────────────────────────

function getScoringStats(companies) {
  if (!companies || companies.length === 0) {
    return {
      total: 0,
      high: 0,
      medium: 0,
      low: 0,
      average_score: 0,
      top_signals: []
    };
  }
  
  let high = 0, medium = 0, low = 0;
  let totalScore = 0;
  const signalCounts = {};
  
  for (const company of companies) {
    const level = company.score?.confidence_interpretation?.level || 'low';
    if (level === 'high') high++;
    else if (level === 'medium') medium++;
    else low++;
    
    totalScore += company.score?.overall || 0;
    
    // Count signal occurrences
    if (company.score?.contributions) {
      for (const contrib of company.score.contributions) {
        signalCounts[contrib.signal] = (signalCounts[contrib.signal] || 0) + 1;
      }
    }
  }
  
  // Get top signals
  const topSignals = Object.entries(signalCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([signal, count]) => ({ signal, count }));
  
  return {
    total: companies.length,
    high: high,
    medium: medium,
    low: low,
    average_score: totalScore / companies.length,
    top_signals: topSignals
  };
}

// ────────────────────────────────────────────────────────────────
// 11. Public Exports
// ────────────────────────────────────────────────────────────────

module.exports = {
  scoreCompanies,
  scoreSingleCompany,
  extractSignalScores,
  calculateOverallScore,
  generateReasoning,
  getScoringStats,
  SIGNAL_WEIGHTS,
  INDUSTRY_RELEVANCE,
  MAX_COMPANIES_TO_SCORE,
  MAX_CONCURRENT_SCORES
};
