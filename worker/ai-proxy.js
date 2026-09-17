/**
 * AI 解读代理 - Cloudflare Worker（免费，可选）
 *
 * 为什么需要它：
 *   应用「新闻追踪」页的「🤖 AI 生成解读」默认直接调用你填的 LLM 官方接口。
 *   但很多官方接口（OpenAI / DeepSeek 等）在浏览器直连时会被 CORS 拦截，
 *   且把 Key 放浏览器也有泄露风险。这个 Worker 把 Key 放在服务端，
 *   浏览器只调 Worker 地址，既解决跨域又避免密钥暴露。
 *
 * 部署步骤：
 * 1. 打开 https://dash.cloudflare.com → 登录（免费，无需信用卡）
 * 2. 左侧菜单 → Workers & Pages → Create application → Create Worker
 * 3. 名字填 ai-proxy → Deploy
 * 4. 点击「Edit code」→ 把本文件全部内容粘贴进去
 * 5. 在 Worker 的「Settings → Variables」里添加环境变量：
 *      AI_API_KEY   = 你的 LLM Key（如 sk-...）
 *      AI_ENDPOINT  = 官方 chat/completions 地址（如 https://api.deepseek.com/v1/chat/completions）
 *      AI_MODEL     = 模型名（如 deepseek-chat）
 *      （如需多模型，可再加 AI_MODEL_2 等，前端在模型名里填对应值即可）
 * 6. Save and deploy → 复制地址（形如 https://ai-proxy.你的子域.workers.dev）
 * 7. 在应用「设置 → AI 解读」里：
 *      - API 地址：填上面这个 Worker 地址
 *      - API Key：随便填一个占位（浏览器不再需要真实 Key，真实 Key 在 Worker 环境变量里）
 *      - 模型名：填 Worker 里配置的模型名（如 deepseek-chat）
 *
 * 接口：
 *   POST /           → 透传请求体到官方 LLM，加 CORS 头返回（浏览器直接 fetch 本地址即可）
 *   GET  /           → 健康检查
 *
 * 免费额度：每天 10 万次请求，个人使用完全够用。
 */
export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === 'GET') {
      return new Response('AI Proxy OK. POST your OpenAI-compatible body to "/"', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
    }

    const endpoint = (env.AI_ENDPOINT || '').trim();
    const apiKey = (env.AI_API_KEY || '').trim();
    const defaultModel = (env.AI_MODEL || '').trim();
    if (!endpoint || !apiKey) {
      return new Response(JSON.stringify({ error: 'Worker 未配置 AI_ENDPOINT / AI_API_KEY 环境变量' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: '请求体不是合法 JSON' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 前端若未指定 model，用 Worker 默认模型；前端也可在 body.model 里覆盖
    if (!body.model && defaultModel) body.model = defaultModel;

    try {
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify(body)
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: {
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
          ...corsHeaders
        }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
};
