'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';
const MAX_ATTEMPTS = 2;

// ────────────────────────────────────────────────────────────────
// FALLBACK STRATEGY BUILDER
// ────────────────────────────────────────────────────────────────

// Builds the fallback strategy from the Understanding output using the
// conditional fallback rules:
//   IF target exists        → start with target + location
//   IF qualification exists → plan to check those qualifications
//   IF signals exist        → plan to investigate those signals
//   IF exclusions exist     → plan to exclude them
//   IF quantity exists      → search toward that quantity
//   IF need exists          → include the need when designing the search approach

function buildFallbackStrategy(understanding) {
    const parts = [];

    if (understanding.targetEntity) {
        const city = understanding.location?.city ?? '';
        const country = understanding.location?.country ?? '';
        parts.push(
            `start with ${understanding.targetEntity} in ${city}, ${country}`
        );
    }

    if (understanding.qualification) {
        parts.push(`plan to check ${understanding.qualification}`);
    }

    if (understanding.signal) {
        parts.push(`plan to investigate ${understanding.signal}`);
    }

    if (understanding.exclusions) {
        parts.push(`plan to exclude ${understanding.exclusions}`);
    }

    if (understanding.quantity) {
        parts.push(`search toward ${understanding.quantity}`);
    }

    if (understanding.problem) {
        parts.push(
            `include ${understanding.problem} need when designing the search approach`
        );
    }

    return parts.join(' → ');
}

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given the output of the Understanding layer. The Understanding layer
has already determined what the user wants: the target entity, problem, intent,
location, industry, qualification, signal, quantity, information, exclusions,
and constraints.

Your only task is to create the Search Strategy.

Search Strategy is the overall plan for how to find the leads the user
requested.

Search Strategy answers the question: what overall approach should be used to
find these leads?

The Understanding layer has already determined what the user wants. Search
Strategy now turns that understanding into a high-level search approach.

The strategy determines the general path of the search, such as:

1. What should be searched for first.
2. What should be investigated afterward.
3. Which requirements should guide the search.
4. How the different parts of the request work together.
5. What should happen if the first approach does not produce enough candidates.

The exact websites, search queries, and search budget are handled by other
components. Do not include them in the strategy.

Search Strategy does not actually search. It does not report results. It does
not say that a specific entity was found. Instead, it describes how the search
should be carried out.

The strategy must describe what needs to be investigated. It must not claim
that the investigation has already succeeded.

Use forward-looking and investigative language, such as:
search for, look for, investigate, check for, plan to, continue looking for.

Do not use language that suggests the work is already complete, such as:
found, identified, confirmed, verified, ensured, located.

Example:

If the Understanding output is:

{
  "targetEntity": "hospitals",
  "problem": "MRI equipment",
  "intent": "to find hospitals in Chicago that require MRI equipment and are hiring radiology staff",
  "location": { "city": "Chicago", "country": "USA" },
  "industry": "healthcare",
  "qualification": "revenue over $10M",
  "signal": "hiring radiology staff",
  "quantity": "200 hospitals",
  "information": [
    "companyName",
    "companyEmail",
    "phoneNumber",
    "shortCompanyInformation"
  ],
  "exclusions": "government-owned facilities",
  "constraints": "results must not include duplicates"
}

A suitable Search Strategy would be:

"Search for hospitals in Chicago → plan to exclude government-owned facilities
→ plan to check which hospitals meet the revenue requirement → plan to
investigate evidence related to MRI needs, including radiology hiring →
continue searching for suitable candidates until enough valid leads are
available."

Decide the Search Strategy yourself from the complete meaning of the
Understanding output.
Do not use keyword matching.
Do not follow a predefined strategy list.
Do not allow the code or any external rule to decide the strategy.
Return the most accurate plain-text description of the search strategy.

The strategy must be a clear, meaningful plain-text description of the overall
approach. Do not return an empty or null strategy.

Do not explain your answer.
Do not perform a search.
Do not provide recommendations.
Do not add evidence.
Do not add confidence scores.
Do not invent unnecessary details.

Return only valid JSON using exactly this format:

{
  "strategy": "the search strategy"
}
`;

// ────────────────────────────────────────────────────────────────
// PLAN REQUEST
// ────────────────────────────────────────────────────────────────

async function planRequest(understanding) {
    console.log('[PlanRequest] Started');
    console.log('[PlanRequest] Received understanding:', understanding);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[PlanRequest] Attempt ${attempt}/${MAX_ATTEMPTS}`
        );

        try {
            const completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: 0,
                response_format: {
                    type: 'json_object',
                },
                messages: [
                    {
                        role: 'system',
                        content: SYSTEM_INSTRUCTIONS,
                    },
                    {
                        role: 'user',
                        content: `Understanding output:\n${JSON.stringify(
                            understanding,
                            null,
                            2
                        )}`,
                    },
                ],
            });

            console.log('[PlanRequest] OpenAI response received');

            const content = completion.choices?.[0]?.message?.content;

            console.log('[PlanRequest] Raw model response:', content);

            if (!content) {
                console.error(
                    '[PlanRequest] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[PlanRequest] Parsed model response:',
                parsedResult
            );

            const strategy = parsedResult?.strategy;

            if (
                typeof strategy === 'string' &&
                strategy.trim().length > 0
            ) {
                const result = {
                    strategy: strategy.trim(),
                };

                console.log('[PlanRequest] Final result:', result);

                return result;
            }

            console.warn(
                '[PlanRequest] No valid strategy returned'
            );
        } catch (error) {
            console.error(
                `[PlanRequest] Attempt ${attempt} failed`
            );

            console.error('[PlanRequest] Error name:', error.name);
            console.error('[PlanRequest] Error message:', error.message);
            console.error('[PlanRequest] Error status:', error.status);
            console.error('[PlanRequest] Full error:', error);
        }
    }

    const fallbackResult = {
        strategy: buildFallbackStrategy(understanding),
    };

    console.warn(
        '[PlanRequest] All attempts failed. Using fallback:',
        fallbackResult
    );

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = planRequest;
