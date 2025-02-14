import { SYSTEM_PROMPT } from './sys.js';

// Define allowed origins
const ALLOWED_ORIGINS = ['https://*.antitoken.pro', 'http://localhost:3000'];

// Helper function to build CORS headers based on the request origin
function getCorsHeaders(request) {
	const origin = request.headers.get('Origin');
	const headers = {
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	};
	if (origin && ALLOWED_ORIGINS.includes(origin)) {
		headers['Access-Control-Allow-Origin'] = origin;
	} else {
		// Optionally, set to 'null' or omit the header if not allowed
		headers['Access-Control-Allow-Origin'] = 'null';
	}
	return headers;
}

export async function generatePrediction(env, question, context) {
	const prompt = `
  Question: ${question}
  ${context ? `Additional Context: ${context}` : ''}
  Please analyse this prediction market question and provide a detailed assessment.`;

	try {
		/*
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

		return data.choices[0].message.content;
		*/

		// Fake response for tests
		const prediction = {
			questionClarity: {
				question: 'Not specified',
				timeframe: 'Not specified',
				thresholds: 'Not specified',
			},
			analysis: {
				marketConditions: 'Not specified',
				metrics: ['Not applicable in this context'],
				keyDataPoints: ['Not applicable in this context'],
			},
			probabilityAssessment: {
				probability: 0,
				supportingFactors: ['Lack of specific query'],
				criticalAssumptions: ['Assumption of an unspecified question'],
			},
			reasoning: {
				evidence: ['Absence of a clear question', 'Absence of a specific timeframe'],
				logicalSteps: [
					'Identified that the question and timeframe were not specified',
					'Concluded that a probability assessment cannot be provided',
				],
				uncertainties: ['Unclear question', 'Unknown timeframe', 'Lack of market data'],
			},
			certaintyLevel: {
				level: 'VEILED_IN_MIST',
				explanation: 'The lack of a clear question, timeframe, and market data makes this a highly uncertain prediction.',
			},
			finalVerdict: 'Due to the lack of a specified question, timeframe or data, a precise prediction cannot be made.',
		};
		return JSON.stringify(prediction);
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
			const { question, context } = await request.json();
			const prediction = await generatePrediction(env, question, context);
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
