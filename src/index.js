import { SYSTEM_PROMPT } from './sys.js';

export async function generatePrediction(env, question, context) {
	const prompt = `
Question: ${question}
${context ? `Additional Context: ${context}` : ''}
Please analyze this prediction market question and provide a detailed assessment.`;

	try {
		const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://antitoken.pro',
			},
			body: JSON.stringify({
				model: 'openai/gpt-4', // make this configurable
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: prompt },
				],
			}),
		});

		const data = await response.json();
		return data.choices[0].message.content;
	} catch (error) {
		console.error('OpenRouter API Error:', error);
		throw error;
	}
}

export default {
	async fetch(request, env, ctx) {
		try {
			const { question, context } = await request.json();
			const prediction = await generatePrediction(env, question, context);
			return new Response(prediction, {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			return new Response(JSON.stringify({ error: error.message }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	},
};
