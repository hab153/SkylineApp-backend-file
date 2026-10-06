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

// The four stages that Search Task Coordination can build tasks for.
const VALID_STAGES = [
    'companyDiscovery',
    'qualification',
    'signalEvidence',
    'supportingEvidence',
];

// ────────────────────────────────────────────────────────────────
// GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `
You are given two completed outputs:

1. The Understanding output — what the user wants.
2. The Planning output — how the search should be approached.

Your only task is to combine them into one structured Discovery Context.

The Discovery Context is the official working folder for one discovery job.
It is the source of truth that the rest of the Discovery system will read
from. It tells Discovery what it is trying to discover, what qualifies, what
must be excluded, what evidence matters, and what search plan and limits it
must follow.

You organize the information. You do not decide it.

You must not:

- invent information that is not present in the Understanding or Planning output
- guess missing information
- change the location
- change the qualification
- change the quantity
- remove or weaken exclusions
- weaken constraints
- create new queries
- create new evidence searches
- search the internet
- verify any company
- reinterpret the user's requirements

You may only take the values that are already present in the Understanding
and Planning outputs and place them into the corresponding fields of the
Discovery Context.

Use exactly these field names in the Discovery Context.

From the Understanding output:

- understanding.targetEntity  → discoveryContext.target
- understanding.problem       → discoveryContext.need
- understanding.intent        → discoveryContext.intent
- understanding.location      → discoveryContext.location
- understanding.industry      → discoveryContext.industry
- understanding.qualification → discoveryContext.qualification
- understanding.signal        → discoveryContext.signal
- understanding.quantity      → discoveryContext.quantity
- understanding.information   → discoveryContext.requiredInformation
- understanding.exclusions    → discoveryContext.exclusions
- understanding.constraints   → discoveryContext.constraints

From the Planning output:

- planning.strategy       → discoveryContext.strategy
- planning.source         → discoveryContext.source
- planning.query          → discoveryContext.query
- planning.evidenceSearch → discoveryContext.evidenceSearch
- planning.allocation     → discoveryContext.allocation
- planning.searchExpansion → discoveryContext.searchExpansion

Preserve the values exactly as they appear in the source fields.

Do not transform any value. Do not flatten objects. Do not convert strings
to numbers. Do not split strings into arrays. Do not merge or split fields.

If a field is missing in the source, leave it missing or empty. Do not invent
a value.

Return only valid JSON using exactly this format:

