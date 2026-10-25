// 鲸鲸参谋悬窗 · SillyTavern 全局扩展 v1.1.0
// 🐋 悬窗：🎯 问下一步 / ✨ 帮我完善 / 🚀 直接发送；⚙️ 快速设置；Alt+K 唤起。
// 生成走 ST 核心 generateRaw（不带入聊天历史/角色卡/世界书），或自定义 OpenAI 兼容 API。
// 支持加载酒馆「对话补全预设」（prompt_order + assistant_prefill + 采样参数），从机制上防空输出。
import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, generateRaw, getRequestHeaders, substituteParams } from '../../../../script.js';

const MODULE = 'whale-advisor';

const DEFAULT_SYS = '你是当前角色卡的幕后参谋助手（元助手），不是卡里的角色本人。不要扮演角色推进剧情，不要输出 <StatusPlaceHolderImpl/>、<UpdateVariable> 或任何标签；只完成当前交给你的元任务。';
const DEFAULT_ASK = '任务：当前卡片「{角色}」的玩家（老板）在问：下一步推荐做什么。\n\n当前状态（仅作参考，严禁写进输出）：{状态}\n\n最近剧情：\n{剧情}\n{搜索}\n要求：\n- 只输出 2~3 个下一步行动建议，每条一行，以 - 开头\n- 每条具体可执行，带数字（金额/天数/数量/目标），符合当前现金与时间量级\n- 不要复述状态、变量或任何键值对\n- 最后一行用一句话问选哪个\n- 全文不超过 160 字';
const DEFAULT_REFINE = '任务：把玩家的粗略想法，改写成一条他本人直接发给剧情 AI 的输入（第一人称视角的剧本式输入）。\n写法：\n- 动作：第一人称现在时直接叙述「我做什么」，具体到身体动作与对象——这是行为描述，不是台词，不许念出来\n- 台词：想法里明确要「说」出口的内容，用「」括起来；想法没让说的不要编台词\n- 动作与台词按自然顺序衔接\n- 当前状态仅用于把模糊处补成具体数字，严禁写进输出：{状态}\n{搜索}\n要求：\n- 完整保留原意的全部细节与尺度，不淡化、不缩水、不自我审查\n- 模糊处按当前状态补上合理且具体的数字、时间、方式\n- 严禁复述状态、变量、JSON 或任何键值对\n- 只输出改写结果本身，不要任何解释或前缀\n\n玩家的想法：{想法}';
const OUTPUT_RULE = '\n\n【输出格式·必须遵守】第一行输出 <<<JX>>>，随后直接输出结果，最后一行输出 <<<END>>>，除此之外不输出任何内容。';

const DEFAULTS = {
    showButton: true,
    channel: 'main',
    sendMode: 'direct',
    custom: { baseUrl: '', model: '' },
    apiKey: '',
    guideOutput: true,
    sysPreset: DEFAULT_SYS,
    askTemplate: DEFAULT_ASK,
    refineTemplate: DEFAULT_REFINE,
    presetName: '',
    presetJson: null,
    web: { mode: 'trigger', backend: 'searxng', searxUrl: '', tavilyKey: '', results: 6, triggers: '搜索\n搜一下\n查一下\n查查\n联网\n上网\n行情\n价格\n多少钱\n报价\n最新\n新闻\n时事\nnews\nlatest\nsearch\nprice' },
};

function activeTriggers() {
    return String(settings.web.triggers || '')
        .split(/[\n,，]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function deepMerge(base, extra) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const k of Object.keys(extra ?? {})) {
        const v = extra[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
            out[k] = deepMerge(base[k], v);
        } else if (v !== undefined) {
            out[k] = v;
        }
    }
    return out;
}
const settings = (extension_settings[MODULE] = deepMerge(DEFAULTS, extension_settings[MODULE] ?? {}));

// 迁移：旧版 web.enabled → web.mode
if (settings.web && typeof settings.web.enabled === 'boolean') {
    settings.web.mode = settings.web.enabled ? 'trigger' : 'off';
    delete settings.web.enabled;
}

// ---------- 基础工具 ----------
function ctx() {
    try { return getContext() || null; } catch (e) { return null; }
}
function charName() {
    const c = ctx();
    if (!c) return '角色';
    try {
        if (c.groupId && Array.isArray(c.groups)) {
            const g = c.groups.find((x) => x && x.id === c.groupId);
            if (g && g.name) return g.name;
        }
        if (c.name2) return c.name2;
        if (Array.isArray(c.characters) && c.characters[c.characterId]?.name) return c.characters[c.characterId].name;
    } catch (e) {}
    return '角色';
}
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function getPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
function setPath(obj, p, v) {
    const ks = p.split('.');
    const last = ks.pop();
    const t = ks.reduce((o, k) => (o[k] = o[k] || {}), obj);
    t[last] = v;
}

// ---------- 变量读取（兼容 MVU stat_data，任意卡片） ----------
function findStatData(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    if (obj.$meta !== undefined && !Array.isArray(obj)) return obj;
    if (obj.时间 && obj.财务) return obj;
    for (const k of Object.keys(obj)) {
        try {
            const r = findStatData(obj[k], depth + 1);
            if (r) return r;
        } catch (e) {}
    }
    return null;
}
function readStatData() {
    const chat = ctx()?.chat;
    if (Array.isArray(chat)) {
        for (let i = chat.length - 1; i >= Math.max(0, chat.length - 3); i--) {
            const s = findStatData(chat[i], 0);
            if (s) return s;
        }
    }
    return null;
}
function fmtNum(n) {
    n = Number(n) || 0;
    if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(2).replace(/\.?0+$/, '') + '万亿';
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(Math.abs(n) < 1e10 ? 1 : 0).replace(/\.0$/, '') + '亿';
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
    return String(Math.round(n));
}
function renderStatData(sd) {
    const parts = [];
    for (const [k, v] of Object.entries(sd)) {
        if (k === '$meta' || v == null) continue;
        if (typeof v !== 'object') parts.push(k + '=' + (typeof v === 'number' ? fmtNum(v) : v));
        else if (Array.isArray(v)) parts.push(k + '[' + v.length + ']');
        else {
            const leaves = Object.entries(v).filter(([k2]) => k2 !== '$meta').slice(0, 4)
                .map(([k2, v2]) => k2 + '=' + (typeof v2 === 'number' ? fmtNum(v2) : (typeof v2 === 'object' ? (Array.isArray(v2) ? '[' + v2.length + ']' : '…') : v2)))
                .join(' ');
            parts.push(k + '{ ' + leaves + ' }');
        }
    }
    return parts.join(' ｜ ') || '（变量为空）';
}
function stateLineText() {
    const sd = readStatData();
    return sd ? renderStatData(sd) : '（读不到变量，参谋会按剧情自行估计）';
}
function recentStory(n) {
    const chat = ctx()?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return '（读不到聊天记录）';
    const name = charName();
    return chat.slice(-n).map((m) => {
        const who = m.is_user ? '老板' : (m.name || name);
        const txt = String(m.mes || '').replace(/<[\s\S]*?>/g, '').replace(/\s+/g, ' ').trim();
        return who + '：' + txt.slice(0, 240);
    }).join('\n');
}

