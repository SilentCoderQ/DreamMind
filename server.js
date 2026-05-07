const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

loadEnvFile(path.join(ROOT, '.env'));

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

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
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

const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname === '/api/dream' && req.method === 'POST') {
        try {
            const body = await readJsonBody(req);
            const payload = await analyzeDream(body);
            sendJson(res, 200, payload);
        } catch (error) {
            const status = error.statusCode || 500;
            sendJson(res, status, {
                error: error.message || '服务端处理失败'
            });
        }
        return;
    }

    serveStatic(requestUrl.pathname, res);
});

server.listen(PORT, () => {
    console.log(`DreamMind server running at http://localhost:${PORT}`);
});

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

    const response = await fetch(config.url, {
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

    const data = await safeReadJson(response);
    if (!response.ok) {
        const message = data?.error?.message || data?.error?.code || '上游模型请求失败';
        throw createHttpError(response.status, message);
    }

    const content = data?.choices?.[0]?.message?.content;
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

function serveStatic(pathname, res) {
    const safePath = pathname === '/' ? '/index.html' : pathname;
    const relativePath = path.normalize(decodeURIComponent(safePath)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const filePath = path.join(ROOT, relativePath);

    if (!filePath.startsWith(ROOT)) {
        sendJson(res, 403, { error: '禁止访问' });
        return;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                sendJson(res, 404, { error: '文件不存在' });
                return;
            }

            sendJson(res, 500, { error: '读取文件失败' });
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'
        });
        res.end(content);
    });
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8'
    });
    res.end(JSON.stringify(data));
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';

        req.on('data', chunk => {
            raw += chunk;
            if (raw.length > 1_000_000) {
                reject(createHttpError(413, '请求体过大'));
                req.destroy();
            }
        });

        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (error) {
                reject(createHttpError(400, '请求 JSON 格式不正确'));
            }
        });

        req.on('error', () => {
            reject(createHttpError(400, '读取请求失败'));
        });
    });
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

function loadEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const equalIndex = trimmed.indexOf('=');
        if (equalIndex === -1) {
            continue;
        }

        const key = trimmed.slice(0, equalIndex).trim();
        const value = trimmed.slice(equalIndex + 1).trim();
        if (key && !process.env[key]) {
            process.env[key] = stripQuotes(value);
        }
    }
}

function stripQuotes(value) {
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        return value.slice(1, -1);
    }

    return value;
}