{
  "target": "the target entity",
  "need": "the problem or need",
  "intent": "the intent",
  "location": {
    "city": "the city",
    "country": "the country"
  },
  "industry": "the industry",
  "qualification": "the qualification",
  "signal": "the signal",
  "quantity": "the quantity",
  "requiredInformation": ["the required information fields"],
  "exclusions": "the exclusions",
  "constraints": "the constraints",
  "strategy": "the strategy",
  "source": "the source",
  "query": ["the search queries"],
  "evidenceSearch": ["the evidence searches"],
  "allocation": {
    "totalSearches": 0,
    "distribution": {}
  },
  "searchExpansion": "the search expansion plan"
}

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
Do not invent unnecessary details.
`;

// ────────────────────────────────────────────────────────────────
// FALLBACK CONTEXT BUILDER
// ────────────────────────────────────────────────────────────────

// Builds the Discovery Context by copying trusted values from the
// Understanding and Planning outputs into the Discovery Context structure.
// The fallback does not understand, guess, transform, or invent anything.
// It only maps each source field to its corresponding context field.

function buildFallbackContext(understanding, planning) {
    const u = understanding ?? {};
    const p = planning ?? {};

    return {
        target: u.targetEntity,
        need: u.problem,
        intent: u.intent,
        location: u.location,
        industry: u.industry,
        qualification: u.qualification,
        signal: u.signal,
        quantity: u.quantity,
        requiredInformation: u.information,
        exclusions: u.exclusions,
        constraints: u.constraints,
        strategy: p.strategy,
        source: p.source,
        query: p.query,
        evidenceSearch: p.evidenceSearch,
        allocation: p.allocation,
        searchExpansion: p.searchExpansion,
    };
}

// ────────────────────────────────────────────────────────────────
// CONTEXT VALIDATION
// ────────────────────────────────────────────────────────────────

// Structural validation only. The validator never invents or fixes values.
// It only confirms that the context is a usable structure. If the structure
// is not usable, the caller falls through to the fallback builder.

function isValidContext(context) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) {
        return false;
    }

    const requiredStringFields = [
        'target',
        'need',
        'intent',
        'industry',
        'qualification',
        'signal',
        'quantity',
        'exclusions',
        'constraints',
        'strategy',
        'source',
        'searchExpansion',
    ];

    for (const field of requiredStringFields) {
        if (
            typeof context[field] !== 'string' ||
            context[field].trim().length === 0
        ) {
            return false;
        }
    }

    if (
        !context.location ||
        typeof context.location !== 'object' ||
        Array.isArray(context.location) ||
        typeof context.location.city !== 'string' ||
        context.location.city.trim().length === 0 ||
        typeof context.location.country !== 'string' ||
        context.location.country.trim().length === 0
    ) {
        return false;
    }

    if (
        !Array.isArray(context.requiredInformation) ||
        context.requiredInformation.length === 0
    ) {
        return false;
    }

    if (
        !Array.isArray(context.query) ||
        context.query.length === 0
    ) {
        return false;
    }

    if (!Array.isArray(context.evidenceSearch)) {
        return false;
    }

    if (
        !context.allocation ||
        typeof context.allocation !== 'object' ||
        Array.isArray(context.allocation)
    ) {
        return false;
    }

    return true;
}

// ────────────────────────────────────────────────────────────────
// DISCOVERY CONTEXT
// ────────────────────────────────────────────────────────────────

async function discoverySearch(understanding, planning) {
    console.log('[DiscoverySearch] Started');
    console.log(
        '[DiscoverySearch] Received understanding:',
        understanding
    );
    console.log('[DiscoverySearch] Received planning:', planning);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[DiscoverySearch] Attempt ${attempt}/${MAX_ATTEMPTS}`
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
                        )}\n\nPlanning output:\n${JSON.stringify(
                            planning,
                            null,
                            2
                        )}`,
                    },
                ],
            });

            console.log(
                '[DiscoverySearch] OpenAI response received'
            );

            const content = completion.choices?.[0]?.message?.content;

            console.log(
                '[DiscoverySearch] Raw model response:',
                content
            );

            if (!content) {
                console.error(
                    '[DiscoverySearch] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[DiscoverySearch] Parsed model response:',
                parsedResult
            );

            if (isValidContext(parsedResult)) {
                console.log(
                    '[DiscoverySearch] Valid context from AI'
                );

                return parsedResult;
            }

            console.warn(
                '[DiscoverySearch] AI context failed validation'
            );
        } catch (error) {
            console.error(
                `[DiscoverySearch] Attempt ${attempt} failed`
            );

            console.error(
                '[DiscoverySearch] Error name:',
                error.name
            );
            console.error(
                '[DiscoverySearch] Error message:',
                error.message
            );
            console.error(
                '[DiscoverySearch] Error status:',
                error.status
            );
            console.error('[DiscoverySearch] Full error:', error);
        }
    }

    const fallbackResult = buildFallbackContext(
        understanding,
        planning
    );

    console.warn(
        '[DiscoverySearch] All attempts failed. Using fallback:',
        fallbackResult
    );

    if (!isValidContext(fallbackResult)) {
        console.error(
            '[DiscoverySearch] Fallback context failed validation'
        );
    }

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// TASK COORDINATION — GPT INSTRUCTIONS
// ────────────────────────────────────────────────────────────────

const TASK_SYSTEM_INSTRUCTIONS = `
You are given two things:

1. A completed Discovery Context — the official working folder for one
   discovery job. It contains the target, need, intent, location, industry,
   qualification, signal, quantity, required information, exclusions,
   constraints, strategy, source, query, evidenceSearch, allocation, and
   searchExpansion.

2. A stage name — the kind of discovery work that must happen next.

Your only task is to build one Search Task for the given stage.

The Search Task is the exact instruction that the Searching System will
execute. It describes what should be searched next, not the results of any
search.

You must not:

- invent information that is not present in the Discovery Context
- guess missing information
- change the target, location, qualification, quantity, signal, exclusions,
  or constraints
- remove or weaken requirements
- create new queries that are not present in the Discovery Context
- create new evidence searches that are not present in the Discovery Context
- search the internet
- verify any company
- decide which stage comes next

You may only map the values that are already present in the Discovery
Context into the Search Task fields, selecting the fields that are relevant
to the given stage.

The valid stages are:

- companyDiscovery
- qualification
- signalEvidence
- supportingEvidence

Stage instructions:

