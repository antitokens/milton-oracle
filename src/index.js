import { SYSTEM_PROMPT, createEmptyResolution } from './sys.js';

// Define allowed origins
const ORIGINS = ['https://lite.antitoken.pro', 'https://app.antitoken.pro', 'http://localhost:3000'];

// Helper function to build CORS headers based on the request origin
function getCorsHeaders(request) {
	const origin = request.headers.get('Origin');
	const headers = {
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	};
	if (origin && ORIGINS.includes(origin)) {
		headers['Access-Control-Allow-Origin'] = origin;
	} else {
		// Optionally, set to 'null' or omit the header if not allowed
		headers['Access-Control-Allow-Origin'] = 'null';
	}
	return headers;
}

// Define the models to query
const MODELS = [
	{ name: 'ChatGPT-4o-mini', id: 'openai/gpt-4o-mini' },
	{ name: 'Grok 2', id: 'x-ai/grok-2' },
	{ name: 'Claude 3.5 Sonnet', id: 'anthropic/claude-3.5-sonnet' },
	{ name: 'DeepSeek R1', id: 'deepseek/deepseek-r1:free' },
	{ name: 'Perplexity R1', id: 'perplexity/r1-1776' },
	{ name: 'Gemini 2.0 Flash', id: 'google/gemini-2.0-flash-001' },
];

async function queryModel(env, prompt, model, question) {
	try {
		const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://antitoken.pro',
			},
			body: JSON.stringify({
				model: model.id,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: prompt },
				],
			}),
		});

		const data = await response.json();

		if (!response.ok) {
			console.error(`OpenRouter API error ${response.status} for ${model.name}: ${JSON.stringify(data)}`);
			return {
				...createEmptyResolution(question),
				apiError: `${response.status}: ${JSON.stringify(data)}`,
			};
		}

		if (!data.choices || data.choices.length === 0) {
			console.error(`Unexpected API response for ${model.name}: ${JSON.stringify(data)}`);
			return {
				...createEmptyResolution(question),
				apiError: `No choices in response: ${JSON.stringify(data)}`,
			};
		}

		let resolution = data.choices[0].message.content;
		if (typeof resolution === 'string') {
			try {
				resolution = JSON.parse(resolution);
			} catch (e) {
				try {
					// Try to find JSON object within text
					const match = resolution.match(/```json\s*([\s\S]*?)\s*```/);
					if (!match) {
						const match2 = resolution.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
						if (match2) {
							const match3 = resolution.match(/\{[\s\S]*"questionClarity"[\s\S]*"finalVerdict"[\s\S]*\}/);
							if (match3) {
								let jsonText = match3[0].replace(/\n\s*/g, ' ');
								// Advanced cleaning - replace any obvious unescaped quotes in string values
								resolution = extractJSON(jsonText.replace(/'/g, '"'));
							} else {
								throw new Error('Failed to cleanup response');
							}
						} else {
							throw new Error('Failed to parse response');
						}
					} else {
						// Attempt to parse the matched content
						resolution = JSON.parse(match[1].trim());
					}
				} catch (e) {
					console.error(`Failed to parse JSON for ${model.name}: ${resolution}`);
					console.error(`Error for ${model.name}: ${e.message}`);
					return {
						...createEmptyResolution(question),
						apiError: `Parse error: ${e.message}`,
						rawResponse: resolution.substring(0, 200) + '...',
					};
				}
			}
		}

		return resolution;
	} catch (error) {
		console.error(`Error querying ${model.name}:`, error);
		return {
			...createEmptyResolution(question),
			apiError: error.message,
		};
	}
}

function validateProbability(resolution, modelName) {
	if (!resolution || !resolution.probabilityAssessment) return null;

	const prob = Number(resolution.probabilityAssessment.probability);
	if (isNaN(prob) || prob < 0 || prob > 100) return null;

	return { modelName, probability: prob };
}

function calculateMeanProbability(validModels) {
	// Requires at least half of whitelisted models to yield valid assessments
	if (validModels.length < MODELS.length / 2) return null;

	const sum = validModels.reduce((acc, model) => acc + model.probability, 0);
	return sum / validModels.length;
}