// ---------- 输出提取与清洗 ----------
function stripBalancedJson(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '{') {
            let depth = 0, j = i, inStr = false, esc = false;
            for (; j < s.length; j++) {
                const c = s[j];
                if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
                if (c === '"') inStr = true;
                else if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) break; }
            }
            if (j < s.length) { i = j; continue; }
        }
        out += s[i];
    }
    return out;
}
function cleanModelOutput(s) {
    let t = String(s)
        .replace(/<StatusPlaceHolderImpl\s*\/?>/gi, '')
        .replace(/<initvar>[\s\S]*?<\/initvar>/gi, '')
        .replace(/<(UpdateVariable|Analysis|JSONPatch)>[\s\S]*?<\/\1>/gi, '')
        .replace(/```[a-zA-Z]*\s*/g, '')
        .replace(/<<<(?:JX|END)>>>/g, '');
    if (/父节点变量快照|变量快照/.test(t)) {
        t = stripBalancedJson(t).replace(/父节点变量快照\s*[:：]?|变量快照\s*[:：]?/g, '');
    }
    return t.trim();
}
function extractResult(s) {
    const raw = String(s);
    const m = raw.match(/<<<JX>>>\s*([\s\S]*?)<<<END>>>/);
    if (m) return m[1];
    const m2 = raw.match(/<<<JX>>>\s*([\s\S]*)/);
    if (m2) return String(m2[1]).split('<<<END>>>')[0];
    return null;
}

// ---------- 对话补全预设 ----------
let tavernPresets = null; // Map name -> content

async function loadTavernPresets() {
    if (tavernPresets) return tavernPresets;
    const res = await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({}), cache: 'no-cache' });
    if (!res.ok) throw new Error('读取酒馆设置失败（HTTP ' + res.status + '）');
    const data = await res.json();
    const names = data?.openai_setting_names ?? [];
    const contents = data?.openai_settings ?? [];
    tavernPresets = new Map();
    names.forEach((n, i) => tavernPresets.set(String(n), contents[i]));
    return tavernPresets;
}
function presetSummary() {
    const p = settings.presetJson;
    if (!p) return '未加载预设';
    const n = Array.isArray(p.prompts) ? p.prompts.length : 0;
    const pf = (p.assistant_prefill_enabled && p.assistant_prefill) ? '开' : '关';
    const wa = (p.whale_advisor && typeof p.whale_advisor === 'object') ? '｜含参谋模板覆盖' : '';
    return escapeHtml(String(settings.presetName || '（未命名）')) + '｜' + n + ' 条提示词｜assistant_prefill: ' + pf + wa;
}
function applyPresetTemplates(p) {
    const wa = p && p.whale_advisor;
    if (!wa || typeof wa !== 'object') return false;
    let applied = false;
    for (const key of ['sysPreset', 'askTemplate', 'refineTemplate']) {
        if (typeof wa[key] === 'string' && wa[key].trim()) {
            settings[key] = wa[key];
            applied = true;
        }
    }
    if (applied) saveSettingsDebounced();
    return applied;
}
function assemblePresetMessages(taskUserContent) {
    const p = settings.presetJson;
    const prompts = Array.isArray(p?.prompts) ? p.prompts : [];
    // 参谋元提示词永远放最前：预设只提供风格与解锁层，不顶替参谋身份
    const messages = [{ role: 'system', content: settings.sysPreset }];
    let order = null;
    if (Array.isArray(p?.prompt_order)) {
        const dummy = p.prompt_order.find((o) => o.character_id === 100001);
        order = (dummy || p.prompt_order[0])?.order;
    }
    const byId = new Map(prompts.map((e) => [e.identifier, e]));
    if (Array.isArray(order)) {
        for (const item of order) {
            if (!item?.enabled) continue;
            const e = byId.get(item.identifier);
            if (!e || e.marker || e.enabled === false || !e.content) continue;
            messages.push({ role: e.role || 'system', content: String(e.content) });
        }
    } else {
        // 无 prompt_order 的预设（外来文件常见）：按文件顺序取非 marker 条目
        for (const e of prompts) {
            if (e.marker || e.enabled === false || !e.content) continue;
            messages.push({ role: e.role || 'system', content: String(e.content) });
        }
    }
    // 合并连续 system，提高对各类端点的兼容性
    const merged = [];
    for (const m of messages) {
        const last = merged[merged.length - 1];
        if (m.role === 'system' && last && last.role === 'system') last.content += '\n\n' + m.content;
        else merged.push(m);
    }
    merged.push({ role: 'user', content: taskUserContent });
    return merged;
}
function activePrefill() {
    const p = settings.presetJson;
    if (p && p.assistant_prefill_enabled && p.assistant_prefill) return String(p.assistant_prefill);
    return settings.guideOutput ? '<<<JX>>>' : '';
}

// ---------- 生成 ----------
async function customChat(messages) {
    const base = (settings.custom.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('未配置自定义 API 地址（例如 https://api.xxx.com/v1）');
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = 'Bearer ' + settings.apiKey;
    const body = { messages };
    if (settings.custom.model) body.model = settings.custom.model;
    const p = settings.presetJson;
    if (p && typeof p.temperature === 'number') body.temperature = p.temperature;
    if (p && Number(p.openai_max_tokens) > 0) body.max_tokens = Number(p.openai_max_tokens);
    // 超时保护：端点挂起时中止，避免悬窗永久卡在"推演中"
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('请求超时（120 秒未响应）')), 120000);
    let res;
    try {
        res = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('请求超时（120 秒未响应）');
        throw new Error('请求失败（多为 CORS 拦截或网络不通）：' + (e && e.message ? e.message : e));
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) throw new Error('密钥无效或无权限（HTTP ' + res.status + '）');
        if (res.status === 404) throw new Error('路径不存在（HTTP 404）：确认地址以 /v1 结尾');
        throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 120));
    }
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content ?? '');
}

async function genChannel(userContent, opts = {}) {
    const prefill = opts.plain ? '' : activePrefill();
    let out;
    if (settings.channel === 'custom') {
        const msgs = settings.presetJson ? assemblePresetMessages(userContent) : [{ role: 'system', content: settings.sysPreset }, { role: 'user', content: userContent }];
        if (prefill) msgs.push({ role: 'assistant', content: prefill });
        out = await customChat(msgs);
    } else if (settings.presetJson) {
        out = await generateRaw({ prompt: assemblePresetMessages(userContent), prefill });
    } else {
        out = await generateRaw({ prompt: userContent, systemPrompt: settings.sysPreset, prefill });
    }
    // 续写类返回不含 prefill 本身，拼回去让 <<<JX>>>/<<<END>>> 配对提取生效；
    // 若模型没按格式输出，剥掉 prefill 前缀（如预设的 harukiTap），避免引导语泄进结果
    const combined = prefill ? prefill + String(out ?? '') : String(out ?? '');
    if (prefill && !extractResult(combined) && combined.startsWith(prefill)) {
        return combined.slice(prefill.length);
    }
    return combined;
}

async function callModel(userContent, opts = {}) {
    const attempt = async (extra) => {
        const raw = await genChannel(extra ? userContent + '\n\n' + extra : userContent, opts);
        const ex = extractResult(raw);
        return cleanModelOutput(ex == null ? raw : ex);
    };
    let out = await attempt('');
    if (out.length < 4 && !opts.plain) {
        out = await attempt('（刚才没有输出有效内容。现在必须按【输出格式】输出实际内容，禁止空白、禁止复述其它材料。）');
    }
    if (out.length < 4) throw new Error('生成结果清洗后仍为空（可尝试开启输出引导、换预设或换通道）');
    return out;
}

async function fetchModels() {
    const base = (settings.custom.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('先填接口地址');
    const headers = settings.apiKey ? { Authorization: 'Bearer ' + settings.apiKey } : {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
        res = await fetch(base + '/models', { headers, signal: ctrl.signal });
    } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('请求超时（15 秒）');
        throw new Error('请求失败（多为 CORS 拦截或网络不通）：' + (e && e.message ? e.message : e));
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new Error('密钥无效（HTTP ' + res.status + '）');
        if (res.status === 404) throw new Error('路径不存在（HTTP 404）：确认地址以 /v1 结尾');
        throw new Error('HTTP ' + res.status);
    }
    const d = await res.json();
    const list = Array.isArray(d?.data) ? d.data : (Array.isArray(d?.models) ? d.models : []);
    return list.map((m) => (typeof m === 'string' ? m : (m?.id || m?.name || ''))).filter(Boolean).map(String);
}

// ---------- 联网搜索 ----------
async function extractKeywords(text) {
    try {
        const p = '从下面的文本提取 2~3 个最适合搜索引擎查证的关键词（可中英文）。只输出关键词本身，用空格分隔，不要任何其它内容。\n\n文本：' + String(text).slice(0, 500);
        const out = await callModel(p, { plain: true });
        return out.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
    } catch (e) {
        return '';
    }
}
async function searxSearch(kw) {
    // 走酒馆服务端同源中继 /api/search/searxng（服务端出网抓 SearXNG），浏览器零跨域问题
    const res = await fetch('/api/search/searxng', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ baseUrl: (settings.web.searxUrl || '').replace(/\/+$/, ''), query: kw }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + '（服务端搜索中继失败，检查 SearXNG 地址与可用性）');
    const text = (await res.text()).trim();
    let results = [];
    if (text.startsWith('{') || text.startsWith('[')) {
        const d = JSON.parse(text);
        results = (d.results || []).map((r) => ({ title: r.title, content: r.content || r.snippet || '', url: r.url }));
    } else {
        // 服务端可能透传 SearXNG 的 HTML 结果页，按标准结构解析
        const doc = new DOMParser().parseFromString(text, 'text/html');
        results = Array.from(doc.querySelectorAll('article.result')).map((a) => {
            const link = a.querySelector('h3 a') || a.querySelector('a');
            return {
                title: (link?.textContent || '').trim(),
                url: link?.getAttribute('href') || '',
                content: (a.querySelector('.content')?.textContent || a.querySelector('p')?.textContent || '').trim(),
            };
        }).filter((r) => r.url);
        if (!results.length) results = Array.from(doc.querySelectorAll('a[href^="http"]')).slice(0, 20)
            .map((a) => ({ title: (a.textContent || '').trim(), url: a.getAttribute('href'), content: '' }))
            .filter((r) => r.title);
    }
    return results.slice(0, settings.web.results || 6);
}
async function tavilySearch(kw) {
    const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: settings.web.tavilyKey, query: kw, max_results: settings.web.results || 6 }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + '（检查 Tavily 密钥）');
    const d = await res.json();
    return (d.results || []).map((r) => ({ title: r.title, content: r.content || '', url: r.url }));
}
async function runSearch(kw) {
    try {
        const results = settings.web.backend === 'tavily' ? await tavilySearch(kw) : await searxSearch(kw);
        if (!results.length) return { block: '', note: '（搜索无结果，跳过联网）' };
        const block = '可参考的联网搜索资料（关键词：' + kw + '，注意时效与真伪）：\n' +
            results.map((r, i) => (i + 1) + '. ' + r.title + ' — ' + String(r.content || '').replace(/\s+/g, ' ').slice(0, 150) + '（' + r.url + '）').join('\n');
        return { block, note: '已联网「' + kw + '」' };
    } catch (e) {
        const msg = String((e && e.message) || e);
        return { block: '', note: '（联网搜索失败：' + msg.slice(0, 100) + '，已降级不搜索）' };
    }
}

async function searchGate(idea) {
    // 智能判断：由模型决定是否联网，需要则顺手给出关键词；判断不需要返回 null
    try {
        const p = '判断：完成下面的任务，是否需要联网搜索外部资料（实时行情、价格、新闻、政策、办理流程、技术资料等）才能明显提升质量？纯创作润色、剧情改写、日常对话、情感互动 → 不需要。\n规则：不需要就只输出 NO；需要就只输出 2~3 个搜索关键词（用空格分隔），不要任何其它内容。\n\n任务：' + String(idea).slice(0, 400);
        const out = await callModel(p, { plain: true });
        const t = out.trim();
        if (!t || /^no([\s。，,.!！]|$)/i.test(t)) return null;
        return t.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
    } catch (e) {
        return null;
    }
}

async function planSearch(idea, onProgress) {
    const mode = settings.web.mode || 'off';
    if (mode === 'off') return null;
    if (mode === 'trigger') {
        const t = String(idea).toLowerCase();
        if (!activeTriggers().some((w) => t.includes(w.toLowerCase()))) return null;
    }
    if (onProgress) onProgress('联网搜索中…');
    if (mode === 'auto') {
        const kw = await searchGate(idea);
        if (!kw) return { block: '', note: '（智能判断：本次无需联网）' };
        return await runSearch(kw);
    }
    const kw = await extractKeywords(idea);
    if (!kw) return { block: '', note: '（关键词提炼失败，跳过联网）' };
    return await runSearch(kw);
}

// ---------- 提示词 ----------
function renderTemplate(tpl, vars) {
    let s = String(tpl ?? '');
    for (const [k, v] of Object.entries(vars)) {
        s = s.split('{' + k + '}').join(v);
    }
    return s;
}
function buildTaskPrompt(kind, idea, searchBlock) {
    const tpl = kind === 'ask' ? settings.askTemplate : settings.refineTemplate;
    const body = renderTemplate(tpl, {
        '角色': charName(),
        '状态': stateLineText(),
        '剧情': recentStory(8),
        '想法': idea || '（无，请依据状态与剧情给建议）',
        '搜索': searchBlock ? '\n' + searchBlock + '\n' : '',
    });
    return body + OUTPUT_RULE;
}

// ---------- 发送 ----------
async function sendMessage(text) {
    const ta = document.querySelector('#send_textarea');
    const btn = document.querySelector('#send_but');
    if (!ta || !btn) return false;
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 草稿模式：只放入输入框，聚焦不发送
    if (settings.sendMode === 'draft') { ta.focus(); return 'draft'; }
    // 生成中酒馆的发送键变为「停止」，此时点按会误停生成——先检测停止按钮状态
    const stopBtn = document.querySelector('#mes_stop');
    if (stopBtn && stopBtn.style.display !== 'none') return 'busy';
    btn.click();
    return true;
}

// ---------- UI ----------
function init() {
    const btn = document.createElement('div');
    btn.id = 'wa-btn';
    btn.title = '参谋·鲸鲸（Alt+K）';
    btn.textContent = '🐋';
    btn.style.display = settings.showButton ? '' : 'none';

    const panel = document.createElement('div');
    panel.id = 'wa-panel';
    panel.innerHTML = [
        '<div class="wa-head" id="wa-drag">',
        '  <span class="wa-back" id="wa-back" style="display:none">◀ 返回</span>',
        '  <span class="wa-title"><span id="wa-title-text">参谋·鲸鲸</span><em>ADVISOR</em></span>',
        '  <span class="wa-head-right"><span class="wa-gear" id="wa-gear" title="快速设置">⚙️</span><span class="wa-close" id="wa-close">×</span></span>',
        '</div>',
        '<div class="wa-body" id="wa-view-main">',
        '  <div class="wa-state" id="wa-state">读取变量中…</div>',
        '  <textarea class="wa-ta" id="wa-input" rows="3" placeholder="把想法丢进来，比如：想自研大模型，对标旗舰。留空也可以直接问下一步。"></textarea>',
        '  <div class="wa-row">',
        '    <button class="wa-btn" id="wa-ask">🎯 问下一步</button>',
        '    <button class="wa-btn" id="wa-refine">✨ 帮我完善</button>',
        '    <button class="wa-btn" id="wa-clear" style="flex:0 0 44px;">清空</button>',
        '  </div>',
        '  <textarea class="wa-ta" id="wa-result" rows="6" placeholder="参谋的推演会落在这里，可随意编辑，点下面直接发出"></textarea>',
        '  <div id="wa-options" style="display:none;flex-direction:column;gap:6px;"></div>',
        '  <div class="wa-row" id="wa-send-row"><button class="wa-btn accent" id="wa-send">🚀 直接发送到剧情</button></div>',
        '  <div class="wa-status" id="wa-status">待机：Alt+K 唤起 · ⚙️ 快速设置</div>',
        '</div>',
        '<div class="wa-resize" id="wa-resize" title="拖动调整大小">⤡</div>',
        '<div class="wa-body" id="wa-view-quick" style="display:none">',
        '  <div class="wa-set-title">生成通道</div>',
        '  <div class="wa-row">',
        '    <label class="wa-radio"><input type="radio" name="wa-channel" data-wa-path="channel" data-wa-value="main"> 主 API</label>',
        '    <label class="wa-radio"><input type="radio" name="wa-channel" data-wa-path="channel" data-wa-value="custom"> 自定义 API</label>',
        '  </div>',
        '  <div data-wa-showfor="channel=custom">',
        '    <input class="wa-in" data-wa-path="custom.baseUrl" placeholder="接口地址，如 https://api.xxx.com/v1">',
        '    <div class="wa-row">',
        '      <input class="wa-in" data-wa-path="apiKey" type="password" placeholder="API 密钥（跟随账号保存）">',
        '      <button class="wa-btn" id="wa-quick-models" style="flex:0 0 64px;">拉模型</button>',
        '    </div>',
        '    <div class="wa-row">',
        '      <input class="wa-in" data-wa-path="custom.model" list="wa-model-list" placeholder="模型（可手填或拉取后选）">',
        '      <button class="wa-btn" id="wa-quick-test" style="flex:0 0 64px;">测试</button>',
        '    </div>',
        '    <div class="wa-status" id="wa-quick-test-result"></div>',
        '  </div>',
        '  <div class="wa-set-title">联网搜索</div>',
        '  <select class="wa-in" data-wa-path="web.mode"><option value="off">联网: 关</option><option value="trigger">联网: 触发词</option><option value="auto">联网: 智能判断</option><option value="always">联网: 每次都搜</option></select>',
        '  <div data-wa-showfor="web.mode=trigger,auto,always">',
        '    <select class="wa-in" data-wa-path="web.backend"><option value="searxng">SearXNG</option><option value="tavily">Tavily</option></select>',
        '    <div data-wa-showfor="web.backend=searxng">',
        '      <input class="wa-in" data-wa-path="web.searxUrl" placeholder="SearXNG 地址">',
        '    </div>',
        '    <div data-wa-showfor="web.backend=tavily">',
        '      <input class="wa-in" type="password" data-wa-path="web.tavilyKey" placeholder="Tavily API 密钥">',
        '    </div>',
        '    <div data-wa-showfor="web.mode=trigger">',
        '      <textarea class="wa-ta" rows="4" data-wa-path="web.triggers" placeholder="触发关键词，每行一个，可增删"></textarea>',
        '    </div>',
        '  </div>',
        '  <div class="wa-set-title">输出与发送</div>',
        '  <div class="wa-row">',
        '    <label class="wa-radio"><input type="checkbox" data-wa-path="guideOutput"> 输出引导</label>',
        '  </div>',
        '  <select class="wa-in" data-wa-path="sendMode"><option value="direct">发送：直接进剧情</option><option value="draft">发送：先放入输入框</option></select>',
        '</div>'
    ].join('\n');
    document.body.appendChild(btn);
    document.body.appendChild(panel);

    const datalist = document.createElement('datalist');
    datalist.id = 'wa-model-list';
    document.body.appendChild(datalist);

    const $id = (id) => document.getElementById(id);
    const stateEl = $id('wa-state'), inputEl = $id('wa-input'), resultEl = $id('wa-result'),
        statusEl = $id('wa-status'), askBtn = $id('wa-ask'), refineBtn = $id('wa-refine'),
        clearBtn = $id('wa-clear'), sendBtn = $id('wa-send'), sendRow = $id('wa-send-row'), closeBtn = $id('wa-close'),
        gearBtn = $id('wa-gear'), backBtn = $id('wa-back'),
        viewMain = $id('wa-view-main'), viewQuick = $id('wa-view-quick'),
        quickTestBtn = $id('wa-quick-test'), quickModelsBtn = $id('wa-quick-models'),
        quickTestResult = $id('wa-quick-test-result');

    function setStatus(text, cls) { statusEl.textContent = text; statusEl.className = 'wa-status' + (cls ? ' ' + cls : ''); }
    const optionsEl = $id('wa-options');

    // 「问下一步」的选项化：结果里以 - 开头的行逐条变成可点击发送的按钮；
    // 返回是否有选项（有选项时输出框与整段发送按钮收起，选项即出口）
    function renderOptions(text) {
        if (!optionsEl) return false;
        const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => /^[-•·]\s*/.test(l));
        if (!lines.length) { optionsEl.style.display = 'none'; optionsEl.innerHTML = ''; return false; }
        optionsEl.style.display = 'flex';
        optionsEl.innerHTML = '';
        lines.forEach((line) => {
            const opt = line.replace(/^[-•·]\s*/, '');
            const b = document.createElement('button');
            b.className = 'wa-chip';
            b.type = 'button';
            b.textContent = '🚀 ' + opt;
            b.addEventListener('click', async () => {
                setBusy(true);
                setStatus('发送选项中…');
                const sent = await sendMessage(opt);
                setBusy(false);
                if (sent === true) {
                    optionsEl.style.display = 'none';
                    optionsEl.innerHTML = '';
                    setStatus('已发送选项，鲸鲸处理中…', 'ok');
                } else if (sent === 'draft') {
                    setStatus('选项已放入输入框，可修改后手动发送', 'ok');
                } else if (sent === 'busy') {
                    setStatus('酒馆正在生成中，稍候再发（本次未发送）', 'err');
                } else {
                    setStatus('发送失败：找不到输入框', 'err');
                }
            });
            optionsEl.appendChild(b);
        });
        return true;
    }
    function updateTitle() {
        const el = $id('wa-title-text');
        if (el) el.textContent = '参谋·鲸鲸 · ' + charName();
    }
    // 跟随当前聊天：切换角色卡/群聊时实时更新标题
    try {
        const es = ctx()?.eventSource;
        es?.on?.('CHAT_CHANGED', updateTitle);
    } catch (e) {}
    updateTitle();
    function refreshState() { stateEl.textContent = stateLineText(); }
    function setBusy(busy) { [askBtn, refineBtn, clearBtn, sendBtn].forEach((b) => { b.disabled = busy; }); }
    function showView(quick) {
        viewQuick.style.display = quick ? '' : 'none';
        viewMain.style.display = quick ? 'none' : '';
        backBtn.style.display = quick ? '' : 'none';
        if (quick) refreshState();
    }
    gearBtn.addEventListener('click', () => showView(viewQuick.style.display === 'none'));
    backBtn.addEventListener('click', () => showView(false));

    // ---------- 位置记忆与拖动 ----------
    function clampIntoView(el) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return; // 未渲染时量不到尺寸，跳过
        const maxX = Math.max(0, window.innerWidth - r.width);
        const maxY = Math.max(0, window.innerHeight - r.height);
        el.style.left = Math.min(Math.max(0, parseFloat(el.style.left) || 0), maxX) + 'px';
        el.style.top = Math.min(Math.max(0, parseFloat(el.style.top) || 0), maxY) + 'px';
    }
    function savePos(el, key) { try { localStorage.setItem(key, JSON.stringify({ l: el.style.left, t: el.style.top })); } catch (e) {} }
    function loadPos(el, key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return false;
            const p = JSON.parse(raw);
            if (p.l && p.t) { el.style.left = p.l; el.style.top = p.t; return true; }
        } catch (e) {}
        return false;
    }
    // 参照桌面宠物扩展的定位模式：位置全部 JS 计算（left/top），不用 CSS right/bottom；
    // 桌面/手机 UI 模式切换（不改窗口大小）也通过 MutationObserver 重新锚定到右下角
    const coarseMQ = window.matchMedia('(pointer: coarse)');
    function isCoarseNow() { return coarseMQ.matches || window.innerWidth <= 768; }
    function defaultBtnPos() {
        return { l: Math.max(8, window.innerWidth - 54), t: Math.max(8, window.innerHeight - (isCoarseNow() ? 138 : 64)) };
    }
    function applyBtnPos() {
        if (!loadPos(btn, 'wa-pos-btn')) {
            const d = defaultBtnPos();
            btn.style.left = d.l + 'px'; btn.style.top = d.t + 'px';
        } else {
            clampIntoView(btn);
        }
    }
    function onLayoutChange() {
        applyBtnPos();
        if (panel.classList.contains('open')) clampIntoView(panel);
    }
    function placePanelDefault() {
        // 面板可见后按按钮位置计算默认落点（右对齐、在按钮上方；放不下则按钮下方）
        requestAnimationFrame(() => {
            const pr = panel.getBoundingClientRect();
            const br = btn.getBoundingClientRect();
            let l = Math.max(8, Math.min(window.innerWidth - pr.width - 12, br.right - pr.width));
            let t = br.top - pr.height - 12;
            if (t < 8) t = Math.min(window.innerHeight - pr.height - 8, br.bottom + 12);
            panel.style.left = Math.max(8, l) + 'px';
            panel.style.top = Math.max(8, t) + 'px';
        });
    }
    function placePanel() {
        if (!loadPos(panel, 'wa-pos-panel')) placePanelDefault();
        else requestAnimationFrame(() => clampIntoView(panel));
    }
    // 面板尺寸：右下角把手拖拽，宽高可调并记忆
    function loadPanelSize() {
        try {
            const raw = localStorage.getItem('wa-size-panel');
            if (!raw) return;
            const s = JSON.parse(raw);
            if (s.w && s.h) applyPanelSize(s.w, s.h);
        } catch (e) {}
    }
    function applyPanelSize(w, h) {
        const mw = Math.max(240, window.innerWidth - 16);
        const mh = Math.max(180, window.innerHeight - 24);
        panel.style.width = Math.min(w, mw) + 'px';
        panel.style.height = Math.min(h, mh) + 'px';
        const body = panel.querySelector('.wa-body');
        if (body) body.style.maxHeight = 'none'; // 固定高度下由面板自身滚动
    }
    function makeResizable(handle) {
        let sx = 0, sy = 0, sw = 0, sh = 0, sizing = false;
        handle.addEventListener('pointerdown', (e) => {
            sizing = true; sx = e.clientX; sy = e.clientY;
            const r = panel.getBoundingClientRect();
            sw = r.width; sh = r.height;
            e.preventDefault(); e.stopPropagation();
        });
        document.addEventListener('pointermove', (e) => {
            if (!sizing) return;
            applyPanelSize(sw + e.clientX - sx, sh + e.clientY - sy);
        });
        document.addEventListener('pointerup', () => {
            if (!sizing) return;
            sizing = false;
            try { localStorage.setItem('wa-size-panel', JSON.stringify({ w: panel.style.width, h: panel.style.height })); } catch (err) {}
        });
    }
    function resetPos() {
        try { localStorage.removeItem('wa-pos-btn'); localStorage.removeItem('wa-pos-panel'); localStorage.removeItem('wa-size-panel'); } catch (e) {}
        panel.style.left = ''; panel.style.top = '';
        panel.style.width = ''; panel.style.height = '';
        const pbody = panel.querySelector('.wa-body');
        if (pbody) pbody.style.maxHeight = '';
        const d = defaultBtnPos();
        btn.style.left = d.l + 'px'; btn.style.top = d.t + 'px';
    }
    applyBtnPos();
    window.addEventListener('resize', onLayoutChange);
    coarseMQ.addEventListener?.('change', onLayoutChange);
    // ST 桌面/手机 UI 模式切换会改 html/body 的类与样式：监听并重新锚定（去抖 120ms）
    const layoutMO = new MutationObserver(() => {
        clearTimeout(layoutMO._t);
        layoutMO._t = setTimeout(onLayoutChange, 120);
    });
    layoutMO.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    layoutMO.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
    function makeDraggable(handle, target, key) {
        let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false;
        const down = (x, y) => {
            dragging = true; moved = false; sx = x; sy = y;
            const r = target.getBoundingClientRect();
            target.style.right = 'auto'; target.style.bottom = 'auto';
            target.style.left = r.left + 'px'; target.style.top = r.top + 'px';
            ox = r.left; oy = r.top;
        };
        const move = (x, y) => {
            if (!dragging) return;
            if (Math.abs(x - sx) + Math.abs(y - sy) > 4) moved = true;
            target.style.left = Math.max(0, ox + x - sx) + 'px';
            target.style.top = Math.max(0, oy + y - sy) + 'px';
        };
        const up = () => { if (dragging) { dragging = false; clampIntoView(target); savePos(target, key); } };
        // Pointer Events：鼠标与触屏统一；touch-action:none 由 CSS 提供
        handle.addEventListener('pointerdown', (e) => { down(e.clientX, e.clientY); e.preventDefault(); });
        document.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
        document.addEventListener('pointerup', up);
        document.addEventListener('pointercancel', up);
        return () => moved;
    }
    const btnDragged = makeDraggable(btn, btn, 'wa-pos-btn');
    makeDraggable($id('wa-drag'), panel, 'wa-pos-panel');
    makeResizable($id('wa-resize'));
    loadPanelSize();

    btn.addEventListener('click', () => {
        if (btnDragged()) return;
        const open = panel.classList.toggle('open');
        if (open) { showView(false); updateTitle(); refreshState(); placePanel(); setStatus('待机：Alt+K 唤起 · ⚙️ 快速设置'); }
    });
    closeBtn.addEventListener('click', () => panel.classList.remove('open'));
    document.addEventListener('keydown', (e) => {
        // 用物理键位 e.code 判断：macOS 上 Option+K 的 e.key 是特殊字符"˚"，用 e.key 会永远不命中
        if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyK') {
            e.preventDefault();
            if (panel.classList.contains('open')) { panel.classList.remove('open'); }
            else { panel.classList.add('open'); showView(false); updateTitle(); refreshState(); placePanel(); setStatus('待机'); }
        }
    }, true);

    // ---------- 设置绑定（双视图同步） ----------
    function syncAll(except) {
        if (sendBtn) sendBtn.textContent = settings.sendMode === 'draft' ? '📝 放入输入框' : '🚀 直接发送到剧情';
        document.querySelectorAll('[data-wa-path]').forEach((el) => {
            if (el === except) return;
            if (el.type === 'radio') return;
            const v = getPath(settings, el.dataset.waPath);
            if (el.type === 'checkbox') el.checked = !!v;
            else if (el.value !== String(v ?? '')) el.value = v ?? '';
        });
        document.querySelectorAll('input[type="radio"][data-wa-value]').forEach((el) => {
            el.checked = getPath(settings, el.dataset.waPath) === el.dataset.waValue;
        });
        document.querySelectorAll('[data-wa-showfor]').forEach((el) => {
            const [path, vals] = String(el.dataset.waShowfor).split('=');
            const list = String(vals || '').split(',');
            el.style.display = list.includes(String(getPath(settings, path))) ? '' : 'none';
        });
    }
    function bindSettingControls() {
        document.querySelectorAll('[data-wa-path]').forEach((el) => {
            if (el.dataset.waBound) return;
            el.dataset.waBound = '1';
            const ev = (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT') ? 'change' : 'input';
            el.addEventListener(ev, () => {
                if (el.type === 'checkbox') setPath(settings, el.dataset.waPath, el.checked);
                else if (el.type === 'radio') setPath(settings, el.dataset.waPath, el.dataset.waValue);
                else if (el.type === 'number') {
                    const n = Number(el.value);
                    setPath(settings, el.dataset.waPath, isFinite(n) && n > 0 ? Math.round(n) : (getPath(settings, el.dataset.waPath) || 6));
                }
                else setPath(settings, el.dataset.waPath, el.value);
                saveSettingsDebounced();
                syncAll(el);
            });
        });
        syncAll();
    }
    bindSettingControls();

    async function testConnection(resultElx) {
        resultElx.textContent = '测试中…';
        const t0 = performance.now();
        try {
            const base = (settings.custom.baseUrl || '').trim().replace(/\/+$/, '');
            const headers = { 'Content-Type': 'application/json' };
            if (settings.apiKey) headers.Authorization = 'Bearer ' + settings.apiKey;
            const payload = { messages: [{ role: 'user', content: '只回复两个字：正常' }] };
            if (settings.custom.model) payload.model = settings.custom.model; // 部分网关无 model 直接 400
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20000);
            let res;
            try {
                res = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
            } catch (e) {
                throw (e && e.name === 'AbortError') ? new Error('超时（20 秒）') : e;
            } finally {
                clearTimeout(timer);
            }
            const ms = Math.round(performance.now() - t0);
            if (!res.ok) {
                if (res.status === 401 || res.status === 403) throw new Error('密钥无效（HTTP ' + res.status + '）');
                if (res.status === 404) throw new Error('路径不存在（HTTP 404）：确认地址以 /v1 结尾');
                throw new Error('HTTP ' + res.status);
            }
            const d = await res.json();
            const reply = String(d?.choices?.[0]?.message?.content ?? '').trim();
            resultElx.textContent = '✓ ' + ms + 'ms：' + (reply.slice(0, 40) || '（空回复）');
        } catch (e) {
            const msg = String((e && e.message) || e);
            resultElx.textContent = /Failed to fetch|NetworkError|load failed/i.test(msg)
                ? '✗ 浏览器 CORS/网络拦截：该端点需允许跨域，或改走主 API 通道'
                : '✗ ' + msg;
        }
    }
    quickTestBtn?.addEventListener('click', () => testConnection(quickTestResult));

    quickModelsBtn?.addEventListener('click', async () => {
        quickTestResult.textContent = '拉取模型中…';
        try {
            const ids = await fetchModels();
            datalist.innerHTML = ids.map((m) => '<option value="' + escapeHtml(m) + '">').join('');
            if (!settings.custom.model && ids.length) {
                settings.custom.model = ids[0];
                saveSettingsDebounced();
                syncAll();
            }
            quickTestResult.textContent = '✓ 已拉取 ' + ids.length + ' 个模型';
        } catch (e) {
            quickTestResult.textContent = '✗ ' + String((e && e.message) || e);
        }
    });

    // ---------- 主流程 ----------
    async function runAction(kind) {
        const idea = inputEl.value.trim();
        if (kind === 'refine' && !idea) { setStatus('先在上面输入框里写点想法，再来完善', 'err'); return; }
        setBusy(true);
        let searchNote = '';
        try {
            let searchBlock = '';
            const sr = await planSearch(kind === 'ask' ? (idea || stateLineText()) : idea, setStatus);
            if (sr) {
                searchBlock = sr.block;
                searchNote = sr.note;
            }
            setStatus('推演中：' + (settings.channel === 'custom' ? '自定义 API' : '主 API') + (settings.presetJson ? ' + 预设「' + settings.presetName + '」' : '') + '…');
            const out = await callModel(buildTaskPrompt(kind, idea, searchBlock));
            resultEl.value = out;
            const hasOpts = renderOptions(out);
            // 问下一步且解析出选项：输出框与整段发送按钮收起，选项按钮即出口；完善想法：显示输出框编辑
            const collapse = kind === 'ask' && hasOpts;
            resultEl.style.display = collapse ? 'none' : '';
            sendRow.style.display = collapse ? 'none' : '';
            refreshState();
            setStatus('推演完成，可直接编辑发送。' + searchNote, searchNote ? '' : 'ok');
        } catch (err) {
            setStatus('失败：' + (err && err.message ? err.message : err) + (searchNote ? ' ｜ ' + searchNote : ''), 'err');
        } finally {
            setBusy(false);
        }
    }
    askBtn.addEventListener('click', () => runAction('ask'));
    refineBtn.addEventListener('click', () => runAction('refine'));
    clearBtn.addEventListener('click', () => {
        inputEl.value = ''; resultEl.value = '';
        renderOptions('');
        resultEl.style.display = ''; sendRow.style.display = '';
        setStatus('已清空'); refreshState();
    });
    sendBtn.addEventListener('click', async () => {
        const text = (resultEl.value.trim() || inputEl.value.trim());
        if (!text) { setStatus('没有可发送的内容', 'err'); return; }
        setBusy(true);
        setStatus('发送中…');
        const sent = await sendMessage(text);
        setBusy(false);
        if (sent === true) {
            inputEl.value = ''; resultEl.value = '';
            renderOptions('');
            resultEl.style.display = ''; sendRow.style.display = '';
            setStatus('已发送，等回复中…', 'ok');
        } else if (sent === 'draft') {
            setStatus('已放入输入框，可修改后手动发送', 'ok');
        } else if (sent === 'busy') {
            setStatus('酒馆正在生成中，稍候再发（本次未发送）', 'err');
        } else {
            setStatus('发送失败：找不到输入框（#send_textarea / #send_but）', 'err');
        }
    });

    // ---------- 扩展面板（完整配置） ----------
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (target) {
        target.insertAdjacentHTML('beforeend', [
            '<div id="whale-advisor-settings">',
            '  <div class="inline-drawer">',
            '    <div class="inline-drawer-toggle inline-drawer-header">',
            '      <b>🐋 参谋·鲸鲸</b>',
            '      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>',
            '    </div>',
            '    <div class="inline-drawer-content">',
            '      <div class="wa-set-title">对话补全预设（防不输出）</div>',
            '      <div class="wa-row">',
            '        <select class="text_input" style="flex:1" id="wa-preset-select"><option value="">— 从酒馆预设列表选择 —</option></select>',
            '      </div>',
            '      <div class="wa-row" style="margin-top:4px;">',
            '        <label class="wa-mbtn" style="flex:1;text-align:center;">上传 JSON 预设<input type="file" id="wa-preset-file" accept=".json,application/json" style="display:none"></label>',
            '        <button class="wa-mbtn" id="wa-preset-clear">清除预设</button>',
            '      </div>',
            '      <div class="wa-status" id="wa-preset-info"></div>',
            '      <div class="wa-set-title">预设内容（可编辑）</div>',
            '      <div id="wa-preset-entries"><div class="wa-note">未加载预设</div></div>',
            '      <div class="wa-set-title">参谋提示词模板</div>',
            '      <div class="wa-note">系统预设（始终注入在消息最前：加载预设时与预设条目合并，未加载时单独作为 system）。预设 JSON 带 whale_advisor 字段（sysPreset / askTemplate / refineTemplate）时，加载即覆盖下面三段模板</div>',
            '      <textarea class="text_input" style="width:100%" rows="3" data-wa-path="sysPreset"></textarea>',
            '      <div class="wa-note">问下一步模板</div>',
            '      <textarea class="text_input" style="width:100%" rows="6" data-wa-path="askTemplate"></textarea>',
            '      <div class="wa-note">帮我完善模板</div>',
            '      <textarea class="text_input" style="width:100%" rows="6" data-wa-path="refineTemplate"></textarea>',
            '      <div class="wa-row" style="margin-top:4px;">',
            '        <button class="wa-mbtn" id="wa-tpl-reset">恢复全部默认模板</button>',
            '      </div>',
            '      <div class="wa-set-title">联网搜索细项</div>',
            '      <div class="wa-note">联网模式、后端、地址与触发关键词在悬窗 ⚙️ 快速设置里配置</div>',
            '      <div class="wa-row" style="margin-top:4px;">',
            '        <span class="wa-note">结果条数</span><input class="text_input" style="width:60px" type="number" min="1" max="15" data-wa-path="web.results" data-num="1">',
            '        <button class="wa-mbtn" id="wa-p-searchtest">测试搜索</button>',
            '      </div>',
            '      <div class="wa-status" id="wa-p-searchtest-result"></div>',
            '      <div class="wa-set-title">通用</div>',
            '      <label class="checkbox_label"><input type="checkbox" id="wa-show-cb" ' + (settings.showButton ? 'checked' : '') + '><span>显示悬浮按钮</span></label>',
            '      <div class="wa-row" style="margin-top:4px;">',
            '        <button class="wa-mbtn" id="wa-reset-pos">重置窗口位置（含尺寸）</button>',
            '      </div>',
            '      <div class="wa-note">生成走 SillyTavern 核心 generateRaw（纯净通道）或自定义 API；日常操作在右下角悬窗 ⚙️，快捷键 Alt+K。</div>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('\n'));

        const q = (sel) => document.querySelector('#whale-advisor-settings ' + sel);
        q('#wa-show-cb')?.addEventListener('change', (e) => {
            settings.showButton = !!e.target.checked;
            btn.style.display = settings.showButton ? '' : 'none';
            saveSettingsDebounced();
        });
        q('#wa-reset-pos')?.addEventListener('click', resetPos);

        // 预设
        const presetSelect = q('#wa-preset-select');
        const presetInfo = q('#wa-preset-info');
        function applyAndShowTemplates(source) {
            const applied = applyPresetTemplates(source);
            // 直接写入三个模板框，不依赖间接同步；改完后随时可编辑
            for (const k of ['sysPreset', 'askTemplate', 'refineTemplate']) {
                const el = q('[data-wa-path="' + k + '"]');
                if (el) el.value = settings[k];
            }
            return applied;
        }
        function refreshPresetInfo(extra) { presetInfo.textContent = presetSummary() + (extra ? ' ｜ ' + extra : ''); }

        // 预设本体条目：把实际生效的提示词逐条渲染成可编辑文本域（写入 presetJson 即时生效）
        function renderPresetEntries() {
            const box = q('#wa-preset-entries');
            if (!box) return;
            const p = settings.presetJson;
            const prompts = Array.isArray(p?.prompts) ? p.prompts : [];
            if (!prompts.length) { box.innerHTML = '<div class="wa-note">未加载预设</div>'; return; }
            let order = null;
            if (Array.isArray(p?.prompt_order)) {
                const dummy = p.prompt_order.find((o) => o.character_id === 100001);
                order = (dummy || p.prompt_order[0])?.order;
            }
            let entries;
            if (Array.isArray(order)) {
                const byId = new Map(prompts.map((e) => [e.identifier, e]));
                entries = [];
                for (const item of order) {
                    if (!item?.enabled) continue;
                    const e = byId.get(item.identifier);
                    if (!e || e.marker || e.enabled === false || !e.content) continue;
                    entries.push(e);
                }
            } else {
                entries = prompts.filter((e) => !e.marker && e.enabled !== false && e.content);
            }
            box.innerHTML = '';
            if (!entries.length) { box.innerHTML = '<div class="wa-note">该预设没有生效中的提示词条目</div>'; return; }
            entries.forEach((e, idx) => {
                const ENTRY_ZH = { main: '主提示词', jailbreak: '越狱', nsfw: '成人', enhanceDefinitions: '定义增强' };
                const NAME_ZH = { 'Main Prompt': '主提示词', 'Jailbreak Prompt': '越狱' };
                const zhName = ENTRY_ZH[e.identifier] || NAME_ZH[e.name] || e.name || e.identifier;
                const zhRole = { system: '系统', user: '用户', assistant: '助手' }[e.role || 'system'] || e.role;
                const wrap = document.createElement('div');
                wrap.className = 'wa-pe';
                const head = document.createElement('div');
                head.className = 'wa-pe-head';
                head.textContent = (idx + 1) + '. ' + zhName + ' · ' + zhRole;
                const ta = document.createElement('textarea');
                ta.className = 'text_input';
                ta.style.width = '100%';
                ta.rows = 3;
                ta.value = String(e.content);
                ta.addEventListener('input', () => { e.content = ta.value; saveSettingsDebounced(); });
                wrap.appendChild(head);
                wrap.appendChild(ta);
                box.appendChild(wrap);
            });
        }
        loadTavernPresets().then((map) => {
            const opts = ['<option value="">— 从酒馆预设列表选择 —</option>'];
            for (const name of map.keys()) opts.push('<option value="' + escapeHtml(name) + '">' + escapeHtml(name) + '</option>');
            presetSelect.innerHTML = opts.join('');
            if (settings.presetName && map.has(settings.presetName)) presetSelect.value = settings.presetName;
        }).catch((e) => { presetInfo.textContent = '预设列表读取失败：' + String((e && e.message) || e); });
        presetSelect?.addEventListener('change', () => {
            const name = presetSelect.value;
            if (!name) return;
            const content = tavernPresets?.get(name);
            if (!content) return;
            settings.presetName = name;
            settings.presetJson = content;
                    const applied = applyAndShowTemplates(content);
                    saveSettingsDebounced();
                    refreshPresetInfo(applied ? '✓ 预设的参谋模板已填入下方三框，可继续编辑' : '预设不含 whale_advisor 模板，三框保持当前值');
                    renderPresetEntries();
        });
        q('#wa-preset-file')?.addEventListener('change', (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const obj = JSON.parse(String(reader.result));
                    settings.presetJson = obj;
                    settings.presetName = f.name.replace(/\.json$/i, '');
                    const applied = applyAndShowTemplates(obj);
                    saveSettingsDebounced();
                    refreshPresetInfo(applied ? '✓ 预设的参谋模板已填入下方三框，可继续编辑' : '预设不含 whale_advisor 模板，三框保持当前值');
                    renderPresetEntries();
                } catch (err) {
                    presetInfo.textContent = '✗ JSON 解析失败：' + String((err && err.message) || err);
                }
            };
            reader.readAsText(f);
        });
        q('#wa-preset-clear')?.addEventListener('click', () => {
            settings.presetJson = null;
            settings.presetName = '';
            saveSettingsDebounced();
            if (presetSelect) presetSelect.value = '';
            refreshPresetInfo();
            renderPresetEntries();
        });
        refreshPresetInfo();
        renderPresetEntries();

        // 模板恢复默认
        q('#wa-tpl-reset')?.addEventListener('click', () => {
            settings.sysPreset = DEFAULT_SYS;
            settings.askTemplate = DEFAULT_ASK;
            settings.refineTemplate = DEFAULT_REFINE;
            saveSettingsDebounced();
            syncAll();
        });

        // 测试搜索
        q('#wa-p-searchtest')?.addEventListener('click', async () => {
            const r = q('#wa-p-searchtest-result');
            r.textContent = '搜索中…';
            const t0 = performance.now();
            try {
                const results = settings.web.backend === 'tavily' ? await tavilySearch('SillyTavern') : await searxSearch('SillyTavern');
                r.textContent = '✓ ' + Math.round(performance.now() - t0) + 'ms，返回 ' + results.length + ' 条';
            } catch (e) {
                const msg = String((e && e.message) || e);
                r.textContent = '✗ ' + msg;
            }
        });
        bindSettingControls();
    }
}

if (!document.getElementById('wa-btn')) {
    init();
}
