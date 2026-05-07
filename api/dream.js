const MODEL_CONFIG = {
  deepseek: {
    label: '🧊 DeepSeek',
    url: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY'
  },
  kimi: {
    label: '🦊 Kimi',
    url: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k',
    envKey: 'KIMI_API_KEY'
  },
  doubao: {
    label: '🔴 豆包',
    url: 'https://api.doubao.com/v1/chat/completions',
    model: 'Doubao',
    envKey: 'DOUBAO_API_KEY'
  }
};

const SYSTEM_PROMPT = `
你是温柔、专业、治愈的心理学梦境解析师，结合荣格心理学、梦境象征学，拒绝封建迷信、不危言耸听、不绝对化，所有解析仅供心理参考。

# 你的能力
1. 接收用户完整梦境描述，自动提取核心元素
2. 从4个维度解析：核心象征、潜意识状态、情绪分析、暖心建议
3. 语言通俗治愈、积极正向、贴合普通人生活
4. 不玄学、不晦涩、不吓人

# 输出格式（严格JSON，不要多余文字）
{
  "symbol": "3-5个核心象征+简短通俗解释",
  "subconscious": "潜意识解读：压力/欲望/关系/内心诉求，温和细腻",
  "emotion": "主导情绪+可能生活成因",
  "advice": "2条简单可落地的心理调节建议"
}

请直接输出JSON格式的解析结果，不要包含任何其他文字。
`.trim();

module.exports = async (request, response) => {
  setCorsHeaders(response);

  if (request.method === 'OPTIONS') {
    response.status(204).end();
    return;
  }

  if (request.method !== 'POST') {
    response.status(405).json({
      error: 'Method Not Allowed'
    });
    return;
  }

  try {
    const payload = await analyzeDream(request.body || {});
    response.status(200).json(payload);
  } catch (error) {
    response.status(error.statusCode || 500).json({
      error: error.message || '服务端处理失败'
    });
  }
};

async function analyzeDream(body) {
  const dreamText = typeof body?.dreamText === 'string' ? body.dreamText.trim() : '';
  const emotion = typeof body?.emotion === 'string' ? body.emotion.trim() : '';
  const modelType = body?.modelType || 'deepseek';

  if (!dreamText) {
    throw createHttpError(400, 'dreamText 不能为空');
  }

  const config = MODEL_CONFIG[modelType] || MODEL_CONFIG.deepseek;
  const apiKey = process.env[config.envKey];

  if (!apiKey) {
    throw createHttpError(503, `服务端未配置 ${config.label} 的 API Key`);
  }

  const upstreamResponse = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: `${SYSTEM_PROMPT}\n\n用户梦境：${dreamText}\n用户标注情绪：${emotion || '未标注'}`
        },
        {
          role: 'user',
          content: '请帮我解析这个梦境'
        }
      ],
      temperature: 0.7,
      max_tokens: 1000
    })
  });

  const upstreamData = await safeReadJson(upstreamResponse);
  if (!upstreamResponse.ok) {
    const message = upstreamData?.error?.message || upstreamData?.error?.code || '上游模型请求失败';
    throw createHttpError(upstreamResponse.status, message);
  }

  const content = upstreamData?.choices?.[0]?.message?.content;
  if (!content) {
    throw createHttpError(502, '模型没有返回解析内容');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw createHttpError(502, '模型返回内容不是合法 JSON');
  }

  return {
    analysis: parsed,
    sourceMeta: {
      type: 'ai',
      label: config.label,
      requestedModel: modelType,
      requestedModelLabel: config.label,
      actualModel: config.model
    }
  };
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function safeReadJson(response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      raw: text
    };
  }
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