For companyDiscovery:
Fill queries from discoveryContext.query, sources from
discoveryContext.source, requirements from discoveryContext.qualification,
exclusions from discoveryContext.exclusions, constraints from
discoveryContext.constraints, and requestedQuantity from
discoveryContext.quantity.
The objective should describe finding the target entity in its location.
Leave evidenceQueries as an empty array and evidenceRequirement as an
empty string.

For qualification:
Fill requirements from discoveryContext.qualification.
The objective should describe investigating whether the target entities meet
the qualification.
Leave queries as an empty array, sources as an empty string,
evidenceQueries as an empty array, evidenceRequirement as an empty string,
exclusions as an empty string, and constraints as an empty string.
Keep requestedQuantity from discoveryContext.quantity.

For signalEvidence:
Fill evidenceQueries from discoveryContext.evidenceSearch and
evidenceRequirement from discoveryContext.signal.
The objective should describe finding evidence that the target entities match
the signal.
Leave queries as an empty array, sources as an empty string, requirements
as an empty string, exclusions as an empty string, and constraints as an
empty string.
Keep requestedQuantity from discoveryContext.quantity.

For supportingEvidence:
Fill evidenceQueries from discoveryContext.evidenceSearch.
The objective should describe finding supporting evidence for the target
entities.
Leave queries as an empty array, sources as an empty string, requirements
as an empty string, evidenceRequirement as an empty string, exclusions as
an empty string, and constraints as an empty string.
Keep requestedQuantity from discoveryContext.quantity.

Use forward-looking and investigative language in the objective, such as:
find, investigate, look for, search for, check for, gather evidence for.

Do not use language that suggests the work is already complete, such as:
found, identified, confirmed, verified, ensured, located.

Preserve the values exactly as they appear in the Discovery Context.
Do not transform any value. Do not flatten objects. Do not convert strings
to numbers. Do not split strings into arrays. Do not merge or split fields.

Return only valid JSON using exactly this format:

{
  "type": "the stage name",
  "objective": "a short forward-looking description of the task",
  "queries": ["the search queries for this task"],
  "sources": "the sources for this task",
  "requirements": "the requirements for this task",
  "evidenceQueries": ["the evidence queries for this task"],
  "evidenceRequirement": "the evidence requirement for this task",
  "exclusions": "the exclusions for this task",
  "constraints": "the constraints for this task",
  "requestedQuantity": "the requested quantity"
}

