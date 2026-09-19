/**
 * 글자 캡챠 OCR용 OpenAI Vision
 * 성공률 우선: gpt-4o + detail=high (왜곡 글자는 mini/low에서 오답이 많음)
 */

export const OCR_VISION_MODEL = 'gpt-4o';
export const OCR_VISION_DETAIL = 'high';

export function isOpenAiCreditsError(err) {
  const m = String(err?.message || err || '');
  return /no credits remaining|insufficient[_ ]quota|exceeded.*quota|billing|credit balance/i.test(m);
}

/**
 * @param {{
 *   apiKey: string,
 *   prompt: string,
 *   b64: string,
 *   mimeType?: string,
 *   temperature?: number,
 *   maxTokens?: number,
 *   detail?: 'low'|'high'|'auto',
 *   model?: string,
 * }} opts
 */
export async function callOpenAiVision({
  apiKey,
  prompt,
  b64,
  mimeType = 'image/png',
  temperature = 0,
  maxTokens = 50,
  detail = OCR_VISION_DETAIL,
  model = OCR_VISION_MODEL,
} = {}) {
  if (!apiKey) throw new Error('OpenAI API Key가 없습니다.');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}`, detail } },
        ],
      }],
      temperature,
      max_tokens: maxTokens,
    }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return (data.choices?.[0]?.message?.content || '').trim();
}
