'use strict';

const OpenAI = require('openai');

// ────────────────────────────────────────────────────────────────
// CONFIGURATION
// ────────────────────────────────────────────────────────────────

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = 'gpt-4o-mini';
const FALLBACK_TARGET = 'company';
const FALLBACK_PROBLEM = 'customer';
const FALLBACK_INTENT = 'potential_customers';
const FALLBACK_INDUSTRY = 'Software';

const FALLBACK_LOCATION = {
    city: 'New York City',
    country: 'USA',
};

const MAX_ATTEMPTS = 2;

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
Your only task is to understand the complete meaning of the user's request
and identify:

1. The main target entity the user is looking for.
2. The main problem, need, or area of interest connected to that target entity.
3. The actual search intent behind the request.
4. The location connected to the user's request.
5. The industry the user is looking for.

Read and understand the complete user request before deciding the result.
Do not rely only on exact keywords.

The target entity is the type of thing the user is looking for, such as a company,
school, restaurant, hotel, agency, hospital, software, product, person, location,
or any other suitable entity.

The problem is the main problem, need, service, product, industry, or area of
interest connected to the target entity.

Search intent means the actual purpose behind the user's request: what the user
is trying to accomplish with the search and what relationship the target entity
has with the problem, need, service, product, industry, event, or subject.

Decide the search intent yourself from the complete meaning of the request.
Do not use keyword matching.
Do not follow a predefined intent list.
Do not allow the code or any external rule to decide the intent.
Return the most accurate plain-text description of the user's actual search intent.

For example, determine whether the user is looking for entities that may need
something, provide something, use something, are hiring for something, belong
to a category, are expanding, show a particular event, or represent any other
meaning that is appropriate for the request. These are only examples, not limits.

Industry instructions:

The industry is the type or category of what the user is looking for.

Decide the industry yourself from the complete meaning of the request.
Do not use keyword matching.
Do not follow a predefined industry list.
Do not allow the code or any external rule to decide the industry.
Return the most accurate plain-text description of the industry the user
is looking for.

If the industry cannot be clearly identified from the user's request,
return an empty string for the industry value.

Location instructions:

The location must contain exactly two fields:

{
  "city": "the identified city",
  "country": "the identified country"
}

You are fully responsible for understanding and completing the location.
The code will not identify, infer, complete, clean, normalize, or decide
the location for you.

The location must always contain a meaningful, non-empty city and country.

If the user clearly provides both a city and a country, return those values.

If the user clearly provides a country but the city is missing or unclear,
choose a suitable city in that country and return the country.

If the user clearly provides a city but the country is missing or unclear,
identify the country that contains that city and return both values.

If the user does not provide a clear location, or the location cannot be
understood, use this location:

{
  "city": "New York City",
  "country": "USA"
}

Do not return null or empty values for city or country.

Do not add any other location fields.
Do not add state, region, continent, location type, relationship,
radius, distance, unit, include, exclude, or any other location property.

Do not explain your answer.
Do not perform a search.
Do not provide recommendations.
Do not add evidence.
Do not add confidence scores.
Do not invent unnecessary details.

Return only valid JSON using exactly this format:

{
  "targetEntity": "the identified target",
  "problem": "the identified problem or need",
  "intent": "the actual purpose of the user's search",
  "location": {
    "city": "the identified city",
    "country": "the identified country"
  },
  "industry": "the identified industry"
}

If the target entity cannot be clearly identified, return:

{
  "targetEntity": null,
  "problem": "customer",
  "intent": "the best-understood search intent",
  "location": {
    "city": "the identified city",
    "country": "the identified country"
  },
  "industry": "the identified industry"
}

If the problem, need, or area of interest cannot be clearly identified,
use "customer" as the problem value.

The problem value must never be null or empty.

The intent must be a clear, meaningful plain-text description of what the
user is trying to accomplish. Do not return an empty or null intent.
`;

// ────────────────────────────────────────────────────────────────
// UNDERSTAND REQUEST
// ────────────────────────────────────────────────────────────────

async function understandRequest(message) {
    console.log('[UnderstandRequest] Started');
    console.log('[UnderstandRequest] Received message:', message);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[UnderstandRequest] Attempt ${attempt}/${MAX_ATTEMPTS}`
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
                        content: message,
                    },
                ],
            });

            console.log('[UnderstandRequest] OpenAI response received');

            const content = completion.choices?.[0]?.message?.content;

            console.log('[UnderstandRequest] Raw model response:', content);

            if (!content) {
                console.error(
                    '[UnderstandRequest] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[UnderstandRequest] Parsed model response:',
                parsedResult
            );

            const targetEntity = parsedResult?.targetEntity;
            const problem = parsedResult?.problem;
            const intent = parsedResult?.intent;
            const location = parsedResult?.location;
            const industry = parsedResult?.industry;

            if (
                typeof targetEntity === 'string' &&
                targetEntity.trim().length > 0
            ) {
                const result = {
                    targetEntity: targetEntity.trim(),

                    problem:
                        typeof problem === 'string' &&
                        problem.trim().length > 0
                            ? problem.trim()
                            : FALLBACK_PROBLEM,

                    intent:
                        typeof intent === 'string' &&
                        intent.trim().length > 0
                            ? intent.trim()
                            : FALLBACK_INTENT,

                    location,

                    industry:
                        typeof industry === 'string' &&
                        industry.trim().length > 0
                            ? industry.trim()
                            : FALLBACK_INDUSTRY,
                };

                console.log('[UnderstandRequest] Final result:', result);

                return result;
            }

            console.warn(
                '[UnderstandRequest] No valid target entity returned'
            );
        } catch (error) {
            console.error(
                `[UnderstandRequest] Attempt ${attempt} failed`
            );

            console.error('[UnderstandRequest] Error name:', error.name);
            console.error('[UnderstandRequest] Error message:', error.message);
            console.error('[UnderstandRequest] Error status:', error.status);
            console.error('[UnderstandRequest] Full error:', error);
        }
    }

    const fallbackResult = {
        targetEntity: FALLBACK_TARGET,
        problem: FALLBACK_PROBLEM,
        intent: FALLBACK_INTENT,
        location: FALLBACK_LOCATION,
        industry: FALLBACK_INDUSTRY,
    };

    console.warn(
        '[UnderstandRequest] All attempts failed. Using fallback:',
        fallbackResult
    );

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = understandRequest;