const extractJSON = (text) => {
	// Look for JSON block starting with a curly brace
	const jsonStartIndex = text.indexOf('{');
	if (jsonStartIndex === -1) return null;

	// Find potential JSON object by matching opening and closing braces
	let braceCount = 0;
	let endIndex = jsonStartIndex;

	for (let i = jsonStartIndex; i < text.length; i++) {
		if (text[i] === '{') braceCount++;
		if (text[i] === '}') braceCount--;

		if (braceCount === 0 && text[i] === '}') {
			endIndex = i + 1;
			break;
		}
	}

	// Extract the potential JSON string
	const jsonStr = text.substring(jsonStartIndex, endIndex);

	try {
		// Clean the string: replace linebreaks and extra whitespace
		const cleanedJson = jsonStr.replace(/\n\s+/g, ' ').replace(/\s+/g, ' ');

		return JSON.parse(cleanedJson);
	} catch (error) {
		console.error('JSON parsing failed:', error.message);
		return null;
	}
};

export async function generatePrediction(env, question, context, index) {
	const KV = env.Beta;
	const prompt = `
Question: ${question}
${context ? `Additional Context: ${context}` : ''}
Please analyse this prediction market question and provide a detailed assessment.`;

	try {
		// Get existing resolution status or create new object
		const predictionsKey = 'predictions';
		const resolutionsKey = 'resolutions_' + index;
		const resolutions = JSON.parse((await KV.get(resolutionsKey)) || '{}'); //
		const predictions = JSON.parse((await KV.get(predictionsKey)) || '{}');

		const prediction = predictions[index] || {};

		// Check if we have existing resolutions and resolved flag set
		if (resolutions && prediction.resolved) {
			return resolutions;
		}

		// Query all models in parallel
		const results = {};
		const resolution = MODELS.map((model) =>
			queryModel(env, prompt, model, question).then((resolution) => {
				results[model.name] = resolution;
				return resolution;
			})
		);

		await Promise.all(resolution);

		// Get valid models with their names
		const validModels = Object.entries(results)
			.map(([modelName, resolution]) => validateProbability(resolution, modelName))
			.filter((result) => result !== null);

		// Calculate mean probability from all valid model predictions
		const meanProbability = calculateMeanProbability(validModels);

		// Add aggregate metrics to the results
		results.aggregate = {
			meanProbability,
			validModelsCount: validModels.length,
			validModels: validModels.map((model) => model.modelName),
			totalModelsCount: MODELS.length,
			individualProbabilities: {},
		};

		// Add individual probabilities to the aggregate for transparency
		validModels.forEach((model) => {
			results.aggregate.individualProbabilities[model.modelName] = model.probability;
		});

		// Calculate truth values based on mean probability
		let truth = [];
		let resolved = false;

		if (meanProbability !== null) {
			truth = [1 - meanProbability / 100, meanProbability / 100];
			resolved = true;

			// Add the calculated probability to the aggregate object
			results.aggregate.finalProbability = meanProbability;
		}

		// Add resolution state
		results.truth = truth;
		results.resolved = resolved;

		if (resolved) {
			prediction.resolved = resolved;
			prediction.truth = truth;
			predictions[index] = prediction;
			await KV.put(predictionsKey, JSON.stringify(predictions));
		}

		// Save the multi-model predictions
		await KV.put(resolutionsKey, JSON.stringify(results));
		return JSON.stringify(results);
	} catch (error) {
		console.error('Prediction generation error:', error);
		throw error;
	}
}

export default {
	async fetch(request, env, ctx) {
		const corsHeaders = getCorsHeaders(request);

		// Handle CORS preflight request
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders,
			});
		}

		try {
			const { question, context, index } = await request.json();
			const predictions = await generatePrediction(env, question, context, index);
			return new Response(JSON.stringify({ predictions }), {
				headers: {
					'Content-Type': 'application/json',
					...corsHeaders,
				},
			});
		} catch (error) {
			return new Response(JSON.stringify({ error: error.message }), {
				status: 400,
				headers: {
					'Content-Type': 'application/json',
					...corsHeaders,
				},
			});
		}
	},
};
