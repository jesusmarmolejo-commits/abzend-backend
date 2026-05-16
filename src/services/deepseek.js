import OpenAI from 'openai';

/**
 * Creates a configured DeepSeek client (OpenAI-compatible).
 * @throws {Error} if DEEPSEEK_API_KEY is not set
 */
export function createDeepSeekClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set in environment variables');

  return new OpenAI({
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    apiKey,
  });
}

/**
 * Sends a chat request to DeepSeek and returns the response string.
 * @param {string} prompt         User message
 * @param {string} systemPrompt   System instruction
 * @param {Object} options        { model, maxTokens, temperature }
 * @returns {Promise<string>}
 */
export async function deepseekChat(prompt, systemPrompt, options = {}) {
  const {
    model       = process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    maxTokens   = 1024,
    temperature = 0.2,
  } = options;

  try {
    const client = createDeepSeekClient();
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: prompt },
      ],
      max_tokens:  maxTokens,
      temperature,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Empty response from DeepSeek API');
    return content;

  } catch (error) {
    console.error('[DeepSeek] API error:', error.message);
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED')
      throw new Error(`Network error reaching DeepSeek: ${error.message}`);
    if (error.status === 401) throw new Error('Invalid DEEPSEEK_API_KEY');
    if (error.status === 429) throw new Error('DeepSeek rate limit exceeded');
    throw new Error(`DeepSeek request failed: ${error.message}`);
  }
}