Do not explain your answer.
Do not add extra fields.
Do not remove any fields.
Do not invent unnecessary details.
`;

// ────────────────────────────────────────────────────────────────
// FALLBACK TASK BUILDER
// ────────────────────────────────────────────────────────────────

// Builds a Search Task from the Discovery Context by copying trusted values
// into the task structure for the given stage. The fallback does not
// understand, guess, transform, or invent anything. It only maps each source
// field to its corresponding task field for the given stage.

function buildFallbackTask(context, stage) {
    const c = context ?? {};

    const city = c.location?.city ?? '';
    const country = c.location?.country ?? '';
    const location = `${city}, ${country}`.replace(/,\s*$/, '');

    const target = c.target ?? '';
    const qualification = c.qualification ?? '';
    const signal = c.signal ?? '';

    const emptyTask = {
        type: stage,
        objective: '',
        queries: [],
        sources: '',
        requirements: '',
        evidenceQueries: [],
        evidenceRequirement: '',
        exclusions: '',
        constraints: '',
        requestedQuantity: c.quantity ?? '',
    };

    if (stage === 'companyDiscovery') {
        return {
            type: 'companyDiscovery',
            objective: `Find ${target} in ${location}`,
            queries: Array.isArray(c.query) ? c.query : [],
            sources: c.source ?? '',
            requirements: qualification,
            evidenceQueries: [],
            evidenceRequirement: '',
            exclusions: c.exclusions ?? '',
            constraints: c.constraints ?? '',
            requestedQuantity: c.quantity ?? '',
        };
    }

    if (stage === 'qualification') {
        return {
            type: 'qualification',
            objective: `Investigate whether ${target} meet ${qualification}`,
            queries: [],
            sources: '',
            requirements: qualification,
            evidenceQueries: [],
            evidenceRequirement: '',
            exclusions: '',
            constraints: '',
            requestedQuantity: c.quantity ?? '',
        };
    }

    if (stage === 'signalEvidence') {
        return {
            type: 'signalEvidence',
            objective: `Find evidence that ${target} match ${signal}`,
            queries: [],
            sources: '',
            requirements: '',
            evidenceQueries: Array.isArray(c.evidenceSearch)
                ? c.evidenceSearch
                : [],
            evidenceRequirement: signal,
            exclusions: '',
            constraints: '',
            requestedQuantity: c.quantity ?? '',
        };
    }

    if (stage === 'supportingEvidence') {
        return {
            type: 'supportingEvidence',
            objective: `Find supporting evidence for ${target}`,
            queries: [],
            sources: '',
            requirements: '',
            evidenceQueries: Array.isArray(c.evidenceSearch)
                ? c.evidenceSearch
                : [],
            evidenceRequirement: '',
            exclusions: '',
            constraints: '',
            requestedQuantity: c.quantity ?? '',
        };
    }

    return emptyTask;
}

// ────────────────────────────────────────────────────────────────
// TASK VALIDATION
// ────────────────────────────────────────────────────────────────

// Structural validation only. The validator never invents or fixes values.
// It only confirms that the task is a usable structure.

function isValidTask(task) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
        return false;
    }

    if (
        typeof task.type !== 'string' ||
        !VALID_STAGES.includes(task.type)
    ) {
        return false;
    }

    if (
        typeof task.objective !== 'string' ||
        task.objective.trim().length === 0
    ) {
        return false;
    }

    if (!Array.isArray(task.queries)) {
        return false;
    }

    if (typeof task.sources !== 'string') {
        return false;
    }

    if (typeof task.requirements !== 'string') {
        return false;
    }

    if (!Array.isArray(task.evidenceQueries)) {
        return false;
    }

    if (typeof task.evidenceRequirement !== 'string') {
        return false;
    }

    if (typeof task.exclusions !== 'string') {
        return false;
    }

    if (typeof task.constraints !== 'string') {
        return false;
    }

    if (typeof task.requestedQuantity !== 'string') {
        return false;
    }

    return true;
}

// ────────────────────────────────────────────────────────────────
// SEARCH TASK COORDINATION
// ────────────────────────────────────────────────────────────────

async function searchTask(discoveryContext, stage) {
    console.log('[SearchTask] Started');
    console.log('[SearchTask] Received stage:', stage);
    console.log(
        '[SearchTask] Received discoveryContext:',
        discoveryContext
    );

    if (!VALID_STAGES.includes(stage)) {
        console.warn(
            `[SearchTask] Unknown stage "${stage}". Using fallback for the current stage value.`
        );
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        console.log(
            `[SearchTask] Attempt ${attempt}/${MAX_ATTEMPTS}`
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
                        content: TASK_SYSTEM_INSTRUCTIONS,
                    },
                    {
                        role: 'user',
                        content: `Discovery Context:\n${JSON.stringify(
                            discoveryContext,
                            null,
                            2
                        )}\n\nStage:\n${stage}`,
                    },
                ],
            });

            console.log(
                '[SearchTask] OpenAI response received'
            );

            const content = completion.choices?.[0]?.message?.content;

            console.log(
                '[SearchTask] Raw model response:',
                content
            );

            if (!content) {
                console.error(
                    '[SearchTask] Model returned an empty response'
                );
                continue;
            }

            const parsedResult = JSON.parse(content);

            console.log(
                '[SearchTask] Parsed model response:',
                parsedResult
            );

            if (isValidTask(parsedResult)) {
                console.log(
                    '[SearchTask] Valid task from AI'
                );

                return parsedResult;
            }

            console.warn(
                '[SearchTask] AI task failed validation'
            );
        } catch (error) {
            console.error(
                `[SearchTask] Attempt ${attempt} failed`
            );

            console.error('[SearchTask] Error name:', error.name);
            console.error(
                '[SearchTask] Error message:',
                error.message
            );
            console.error(
                '[SearchTask] Error status:',
                error.status
            );
            console.error('[SearchTask] Full error:', error);
        }
    }

    const fallbackResult = buildFallbackTask(
        discoveryContext,
        stage
    );

    console.warn(
        '[SearchTask] All attempts failed. Using fallback:',
        fallbackResult
    );

    if (!isValidTask(fallbackResult)) {
        console.error(
            '[SearchTask] Fallback task failed validation'
        );
    }

    return fallbackResult;
}

// ────────────────────────────────────────────────────────────────
// EXPORTS
// ────────────────────────────────────────────────────────────────

module.exports = {
    discoverySearch,
    searchTask,
};
