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

// Define the models to query
const MODELS = [
  { name: 'ChatGPT-o3-mini', id: 'openai/gpt-3.5-turbo' },
  { name: 'Claude 3.5 Sonnet', id: 'anthropic/claude-3-5-sonnet' },
  { name: 'Grok 2', id: 'xai/grok-2' },
  { name: 'DeepSeek R1', id: 'deepseek/deepseek-coder' },
  { name: 'Perplexity', id: 'perplexity/perplexity-online' },
  { name: 'Gemini 1.5', id: 'google/gemini-1.5-pro' }
];

function createEmptyResolution(question) {
  return {
    "questionClarity": {
      "question": question,
      "timeframe": undefined,
      "thresholds": undefined
    },
    "analysis": {
      "marketConditions": undefined,
      "metrics": undefined,
      "keyDataPoints": undefined
    },
    "probabilityAssessment": {
      "probability": undefined,
      "supportingFactors": undefined,
      "criticalAssumptions": undefined
    },
    "reasoning": {
      "evidence": undefined,
      "logicalSteps": undefined,
      "uncertainties": undefined
    },
    "certaintyLevel": {
      "level": undefined,
      "explanation": undefined
    },
    "finalVerdict": undefined,
    "error": true
  };
}

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
        apiError: `${response.status}: ${JSON.stringify(data)}`
      };
    }

    if (!data.choices || data.choices.length === 0) {
      console.error(`Unexpected API response for ${model.name}: ${JSON.stringify(data)}`);
      return {
        ...createEmptyResolution(question),
        apiError: `No choices in response: ${JSON.stringify(data)}`
      };
    }

    let resolution = data.choices[0].message.content;
    if (typeof resolution === 'string') {
      try {
        resolution = JSON.parse(resolution);
      } catch (e) {
        console.error(`Failed to parse JSON for ${model.name}: ${resolution}`);
        return {
          ...createEmptyResolution(question),
          apiError: `Parse error: ${e.message}`,
          rawResponse: resolution.substring(0, 200) + "..."
        };
      }
    }
    
    return resolution;
  } catch (error) {
    console.error(`Error querying ${model.name}:`, error);
    return {
      ...createEmptyResolution(question),
      apiError: error.message
    };
  }
}

function validateProbability(resolution) {
  if (!resolution || !resolution.probabilityAssessment) return null;
  
  const prob = Number(resolution.probabilityAssessment.probability);
  if (isNaN(prob) || prob < 0 || prob > 100) return null;
  
  return prob;
}

function calculateMeanProbability(results) {
  const validProbabilities = Object.values(results)
    .map(validateProbability)
    .filter(prob => prob !== null);
  
  // Requires at least half of whitelisted models to yield valid assessments
  if (validProbabilities.length < MODELS.length / 2) return null;
  
  const sum = validProbabilities.reduce((acc, val) => acc + val, 0);
  return sum / validProbabilities.length;
}

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
	const resolutions = JSON.parse((await KV.get(resolutionsKey)) || '{}');
	const predictions = JSON.parse((await KV.get(predictionsKey)) || '{}');
	
	const prediction = predictions[index] || {};
	let resolution;
		
    // Check if we have existing resolutions and resolved flag set
    if (resolutions && prediction.resolved) {
      return resolutions;
    }
    
    // Query all models in parallel
    const results = {};
    const modelPromises = MODELS.map(model => 
      queryModel(env, prompt, model, question).then(resolution => {
        results[model.name] = resolution;
        return resolution;
      })
    );
    
    await Promise.all(modelPromises);
    
    // Calculate mean probability from all valid model predictions
    const meanProbability = calculateMeanProbability(results);
    
    // Add aggregate metrics to the results
    const validModels = Object.values(results)
      .map(validateProbability)
      .filter(prob => prob !== null);
      
    results.aggregate = {
      meanProbability,
      validModels: validModels,
      allModels: MODELS,
      individualProbabilities: {}
    };
    
    // Add individual probabilities to the aggregate for transparency
    Object.entries(results).forEach(([modelName, resolution]) => {
      const prob = validateProbability(resolution);
      if (prob !== null) {
        results.aggregate.individualProbabilities[modelName] = prob;
      }
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
};  // Requires at least half of whitelisted models to yield valid assessments
  if (validProbabilities.length < MODELS.length / 2) return null;const predictions = JSON.parse((await KV.get('predictions')) || '{}');
    const prediction = predictions[index] || {};
    
    if (resolved) {
      prediction.resolved = resolved;
      prediction.truth = truth;
      predictions[index] = prediction;
      await KV.put('predictions', JSON.stringify(predictions));
    }
