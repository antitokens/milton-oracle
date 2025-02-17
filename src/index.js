import { SYSTEM_PROMPT } from './sys.js';

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

export async function generatePrediction(env, question, context, index) {
	const KV = env.Beta;
	const prompt = `
  Question: ${question}
  ${context ? `Additional Context: ${context}` : ''}
  Please analyse this prediction market question and provide a detailed assessment.`;

	try {
		// Get existing resolution status or create new object
		const resolutions = JSON.parse((await KV.get('resolutions_' + index)) || '{}');
		const predictions = JSON.parse((await KV.get('predictions')) || '{}');
		const prediction = predictions[index] || {};
		let resolution;

		if ((JSON.stringify(prediction) === '{}' || !prediction.resolved) && JSON.stringify(resolutions) === '{}') {
			const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': 'https://antitoken.pro',
				},
				body: JSON.stringify({
					model: 'openai/gpt-4', // TODO: Make this configurable
					messages: [
						{ role: 'system', content: SYSTEM_PROMPT },
						{ role: 'user', content: prompt },
					],
				}),
			});
			const data = await response.json();

			if (!response.ok) {
				// The API returned an error status code, so log and throw an error.
				throw new Error(`OpenRouter API error ${response.status}: ${JSON.stringify(data)}`);
			}

			if (!data.choices || data.choices.length === 0) {
				throw new Error(`Unexpected API response: ${JSON.stringify(data)}`);
			}

			resolution = data.choices[0].message.content;
			if (typeof resolution === 'string') {
				resolution = JSON.parse(resolution);
			}
			// Save the updated resolutions
			await KV.put('resolutions_' + index, JSON.stringify(resolution));
			const number = Number(resolution.probabilityAssessment.probability);
			let truth;
			let resolved;

			if (!isNaN(number) && number >= 0 && number <= 100) {
				truth = [1 - number / 100, number / 100];
				resolved = true;
			} else {
				resolved = false;
				truth = [];
			}

			if (JSON.stringify(prediction) !== '{}') {
				prediction.resolved = resolved;
				prediction.truth = truth;
				predictions[index] = prediction;
				await KV.put('predictions', JSON.stringify(predictions));
			}
		} else {
			// Get existing resolution status or create new object
			resolution = JSON.parse((await KV.get('resolutions_' + index)) || '{}');
		}

		return JSON.stringify(resolution);
	} catch (error) {
		console.error('OpenRouter API Error:', error);
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
			const prediction = await generatePrediction(env, question, context, index);
			return new Response(JSON.stringify({ prediction }), {
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
