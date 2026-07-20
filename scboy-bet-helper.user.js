// ==UserScript==
// @name         SCBOY 二楼竞猜 · LLM 智能辅助
// @namespace    https://github.com/Dddota/scboy-2floor
// @version      0.3.0
// @description  用大模型分析 SCBOY 二楼竞猜盘口，给出 Half-Kelly 建议下注金额，支持一键填入/下注；列表页市场信息徽章；二选一 / 三选一 / 四选一均支持。
// @author       Dddota (By OpenCode)
// @homepageURL  https://github.com/Dddota/scboy-2floor
// @supportURL   https://github.com/Dddota/scboy-2floor/issues
// @updateURL    https://raw.githubusercontent.com/Dddota/scboy-2floor/main/scboy-bet-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Dddota/scboy-2floor/main/scboy-bet-helper.user.js
// @license      MIT
// @icon         https://www.scboy.cc/view/img/logo.png
// @match        https://www.scboy.cc/*
// @match        https://scboy.cc/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      liquipedia.net
// @connect      api.openai.com
// @connect      api.deepseek.com
// @connect      openrouter.ai
// @connect      api.moonshot.ai
// @connect      api.moonshot.cn
// @connect      generativelanguage.googleapis.com
// @connect      dashscope.aliyuncs.com
// @connect      dashscope-intl.aliyuncs.com
// @connect      ark.cn-beijing.volces.com
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* eslint-disable no-multi-spaces */
(function () {
  'use strict';

  // ============================================================
  // 常量与配置
  // ============================================================
  const LOG_PREFIX = '[SCBOY-Bet]';
  const CONFIG_KEYS = {
    baseUrl:      'cfg.baseUrl',
    apiKey:       'cfg.apiKey',
    model:        'cfg.model',
    temperature:  'cfg.temperature',
    kellyFrac:    'cfg.kellyFrac',      // 凯利折扣，默认 0.5 = Half-Kelly
    minEV:        'cfg.minEV',           // 最小期望值阈值 (EV/单位下注)，低于则不推荐
    maxStakePct:  'cfg.maxStakePct',    // 单笔上限占余额百分比
    minStake:     'cfg.minStake',        // 硬下限
    maxStake:     'cfg.maxStake',        // 硬上限
    listAutoScan: 'cfg.listAutoScan',    // 列表页是否自动扫描（默认关）
    debug:        'cfg.debug',
    // v0.3.0 稳赢-回本模式
    safeMode:            'cfg.safeMode',            // 是否启用稳赢模式（贝叶斯收缩+效应门槛）
    allowLongshot:       'cfg.allowLongshot',       // 是否允许冷门博（小仓位）
    pFinalSafe:          'cfg.pFinalSafe',          // 主推荐所需最低混合胜率
    longshotEvMul:       'cfg.longshotEvMul',       // 冷门 EV 门槛倍数（相对 minEV）
    longshotStakeMul:    'cfg.longshotStakeMul',    // 冷门 Kelly 打折系数
    longshotBalanceCap:  'cfg.longshotBalanceCap'   // 冷门单笔余额上限
  };

  const DEFAULTS = {
    [CONFIG_KEYS.baseUrl]:     'https://api.deepseek.com',
    [CONFIG_KEYS.apiKey]:      '',
    [CONFIG_KEYS.model]:       'deepseek-v4-flash',
    [CONFIG_KEYS.temperature]: 0.2,
    [CONFIG_KEYS.kellyFrac]:   0.5,
    [CONFIG_KEYS.minEV]:       0.05,
    [CONFIG_KEYS.maxStakePct]: 0.15,   // 单笔最多用 15% 余额
    [CONFIG_KEYS.minStake]:    100,
    [CONFIG_KEYS.maxStake]:    10000,
    [CONFIG_KEYS.listAutoScan]: false, // 默认关，用菜单打开
    [CONFIG_KEYS.debug]:       false,
    // v0.3.0 稳赢-回本模式
    [CONFIG_KEYS.safeMode]:            true,
    [CONFIG_KEYS.allowLongshot]:       true,
    [CONFIG_KEYS.pFinalSafe]:          0.55,
    [CONFIG_KEYS.longshotEvMul]:       2.0,
    [CONFIG_KEYS.longshotStakeMul]:    0.3,
    [CONFIG_KEYS.longshotBalanceCap]:  0.05
  };

  function cfg(key)          { const v = GM_getValue(key, undefined); return v === undefined ? DEFAULTS[key] : v; }
  function setCfg(key, val)  { GM_setValue(key, val); }
  function log(...args)      { if (cfg(CONFIG_KEYS.debug)) console.log(LOG_PREFIX, ...args); }
  function info(...args)     { console.log(LOG_PREFIX, ...args); }   // 不受 debug 开关控制
  function warn(...args)     { console.warn(LOG_PREFIX, ...args); }
  function err(...args)      { console.error(LOG_PREFIX, ...args); }

  // ============================================================
  // 服务商预设（OpenAI 兼容）
  // ============================================================
  const PROVIDERS = [
    {
      id: 'deepseek', name: 'DeepSeek（深度求索，V4）',
      baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    note: '国内快、便宜，性价比首选。v4-flash 最省钱；v4-pro 更强。'
    },
    {
      id: 'qwen', name: '阿里千问 Qwen（DashScope，国内）',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-max'],
      note: 'plus 平衡；max 旗舰；turbo 便宜。国内直连快。'
    },
    {
      id: 'qwen-intl', name: '阿里千问 Qwen（国际版）',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
      note: '海外/香港节点用此。'
    },
    {
      id: 'volc-ark', name: '字节方舟 Doubao（火山引擎）',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115', 'ep-你的接入点ID'],
      note: '⚠️ 必须先在方舟控制台【模型广场】开通对应模型，或【在线推理】创建接入点。否则第一次调用会 404 / 403。'
    },
    {
      id: 'kimi', name: 'Kimi 月之暗面',
      baseUrl: 'https://api.moonshot.ai/v1',
      models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code'],
      note: '国内可选，长上下文强。⚠️ 官方最新域名是 api.moonshot.ai；旧的 api.moonshot.cn 目前仍可用于国内 key。⚠️ kimi-k3 强制 temperature=1.0，会覆盖脚本设置。'
    },
    {
      id: 'openai', name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
      note: '国内需自备网络。'
    },
    {
      id: 'openrouter', name: 'OpenRouter（聚合）',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [
        'openai/gpt-4o', 'anthropic/claude-sonnet-4.6',
        'google/gemini-2.5-pro', 'google/gemini-2.5-flash:online'
      ],
      note: '一 key 用全家桶；带 :online 后缀模型可联网搜索。'
    },
    {
      id: 'ollama', name: '本地 Ollama',
      baseUrl: 'http://localhost:11434/v1',
      models: ['qwen2.5:32b', 'deepseek-r1:14b', 'llama3.1:70b'],
      note: 'api_key 随便填 "ollama" 即可。'
    },
    {
      id: 'copilot-proxy', name: 'GitHub Copilot（本地代理 ericc-ch/copilot-api）',
      baseUrl: 'http://localhost:4141/v1',
      models: ['gpt-4o', 'claude-sonnet-4.5', 'gemini-2.5-pro'],
      note: '需先本地启动：npx copilot-api@latest start。首次会弹 GitHub 登录。api_key 随便填任意字符串。详情见 README。'
    },
    {
      id: 'custom', name: '自定义（手动填写）',
      baseUrl: '', models: [], note: '任何 OpenAI 兼容 /chat/completions 接口都行。'
    }
  ];

  // ============================================================
  // 工具：GM_xmlhttpRequest 封装成 Promise，避开 CORS
  // ============================================================
  function gmFetch(options) {
    return new Promise((resolve, reject) => {
      const timeout = options.timeout || 60000;
      GM_xmlhttpRequest({
        method:  options.method || 'GET',
        url:     options.url,
        headers: options.headers || {},
        data:    options.body,
        timeout,
        responseType: options.responseType || undefined,
        onload:      r => resolve({ status: r.status, headers: r.responseHeaders, text: r.responseText, finalUrl: r.finalUrl }),
        onerror:     e => reject(new Error('Network error: ' + (e && e.error || 'unknown'))),
        ontimeout:   () => reject(new Error('Request timeout after ' + timeout + 'ms')),
        onabort:     () => reject(new Error('Request aborted'))
      });
    });
  }

  // ============================================================
  // 详情页解析
  // ============================================================
  const RE_ODDS      = /赔率[：:]\s*1\s*[:：]\s*([\d.]+)/;
  const RE_POOL      = /金币[：:]\s*([\d.]+)/;
  const RE_BALANCE   = /当前有\s*([\d,]+)\s*金币/;
  const RE_LIQUIPEDIA = /https?:\/\/liquipedia\.net\/[^\s<"']+/i;
  const RE_TITLE_TAG = /^\s*(\[[^\]]+\])\s*/;

  /** 判断当前页面是不是竞猜详情页 */
  function isDetailPage() {
    return /[?&]bet-detail-\d+/.test(location.search) && !!document.querySelector('#choices form#form');
  }

  /**
   * 从详情页 DOM 抽出结构化信息
   * @param {Document} [docOverride] 传入外部抓取到的 Document（用于列表页后台抓详情）。
   *        不传则使用当前页面。传入时不会返回 DOM 交互引用（radioEl/goldInput/submitBtn 为 null）。
   * @returns {{
   *   title: string, category: string, description: string, liquipediaUrl: string|null,
   *   totalPool: number, balance: number,
   *   choices: Array<{value:string, name:string, odds:number, pool:number, radioEl:HTMLInputElement|null, labelEl:HTMLElement|null}>,
   *   goldInput: HTMLInputElement|null, submitBtn: HTMLElement|null,
   *   alreadyBet: boolean
   * } | null}
   */
  function parseDetail(docOverride) {
    const doc = docOverride || document;
    const isCurrent = !docOverride;
    const form = doc.querySelector('#choices form#form');
    if (!form) return null;

    // 标题 + 分类：从页面顶部面包屑或标题区抓，退回 <title>
    const rawTitle = (doc.querySelector('.card-header, h1, h2, h3, .subject') || doc.body).textContent || doc.title || '';
    const cleaned = rawTitle.replace(/\s+/g, ' ').trim().slice(0, 200);
    const categoryMatch = cleaned.match(RE_TITLE_TAG);
    const category = categoryMatch ? categoryMatch[1] : '';
    const title = cleaned.replace(RE_TITLE_TAG, '').replace(/\[竞猜中\].*/g, '').trim();

    // 描述与 liquipedia 链接
    const descEl = doc.querySelector('#description');
    const description = descEl ? descEl.textContent.replace(/\s+/g, ' ').trim() : '';
    const liquipediaMatch = description.match(RE_LIQUIPEDIA);
    const liquipediaUrl = liquipediaMatch ? liquipediaMatch[0].replace(/[).,;]+$/, '') : null;

    // 选项
    const radios = Array.from(form.querySelectorAll('input[type="radio"][name="choice"]'));
    const choices = radios.map(radio => {
      const label = radio.closest('label');
      const raw = (label && label.textContent) ? label.textContent.replace(/\s+/g, ' ').trim() : '';
      const oddsM = raw.match(RE_ODDS);
      const poolM = raw.match(RE_POOL);
      // 队伍名 = 去除赔率/金币段
      let name = raw
        .replace(/赔率[：:]\s*1\s*[:：]\s*[\d.]+/, '')
        .replace(/金币[：:]\s*[\d.]+/, '')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        value:  radio.value,
        name,
        odds:   oddsM ? parseFloat(oddsM[1]) : NaN,   // 含本金的总回报倍数
        pool:   poolM ? parseFloat(poolM[1]) : 0,
        radioEl: isCurrent ? radio : null,
        labelEl: isCurrent ? label : null
      };
    });

    // 总奖池：table 里最后一列的"总金币"数字
    let totalPool = choices.reduce((s, c) => s + (c.pool || 0), 0);
    const poolInTable = doc.querySelector('.card-body table tbody tr th:nth-child(3)');
    if (poolInTable) {
      const p = parseFloat(poolInTable.textContent.replace(/[^\d.]/g, ''));
      if (!isNaN(p) && p > 0) totalPool = p;
    }

    // 截止时间（table 第 1 列，形如 "2026-07-17 19:00:00"）
    let deadlineText = '';
    let deadlineTs   = null;
    const deadlineEl = doc.querySelector('.card-body table tbody tr th:nth-child(1)');
    if (deadlineEl) {
      deadlineText = deadlineEl.textContent.trim();
      const m = deadlineText.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (m) {
        // 本地时区解析（scboy 服务器和用户大概率同区）
        const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        if (!isNaN(d.getTime())) deadlineTs = d.getTime();
      }
    }

    // 余额（只在当前页面有意义，列表页抓的详情 HTML 也会带用户余额但对列表 Tier 1 用不上）
    const formText = form.textContent || '';
    const balMatch = formText.match(RE_BALANCE);
    const balance = balMatch ? parseInt(balMatch[1].replace(/,/g, ''), 10) : 0;

    // 输入框和按钮（仅当前页有效）
    const goldInput = isCurrent ? form.querySelector('input[name="gold"], #gold') : null;
    const submitBtn = isCurrent ? form.querySelector('button#send, button[type="button"]') : null;

    // 是否已下注
    const alreadyBet = /您已下注|已投注/.test(formText) || radios.some(r => r.disabled);

    return {
      title, category, description, liquipediaUrl,
      totalPool, balance, choices,
      deadlineText, deadlineTs,
      goldInput, submitBtn, alreadyBet
    };
  }

  // ============================================================
  // liquipedia 正文提取（去 nav / infobox / references，保留段落文本）
  // ============================================================
  async function fetchLiquipedia(url) {
    if (!url) return '';
    try {
      const res = await gmFetch({ url, timeout: 30000 });
      if (res.status !== 200) throw new Error('HTTP ' + res.status);

      // 用 DOMParser 解析并抽正文
      const doc = new DOMParser().parseFromString(res.text, 'text/html');
      const content = doc.querySelector('#mw-content-text') || doc.body;

      // 删除无关块
      content.querySelectorAll('script, style, .toc, .navbox, .reference, .references, .metadata, .mw-editsection, .infobox-image, .thumb, .noprint').forEach(el => el.remove());

      // 保留 h1-h4 与 p / li / td 的可读文本
      const parts = [];
      content.querySelectorAll('h1, h2, h3, h4, p, li, td').forEach(el => {
        const txt = el.textContent.replace(/\s+/g, ' ').trim();
        if (txt && txt.length > 2) parts.push(txt);
      });

      let text = parts.join('\n').replace(/\n{2,}/g, '\n');
      if (text.length > 8000) text = text.slice(0, 8000) + '\n...[truncated]';
      return text;
    } catch (e) {
      warn('liquipedia fetch failed:', e.message);
      return '';
    }
  }

  // ============================================================
  // 列表页 Tier 1：后台抓详情页 HTML → 复用 parseDetail() 算市场隐含胜率
  // ============================================================
  const LIST_CACHE_PREFIX = 'listcache.v1.';
  const LIST_CACHE_TTL_MS = 15 * 60 * 1000;   // 15 分钟
  const LIST_MAX_ROWS = 20;                    // 一页最多分析 20 条

  /** 从列表页链接抽 bet id：/?bet-detail-1234.htm → "1234" */
  function extractBetId(href) {
    if (!href) return null;
    const m = href.match(/bet-detail-(\d+)/);
    return m ? m[1] : null;
  }

  function readCache(id) {
    try {
      const raw = GM_getValue(LIST_CACHE_PREFIX + id, null);
      if (!raw) return null;
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!obj || !obj.ts) return null;
      if (Date.now() - obj.ts > LIST_CACHE_TTL_MS) return null;
      return obj;
    } catch (_) { return null; }
  }
  function writeCache(id, tier1) {
    try {
      GM_setValue(LIST_CACHE_PREFIX + id, JSON.stringify({ ts: Date.now(), tier1 }));
    } catch (_) { /* ignore */ }
  }

  // ============================================================
  // 详情页 LLM 预测缓存：只缓存 prediction（probs/confidence/reasoning）
  // 过期时间 = 详情页截止时间；【重新分析】按钮会清掉缓存重跑。
  // ============================================================
  const PRED_CACHE_PREFIX = 'predcache.v1.';
  /** 从详情页 URL 抽 bet id */
  function extractDetailId(href) {
    if (!href) return null;
    const m = href.match(/bet-detail-(\d+)/);
    return m ? m[1] : null;
  }
  function readPredCache(id) {
    if (!id) return null;
    try {
      const raw = GM_getValue(PRED_CACHE_PREFIX + id, null);
      if (!raw) return null;
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!obj || !obj.ts || !obj.prediction) return null;
      // 若 expiresAt 存在且已过 → 弃用（截止时间以后的分析已无意义）
      if (obj.expiresAt && Date.now() > obj.expiresAt) return null;
      return obj;
    } catch (_) { return null; }
  }
  function writePredCache(id, prediction, expiresAt) {
    if (!id) return;
    try {
      GM_setValue(PRED_CACHE_PREFIX + id, JSON.stringify({
        ts: Date.now(),
        expiresAt: expiresAt || null,
        prediction
      }));
    } catch (_) { /* ignore */ }
  }
  function deletePredCache(id) {
    if (!id) return;
    try { GM_deleteValue(PRED_CACHE_PREFIX + id); } catch (_) { /* ignore */ }
  }

  /** GET 详情页 HTML，用 DOMParser 解析，复用 parseDetail(doc) */
  async function fetchDetailByUrl(url) {
    const res = await gmFetch({ url, timeout: 30000 });
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(res.text, 'text/html');
    const parsed = parseDetail(doc);
    if (!parsed) throw new Error('解析详情页失败');
    return parsed;
  }

  /** 计算 Tier 1 指标（不调 LLM，纯几何；支持 K 选一） */
  function computeTier1(detail) {
    if (!detail) return { unknown: true, reason: '解析失败' };
    if (!detail.choices || detail.choices.length < 2) {
      return { unknown: true, reason: '选项 <2' };
    }
    const total = detail.choices.reduce((s, c) => s + (c.pool || 0), 0);
    if (total <= 0) {
      return {
        unknown: true, reason: '池为空',
        markets: detail.choices.map(c => ({ name: c.name, pool: 0, odds: c.odds, market: 0, imp: NaN }))
      };
    }
    const markets = detail.choices.map(c => {
      const pool = c.pool || 0;
      const market = pool / total;
      const imp = c.odds > 0 ? 1 / c.odds : NaN;
      return { name: c.name, pool, odds: c.odds, market, imp };
    });
    // 失衡：领跑者占比 - 垫底者占比（0=均匀，1=一边倒）
    const marketVals = markets.map(m => m.market);
    const imbalance = Math.max(...marketVals) - Math.min(...marketVals);
    return {
      unknown: false, K: markets.length, total, markets, imbalance,
      alreadyBet: !!detail.alreadyBet
    };
  }

  /** 简单并发闸门 */
  function createLimiter(maxConcurrent) {
    let active = 0;
    const queue = [];
    const run = () => {
      if (active >= maxConcurrent) return;
      const next = queue.shift();
      if (!next) return;
      active++;
      Promise.resolve()
        .then(next.task)
        .then(next.resolve, next.reject)
        .finally(() => { active--; run(); });
    };
    return function (task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        run();
      });
    };
  }
  const listLimiter = createLimiter(2);
  const jitter = (min, max) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));

  // ============================================================
  // LLM 调用（OpenAI 兼容）
  // ============================================================
  function buildPrompt(detail, liquipediaText) {
    const cs = detail.choices;
    const K = cs.length;
    const optLines = cs.map((c, i) =>
      `选项 ${i + 1} (${c.name})   市场赔率(含本金) 1:${c.odds}   资金池 ${c.pool}`
    ).join('\n');
    return {
      system: [
        '你是一名严格、克制的电竞/体育竞猜分析师。',
        '你需要根据提供的比赛信息，为每个选项估计"真实获胜概率"（不是隐含赔率，而是你独立判断的概率）。',
        '如果信息不足以做出可靠判断，请老实降低置信度（confidence）。',
        '',
        '你必须只输出一个 JSON 对象，禁止任何多余文字、解释、markdown 代码块。',
        `本次共有 ${K} 个选项，编号 1..${K}，你必须按输入顺序返回同样长度的 probs 数组。`,
        '返回结构：',
        '{',
        `  "probs": [p1, p2, ..., p${K}],   // 每个选项的胜率，0~1，元素之和应约等于 1`,
        '  "confidence": number,            // 你对本次估计的置信度，0~1',
        '  "reasoning": "简短说明理由，中文，不超过 200 字"',
        '}'
      ].join('\n'),
      user: [
        `比赛分类：${detail.category || '未知'}`,
        `比赛标题：${detail.title}`,
        `比赛描述：${detail.description || '(无)'}`,
        '',
        optLines,
        `总奖池：${detail.totalPool}`,
        '',
        liquipediaText ? '=== 参考资料 (liquipedia) ===\n' + liquipediaText : '(未提供外部参考资料)',
        '',
        `请只输出 JSON，probs 数组长度必须为 ${K}。`
      ].join('\n')
    };
  }

  async function callLLM(detail, liquipediaText) {
    const baseUrl = String(cfg(CONFIG_KEYS.baseUrl)).replace(/\/+$/, '');
    const apiKey  = cfg(CONFIG_KEYS.apiKey);
    const model   = cfg(CONFIG_KEYS.model);
    if (!apiKey) throw new Error('未配置 API Key，请在 Tampermonkey 菜单里点「⚙️ 设置」填写');

    const { system, user } = buildPrompt(detail, liquipediaText);
    const body = {
      model,
      temperature: Number(cfg(CONFIG_KEYS.temperature)),
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      response_format: { type: 'json_object' }
    };

    log('LLM request', { baseUrl, model });
    const res = await gmFetch({
      method:  'POST',
      url:     baseUrl + '/chat/completions',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body:    JSON.stringify(body),
      timeout: 90000
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error('LLM HTTP ' + res.status + ': ' + res.text.slice(0, 300));
    }

    let payload;
    try { payload = JSON.parse(res.text); } catch { throw new Error('LLM 返回不是 JSON: ' + res.text.slice(0, 200)); }
    const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
    if (!content) throw new Error('LLM 返回结构异常: ' + JSON.stringify(payload).slice(0, 300));

    // 有些模型会包 ```json ...```，兜底剥壳
    const cleaned = String(content).trim()
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();

    let obj;
    try { obj = JSON.parse(cleaned); }
    catch { throw new Error('LLM 内容不是合法 JSON: ' + cleaned.slice(0, 300)); }

    return normalizePrediction(obj, detail);
  }

  function normalizePrediction(obj, detail) {
    const K = detail.choices.length;
    let probs = null;

    // 主路径：{probs:[...]}
    if (Array.isArray(obj.probs)) {
      probs = obj.probs.map(Number);
    }
    // 兼容旧 schema：{probA, probB}（严格二选一时）
    else if (obj.probA !== undefined || obj.probB !== undefined) {
      probs = [Number(obj.probA), Number(obj.probB)];
    }
    // 兼容 {p1,p2,p3,...}
    else {
      probs = [];
      for (let i = 1; i <= K; i++) {
        const v = obj['p' + i];
        if (v !== undefined) probs.push(Number(v));
      }
      if (probs.length !== K) probs = null;
    }

    if (!probs || probs.length !== K) {
      throw new Error(`LLM 返回的 probs 数组长度不对：期望 ${K}，实得 ${probs ? probs.length : '缺失'}`);
    }

    // 清理非法值 & 归一化
    probs = probs.map(p => (isFinite(p) && p >= 0) ? p : 0);
    const sum = probs.reduce((s, p) => s + p, 0);
    if (sum <= 0) throw new Error('LLM 返回的概率全为 0/非法');
    probs = probs.map(p => p / sum);

    const confidence = clamp(Number(obj.confidence), 0, 1, 0.5);
    const reasoning  = String(obj.reasoning || '').trim();
    return { probs, confidence, reasoning };
  }

  // ============================================================
  // 决策：EV + Half-Kelly + 动态赔率补偿
  // ============================================================
  function clamp(x, lo, hi, fallback) {
    const v = Number(x);
    if (!isFinite(v)) return fallback === undefined ? lo : fallback;
    return Math.max(lo, Math.min(hi, v));
  }

  /**
   * 计算某选项的期望回报（相对下注 1 单位）
   * 参考模型：odds 已含本金 → 净收益倍率 b = odds - 1
   *          胜  概率 p 时收益 +b
   *          败  概率 1-p 时收益 -1
   *          EV = p*b - (1-p) = p*(b+1) - 1 = p*odds - 1
   */
  function computeEV(prob, odds) {
    return prob * odds - 1;
  }

  /**
   * 静态 Half-Kelly：f* = (b*p - q) / b
   * @returns 建议下注占余额的比例，可能为负（不推荐）
   */
  function kellyFraction(prob, odds) {
    const b = odds - 1;
    if (b <= 0) return -1;
    const q = 1 - prob;
    return (b * prob - q) / b;
  }

  /**
   * 动态赔率下的 Kelly：在 parimutuel（奖池分摊）机制下，下注 x 到 side 会使 side 池变大、稀释自己的赔率
   *   净收益倍率 b(x)   = opponentPool / (sidePool + x)
   *   赢概率 p，则 Kelly 目标（对数增长率）为凹函数：
   *     g(f) = p * ln(1 + b(f)·f) + (1-p) * ln(1 - f)         (f = x / balance)
   *   我们用三分搜索在 [0, min(1-eps, f0_static)] 找最大值。
   *   传入的 sideCurrentPool 已经是"当前池"（未含 x），balance 是账户余额。
   */
  function kellyDynamicFraction(prob, sidePool, opponentPool, balance) {
    if (prob <= 0 || prob >= 1) return 0;
    if (balance <= 0) return 0;

    const g = (f) => {
      if (f <= 0) return 0;
      if (f >= 1) return -Infinity;
      const x = f * balance;
      const b = opponentPool / (sidePool + x);       // 净收益倍率
      const win = 1 + b * f;                          // 赢时资产变成 balance*(1 + b*f)
      const lose = 1 - f;                             // 输时资产变成 balance*(1 - f)
      if (win <= 0 || lose <= 0) return -Infinity;
      return prob * Math.log(win) + (1 - prob) * Math.log(lose);
    };

    // 静态 f0 作为上界参考
    const staticOdds = 1 + opponentPool / Math.max(1, sidePool);
    const b0 = staticOdds - 1;
    const f0 = b0 <= 0 ? 0 : (b0 * prob - (1 - prob)) / b0;
    if (f0 <= 0) return 0;   // 静态 Kelly 都负 → 直接放弃（动态只会更差）

    // 三分搜索 [lo, hi]，hi = min(f0, 0.99)
    let lo = 0, hi = Math.min(f0, 0.99);
    for (let i = 0; i < 80; i++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if (g(m1) < g(m2)) lo = m1;
      else               hi = m2;
    }
    const fOpt = (lo + hi) / 2;
    return fOpt > 0 && fOpt < 1 && isFinite(g(fOpt)) ? fOpt : 0;
  }

  // v0.3.0 稳赢-回本模式辅助函数
  /**
   * 贝叶斯收缩：按 confidence 加权混合 LLM 概率与市场共识
   * w = confidence（LLM 越自信越信 LLM；越不自信越靠市场）
   */
  function blendWithMarket(pLlm, pMarket, confidence) {
    const w = Math.max(0, Math.min(1, Number(confidence) || 0));
    return w * pLlm + (1 - w) * pMarket;
  }

  /**
   * 效应门槛：odds 越高（越冷门），对 EV 的要求越高
   * odds=2 时不变；odds=5 约 2.32×；odds=10 约 3.32×
   */
  function effectiveMinEV(baseMinEV, odds) {
    if (!(odds > 1)) return baseMinEV;
    const mul = 1 + Math.max(0, Math.log2(odds / 2));
    return baseMinEV * mul;
  }

  function decideStake(prediction, detail) {
    const balance    = detail.balance;
    const kellyFrac  = Number(cfg(CONFIG_KEYS.kellyFrac));
    const minEV      = Number(cfg(CONFIG_KEYS.minEV));
    const maxPct     = Number(cfg(CONFIG_KEYS.maxStakePct));
    const minStake   = Number(cfg(CONFIG_KEYS.minStake));
    const maxStake   = Number(cfg(CONFIG_KEYS.maxStake));

    // v0.3.0 新参数
    const safeMode        = !!cfg(CONFIG_KEYS.safeMode);
    const allowLongshot   = !!cfg(CONFIG_KEYS.allowLongshot);
    const pFinalSafe      = Number(cfg(CONFIG_KEYS.pFinalSafe));
    const lsEvMul         = Number(cfg(CONFIG_KEYS.longshotEvMul));
    const lsStakeMul      = Number(cfg(CONFIG_KEYS.longshotStakeMul));
    const lsBalanceCap    = Number(cfg(CONFIG_KEYS.longshotBalanceCap));

    const cs = detail.choices;
    const totalPool = cs.reduce((s, c) => s + (c.pool || 0), 0);
    const probsLlm = prediction.probs || [];
    const confidence = Number(prediction.confidence) || 0;

    // 市场共识：池占比（K 选一均适用）
    const probsMarket = cs.map(c => totalPool > 0 ? (c.pool || 0) / totalPool : 0);

    // 若关闭稳赢模式，混合概率 = LLM 概率（w=1）
    const probsFinal = probsLlm.map((p, i) =>
      safeMode ? blendWithMarket(p, probsMarket[i], confidence) : p
    );

    const evaluate = (side, i) => {
      const probLlm    = probsLlm[i];
      const probMarket = probsMarket[i];
      const probFinal  = probsFinal[i];
      const sidePool     = side.pool || 0;
      const opponentPool = totalPool - sidePool;

      // 用于展示的静态挂牌 EV（按混合概率算，稳赢模式下反映"贝叶斯化"后的真实预期）
      const ev0 = computeEV(probFinal, side.odds);
      const f0  = kellyFraction(probFinal, side.odds);

      // 动态赔率下的最优 Kelly 比例（用混合概率）
      const fDynamic = kellyDynamicFraction(probFinal, sidePool, opponentPool, balance);
      let stakeRaw = Math.floor(fDynamic * balance * kellyFrac);
      stakeRaw = Math.min(stakeRaw, Math.floor(balance * maxPct), maxStake, balance);
      stakeRaw = Math.max(0, stakeRaw);

      const effectiveOdds = stakeRaw > 0 ? (1 + opponentPool / (sidePool + stakeRaw)) : side.odds;
      const effectiveEV   = computeEV(probFinal, effectiveOdds);

      // 门槛：odds 越高越严；主推荐用 minEV，冷门用 minEV * lsEvMul
      const minEVSafe     = effectiveMinEV(minEV, side.odds);
      const minEVLongshot = effectiveMinEV(minEV * lsEvMul, side.odds);

      // 分档判定
      let tier = 'skip';
      let stake = stakeRaw;
      let tierReason = '';

      const evPass    = ev0 >= minEVSafe;
      const evPassLs  = ev0 >= minEVLongshot;

      if (!safeMode) {
        // 旧行为：只看 EV 与最小仓位
        if (evPass && stake >= minStake) tier = 'safe';
        else tierReason = evPass ? '仓位<最低' : 'EV<门槛';
      } else if (probFinal >= pFinalSafe && evPass && stake >= minStake) {
        tier = 'safe';
      } else if (allowLongshot && probFinal < pFinalSafe && evPassLs) {
        // 冷门：Kelly 打折 + 余额上限
        const stakeLs = Math.min(
          Math.floor(stakeRaw * lsStakeMul),
          Math.floor(balance * lsBalanceCap)
        );
        stake = Math.max(0, stakeLs);
        if (stake >= minStake) {
          tier = 'longshot';
        } else {
          tier = 'skip';
          tierReason = '冷门仓位<最低';
        }
      } else {
        tier = 'skip';
        if (probFinal < pFinalSafe && !evPassLs) tierReason = 'EV 未过冷门门槛';
        else if (probFinal < pFinalSafe && !allowLongshot) tierReason = '冷门已关闭';
        else if (!evPass) tierReason = 'EV<门槛';
        else if (stake < minStake) tierReason = '仓位<最低';
      }

      // 冷门档要按新 stake 重新算 effectiveOdds/effectiveEV
      let finalEffOdds = effectiveOdds;
      let finalEffEV   = effectiveEV;
      if (tier === 'longshot' && stake !== stakeRaw) {
        finalEffOdds = stake > 0 ? (1 + opponentPool / (sidePool + stake)) : side.odds;
        finalEffEV   = computeEV(probFinal, finalEffOdds);
      }

      return {
        side, idx: i,
        probLlm, probMarket, probFinal, prob: probFinal,
        ev: ev0, kelly: f0, fDynamic,
        stake,
        acceptable: tier !== 'skip',
        tier, tierReason,
        minEVSafe, minEVLongshot,
        effectiveOdds: finalEffOdds, effectiveEV: finalEffEV
      };
    };

    const opts = cs.map((side, i) => evaluate(side, i));

    // 选最佳：safe 优先，同档内按 effectiveEV 从大到小
    const safeOpts = opts.filter(o => o.tier === 'safe').sort((x, y) => y.effectiveEV - x.effectiveEV);
    const lsOpts   = opts.filter(o => o.tier === 'longshot').sort((x, y) => y.effectiveEV - x.effectiveEV);
    const best     = safeOpts[0] || lsOpts[0] || null;

    // 展示排序：按静态 EV 从大到小
    opts.sort((x, y) => y.ev - x.ev);

    return {
      options: opts, best,
      meta: {
        safeMode, allowLongshot, pFinalSafe,
        confidence, blendWeight: safeMode ? confidence : 1
      }
    };
  }

  // ============================================================
  // UI 注入
  // ============================================================
  const PANEL_ID = 'scboy-bet-helper-panel';

  const PANEL_CSS = `
  #${PANEL_ID} { border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 14px; margin: 12px 0; background: #f8fafc; font-size: 13px; color: #24292f; line-height: 1.55; }
  #${PANEL_ID} .sh-title { font-weight: 600; font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
  #${PANEL_ID} .sh-title .sh-badge { background: #0969da; color: #fff; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  #${PANEL_ID} .sh-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; margin: 8px 0; }
  #${PANEL_ID} .sh-row { display: flex; justify-content: space-between; }
  #${PANEL_ID} .sh-row .k { color: #57606a; }
  #${PANEL_ID} .sh-row .v { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
  #${PANEL_ID} .sh-pos { color: #1a7f37; font-weight: 600; }
  #${PANEL_ID} .sh-neg { color: #cf222e; }
  #${PANEL_ID} .sh-rec { background: #ddf4ff; border: 1px solid #54aeff; border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
  #${PANEL_ID} .sh-warn { background: #fff8c5; border: 1px solid #d4a72c; border-radius: 6px; padding: 8px 10px; margin: 8px 0; color: #7d4e00; }
  #${PANEL_ID} .sh-reason { color: #57606a; font-size: 12px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed #d0d7de; }
  #${PANEL_ID} .sh-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  #${PANEL_ID} .sh-btn { border: 1px solid #d0d7de; background: #f6f8fa; padding: 5px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  #${PANEL_ID} .sh-btn:hover:not(:disabled) { background: #eaeef2; }
  #${PANEL_ID} .sh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #${PANEL_ID} .sh-btn.primary { background: #1f883d; color: #fff; border-color: #1f883d; }
  #${PANEL_ID} .sh-btn.primary:hover:not(:disabled) { background: #1a7f37; }
  #${PANEL_ID} .sh-btn.warn { background: #cf222e; color: #fff; border-color: #cf222e; }
  #${PANEL_ID} .sh-loading { display: inline-block; width: 12px; height: 12px; border: 2px solid #d0d7de; border-top-color: #0969da; border-radius: 50%; animation: sh-spin 0.8s linear infinite; vertical-align: middle; }
  @keyframes sh-spin { to { transform: rotate(360deg); } }

  /* 列表页徽章 */
  .sh-list-tools { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; vertical-align: middle; }
  .sh-list-btn { border: 1px solid #d0d7de; background: #f6f8fa; padding: 1px 6px; border-radius: 4px; cursor: pointer; font-size: 11px; color: #24292f; line-height: 1.4; }
  .sh-list-btn:hover:not(:disabled) { background: #eaeef2; }
  .sh-list-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .sh-list-badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; line-height: 1.6; }
  .sh-list-badge.pending { background: #eaeef2; color: #57606a; }
  .sh-list-badge.loading { background: #fff8c5; color: #7d4e00; }
  .sh-list-badge.info    { background: #ddf4ff; color: #0550ae; }
  .sh-list-badge.warn    { background: #fff8c5; color: #7d4e00; }
  .sh-list-badge.err     { background: #ffebe9; color: #cf222e; }
  .sh-list-badge.done    { background: #dafbe1; color: #1a7f37; }

  /* ============ 设置 Modal（v0.2 自绘，与 scboy 站点 Bootstrap 隔离）============ */
  .sh-modal-mask {
    position: fixed; inset: 0; background: rgba(15,23,42,.55);
    display: flex; align-items: center; justify-content: center;
    z-index: 2147483000;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    animation: sh-fadein .12s ease-out;
  }
  @keyframes sh-fadein { from { opacity: 0; } to { opacity: 1; } }
  .sh-modal-dialog {
    background: #fff; color: #24292f; width: 560px; max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px); border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0,0,0,.35);
    display: flex; flex-direction: column; overflow: hidden;
    font-size: 13px; line-height: 1.5;
  }
  .sh-modal-head {
    padding: 12px 16px; border-bottom: 1px solid #d0d7de;
    display: flex; align-items: center; justify-content: space-between;
    background: #f6f8fa;
  }
  .sh-modal-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .sh-modal-head .sh-modal-x {
    background: none; border: 0; font-size: 20px; line-height: 1; cursor: pointer;
    color: #57606a; padding: 0 4px;
  }
  .sh-modal-head .sh-modal-x:hover { color: #cf222e; }
  .sh-modal-body { padding: 14px 16px; overflow-y: auto; }
  .sh-modal-body .sh-section-title {
    font-weight: 600; font-size: 12px; color: #57606a;
    text-transform: uppercase; letter-spacing: .5px;
    margin: 14px 0 8px; padding-bottom: 4px; border-bottom: 1px dashed #d0d7de;
  }
  .sh-modal-body .sh-section-title:first-child { margin-top: 0; }
  .sh-modal-body .sh-field {
    display: grid; grid-template-columns: 130px 1fr; gap: 8px 12px;
    align-items: center; margin-bottom: 8px;
  }
  .sh-modal-body .sh-field label {
    color: #24292f; font-weight: 500;
  }
  .sh-modal-body .sh-field .sh-hint {
    grid-column: 2; color: #57606a; font-size: 11px; margin-top: -4px;
  }
  .sh-modal-body input[type=text],
  .sh-modal-body input[type=password],
  .sh-modal-body input[type=number],
  .sh-modal-body select {
    width: 100%; box-sizing: border-box;
    padding: 5px 8px; border: 1px solid #d0d7de; border-radius: 6px;
    font-size: 13px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    background: #fff; color: #24292f;
  }
  .sh-modal-body select { font-family: inherit; }
  .sh-modal-body input:focus, .sh-modal-body select:focus {
    outline: none; border-color: #0969da; box-shadow: 0 0 0 3px rgba(9,105,218,.15);
  }
  .sh-modal-body input[type=checkbox] { width: auto; }
  .sh-modal-body .sh-field-check {
    display: flex; gap: 8px; align-items: center;
  }
  .sh-modal-body .sh-note {
    background: #fff8c5; border: 1px solid #d4a72c;
    padding: 6px 10px; border-radius: 6px; color: #7d4e00;
    font-size: 12px; margin: 8px 0;
  }
  .sh-modal-body details.sh-adv {
    margin: 14px 0 4px; border-top: 1px dashed #d0d7de; padding-top: 8px;
  }
  .sh-modal-body details.sh-adv > summary {
    cursor: pointer; user-select: none; list-style: none;
    font-weight: 600; font-size: 12px; color: #57606a;
    text-transform: uppercase; letter-spacing: .5px;
    padding: 4px 0; outline: none;
  }
  .sh-modal-body details.sh-adv > summary::-webkit-details-marker { display: none; }
  .sh-modal-body details.sh-adv > summary::before {
    content: '▶'; display: inline-block; margin-right: 6px;
    font-size: 10px; transition: transform .15s;
  }
  .sh-modal-body details.sh-adv[open] > summary::before { transform: rotate(90deg); }
  .sh-modal-body details.sh-adv > summary:hover { color: #0969da; }
  .sh-modal-body details.sh-adv .sh-section-title {
    margin-top: 12px; border-bottom: none; padding-bottom: 0;
  }
  .sh-modal-body details.sh-adv .sh-section-title:first-of-type { margin-top: 8px; }
  .sh-modal-body .sh-test-out {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11px; background: #f6f8fa; border: 1px solid #d0d7de;
    border-radius: 6px; padding: 6px 8px; margin-top: 8px;
    white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow: auto;
    display: none;
  }
  .sh-modal-body .sh-test-out.show { display: block; }
  .sh-modal-body .sh-test-out.ok  { border-color: #1a7f37; background: #dafbe1; color: #1a7f37; }
  .sh-modal-body .sh-test-out.err { border-color: #cf222e; background: #ffebe9; color: #cf222e; }
  .sh-modal-foot {
    padding: 10px 16px; border-top: 1px solid #d0d7de; background: #f6f8fa;
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
  }
  .sh-modal-foot .sh-foot-left { display: flex; gap: 8px; }
  .sh-modal-foot .sh-foot-right { display: flex; gap: 8px; }
  .sh-modal-foot .sh-btn2 {
    border: 1px solid #d0d7de; background: #f6f8fa; padding: 5px 14px;
    border-radius: 6px; cursor: pointer; font-size: 13px; color: #24292f;
  }
  .sh-modal-foot .sh-btn2:hover:not(:disabled) { background: #eaeef2; }
  .sh-modal-foot .sh-btn2:disabled { opacity: 0.5; cursor: not-allowed; }
  .sh-modal-foot .sh-btn2.primary { background: #1f883d; color: #fff; border-color: #1f883d; }
  .sh-modal-foot .sh-btn2.primary:hover:not(:disabled) { background: #1a7f37; }
  .sh-modal-foot .sh-btn2.link { background: none; border: 0; color: #0969da; padding: 5px 8px; }
  .sh-modal-foot .sh-btn2.link:hover { text-decoration: underline; }
  `;

  function injectStyles() {
    if (document.getElementById('scboy-bet-helper-style')) return;
    const s = document.createElement('style');
    s.id = 'scboy-bet-helper-style';
    s.textContent = PANEL_CSS;
    document.head.appendChild(s);
  }

  function createPanel(detail) {
    const wrap = document.createElement('div');
    wrap.id = PANEL_ID;

    // 探测预测缓存：命中则直接进入结果视图
    const detailId = extractDetailId(location.href);
    const cached   = readPredCache(detailId);

    if (cached && cached.prediction) {
      log('pred cache hit', detailId, cached);
      // 用当前最新 detail（池/赔率/余额可能已漂移）+ 缓存的 prediction 重新算 decision
      try {
        const decision = decideStake(cached.prediction, detail);
        wrap.innerHTML = `<div class="sh-title"><span>🤖 LLM 竞猜辅助</span><span class="sh-badge">v0.3.0</span></div><div class="sh-body"></div>`;
        const target = document.querySelector('#choices') || document.querySelector('.card-body');
        if (target) target.insertBefore(wrap, target.firstChild);
        else document.body.prepend(wrap);
        renderResult(wrap, detail, cached.prediction, decision, cached);
        return wrap;
      } catch (e) {
        warn('reuse cached prediction failed, fall back to fresh', e && e.message);
        // 缓存字段与当前 choices 数量不匹配等 → 清缓存走空态
        deletePredCache(detailId);
      }
    }

    wrap.innerHTML = `
      <div class="sh-title">
        <span>🤖 LLM 竞猜辅助</span>
        <span class="sh-badge">v0.3.0</span>
      </div>
      <div class="sh-body">
        <button class="sh-btn primary" id="sh-analyze">开始分析</button>
        <span class="sh-hint" style="margin-left:8px;color:#57606a;font-size:12px;">
          将调用大模型并${detail.liquipediaUrl ? '抓取 liquipedia' : '仅用标题'}分析。
        </span>
      </div>
    `;

    const target = document.querySelector('#choices') || document.querySelector('.card-body');
    if (target) target.insertBefore(wrap, target.firstChild);
    else document.body.prepend(wrap);

    wrap.querySelector('#sh-analyze').addEventListener('click', () => runAnalysis(detail, wrap));
    return wrap;
  }

  function renderLoading(panel, msg) {
    panel.querySelector('.sh-body').innerHTML = `<span class="sh-loading"></span> <span style="margin-left:6px;">${msg}</span>`;
  }

  function renderError(panel, e) {
    panel.querySelector('.sh-body').innerHTML =
      `<div class="sh-warn">❌ ${escapeHtml(e.message || String(e))}</div>
       <button class="sh-btn" id="sh-retry">重试</button>`;
    panel.querySelector('#sh-retry').addEventListener('click', () => {
      const d = parseDetail();
      if (d) runAnalysis(d, panel);
    });
  }

  function renderResult(panel, detail, prediction, decision, cacheMeta) {
    const cs = detail.choices;
    const best = decision.best;
    const meta = decision.meta || {};

    const evClass = (ev) => ev > 0.02 ? 'sh-pos' : (ev < -0.02 ? 'sh-neg' : '');
    const pct = (x) => (x * 100).toFixed(1) + '%';
    const num = (x) => (isFinite(x) ? x.toFixed(3) : '—');
    const sign = (x) => (x > 0 ? '+' : '') + num(x);

    // 每个选项一行：名称 | LLM% | 市场% | 混合% | 赔率 | EV
    // 未达任何门槛（tier=skip）行 opacity 淡显
    const rowsHtml = decision.options.map(o => {
      const isBest = best && o.side === best.side;
      const tierIcon = o.tier === 'safe' ? '🟢' : (o.tier === 'longshot' ? '🟠' : '');
      const bg = isBest
        ? (o.tier === 'longshot'
            ? 'background:#fff1e0;border:1px solid #ffb56b;'
            : 'background:#dafbe1;border:1px solid #6ac26a;')
        : '';
      const opacity = o.tier === 'skip' ? 'opacity:0.55;' : '';
      const tag = isBest ? ' 🎯' : '';
      return `<div class="sh-row" style="${bg}border-radius:4px;padding:2px 4px;${opacity}">
        <span class="k" style="flex:1;">${tierIcon} ${escapeHtml(o.side.name)}${tag}</span>
        <span class="v" style="width:56px;text-align:right;" title="LLM 原始胜率">${pct(o.probLlm)}</span>
        <span class="v" style="width:56px;text-align:right;color:#57606a;" title="市场共识（池占比）">${pct(o.probMarket)}</span>
        <span class="v" style="width:56px;text-align:right;font-weight:600;" title="混合概率（贝叶斯收缩后）">${pct(o.probFinal)}</span>
        <span class="v" style="width:56px;text-align:right;">1:${o.side.odds}</span>
        <span class="v ${evClass(o.ev)}" style="width:60px;text-align:right;">${sign(o.ev)}</span>
      </div>`;
    }).join('');

    // 顶部大 badge：safe / longshot / skip 三态
    let topBadge = '';
    if (!best) {
      topBadge = `<div class="sh-warn" style="font-size:14px;font-weight:600;text-align:center;padding:10px;">
        ⬜ 建议跳过 · 无满足门槛的选项
      </div>`;
    } else if (best.tier === 'safe') {
      topBadge = `<div style="background:#dafbe1;border:1px solid #6ac26a;color:#0a5f2f;border-radius:6px;padding:10px 12px;margin-bottom:8px;font-size:14px;font-weight:600;text-align:center;">
        🟢 稳赢推荐 · ${escapeHtml(best.side.name)} · 混合胜率 ${pct(best.probFinal)}
      </div>`;
    } else if (best.tier === 'longshot') {
      const lossPct = pct(1 - best.probFinal);
      const capPct  = ((best.stake / Math.max(1, detail.balance)) * 100).toFixed(1);
      topBadge = `<div style="background:#fff1e0;border:2px solid #bc4c00;color:#7a2c00;border-radius:6px;padding:10px 12px;margin-bottom:8px;font-size:14px;font-weight:600;text-align:center;">
        ⚠️ 冷门博（小仓位） · ${escapeHtml(best.side.name)}
        <div style="font-size:12px;font-weight:500;margin-top:4px;">
          胜率仅 ${pct(best.probFinal)}（${lossPct} 概率会输）· 仓位 ${capPct}% 余额
        </div>
      </div>`;
    }

    const recHtml = best
      ? `<div class="sh-rec" style="${best.tier === 'longshot' ? 'background:#fff1e0;border-color:#ffb56b;' : ''}">
           💰 <b>下注：${escapeHtml(best.side.name)}</b>
           &nbsp;|&nbsp; 金额 <b>${best.stake}</b>
           &nbsp;|&nbsp; 挂牌 EV <span class="${evClass(best.ev)}">${sign(best.ev)}</span>
           &nbsp;|&nbsp; 下注后有效赔率 1:${best.effectiveOdds.toFixed(3)}
           &nbsp;|&nbsp; 下注后 EV <span class="${evClass(best.effectiveEV)}">${sign(best.effectiveEV)}</span>
           <div style="font-size:11px;color:#57606a;margin-top:4px;">
             EV 门槛：${best.tier === 'longshot' ? '冷门 ' : ''}${(best.tier === 'longshot' ? best.minEVLongshot : best.minEVSafe).toFixed(3)}
             ${meta.safeMode ? ' · 混合权重 w=' + meta.blendWeight.toFixed(2) : ''}
           </div>
         </div>`
      : `<div class="sh-warn">
           ⚠️ 无满足门槛的选项。当前设置：${meta.safeMode ? '稳赢模式开，' : ''}主推荐要求混合胜率 ≥ ${(meta.pFinalSafe * 100).toFixed(0)}% 且 EV ≥ ${cfg(CONFIG_KEYS.minEV)}。
         </div>`;

    // 缓存信息条
    let cacheHtml = '';
    if (cacheMeta && cacheMeta.ts) {
      const ageMin = Math.max(0, Math.round((Date.now() - cacheMeta.ts) / 60000));
      const ageText = ageMin < 1 ? '刚刚' : (ageMin < 60 ? ageMin + ' 分钟前' : Math.floor(ageMin / 60) + ' 小时前');
      const dlText  = detail.deadlineText || (cacheMeta.expiresAt ? new Date(cacheMeta.expiresAt).toLocaleString() : '');
      cacheHtml = `<div style="background:#eff6ff;border:1px solid #93c5fd;color:#1e40af;border-radius:6px;padding:6px 10px;margin-bottom:8px;font-size:12px;">
        📌 显示上次缓存的分析（${ageText}）${dlText ? '，缓存至截止时间 ' + escapeHtml(dlText) : ''}。池和赔率已用当前值重算。点【重新分析】刷新。
      </div>`;
    }

    panel.querySelector('.sh-body').innerHTML = `
      ${cacheHtml}
      ${topBadge}
      <div style="display:flex;font-size:11px;color:#57606a;padding:2px 4px;">
        <span style="flex:1;">选项 (${cs.length} 选 1)</span>
        <span style="width:56px;text-align:right;" title="LLM 原始胜率">LLM</span>
        <span style="width:56px;text-align:right;" title="市场共识（池占比）">市场</span>
        <span style="width:56px;text-align:right;" title="混合概率（贝叶斯收缩后）">混合</span>
        <span style="width:56px;text-align:right;">赔率</span>
        <span style="width:60px;text-align:right;">EV</span>
      </div>
      ${rowsHtml}
      <div class="sh-row" style="margin-top:6px;">
        <span class="k">置信度 · 混合权重</span>
        <span class="v">${pct(prediction.confidence)} · w=${(meta.blendWeight || 1).toFixed(2)}</span>
      </div>
      ${renderDivergenceRow(detail, prediction)}
      <div class="sh-row">
        <span class="k">余额</span><span class="v">${detail.balance} 金币</span>
      </div>
      ${recHtml}
      ${prediction.reasoning ? `<div class="sh-reason">💭 ${escapeHtml(prediction.reasoning)}</div>` : ''}
      <div class="sh-actions">
        <button class="sh-btn" id="sh-refill" ${best ? '' : 'disabled'}>📝 一键填入</button>
        <button class="sh-btn primary" id="sh-bet" ${best ? '' : 'disabled'}>🎯 一键下注</button>
        <button class="sh-btn" id="sh-reanalyze">🔄 重新分析</button>
      </div>
    `;

    panel.querySelector('#sh-reanalyze').addEventListener('click', () => {
      const d = parseDetail();
      if (d) {
        deletePredCache(extractDetailId(location.href));
        runAnalysis(d, panel);
      }
    });

    if (best) {
      panel.querySelector('#sh-refill').addEventListener('click', () => applySelection(detail, best, false));
      panel.querySelector('#sh-bet').addEventListener('click', () => applySelection(detail, best, true));
    }
  }

  /** 把推荐选项/金额填入原生表单，可选是否触发原生下注 */
  function applySelection(detail, best, alsoSubmit) {
    try {
      best.side.radioEl.checked = true;
      best.side.radioEl.dispatchEvent(new Event('change', { bubbles: true }));
      detail.goldInput.value = String(best.stake);
      detail.goldInput.dispatchEvent(new Event('input',  { bubbles: true }));
      detail.goldInput.dispatchEvent(new Event('change', { bubbles: true }));

      if (alsoSubmit) {
        // 冷门档：先出橙色二次确认，说清楚风险
        if (best.tier === 'longshot') {
          const lossPct = ((1 - best.probFinal) * 100).toFixed(1);
          const okLs = confirm(
            `⚠️ 冷门博确认\n\n` +
            `选项：${best.side.name}\n` +
            `混合胜率仅 ${(best.probFinal * 100).toFixed(1)}%（${lossPct}% 概率会输掉这笔）\n` +
            `仓位：${best.stake} 金币（约 ${((best.stake / Math.max(1, detail.balance)) * 100).toFixed(1)}% 余额）\n` +
            `赔率：1:${best.side.odds}\n\n` +
            `这是小仓位博冷门，不是稳赢推荐。确认？`
          );
          if (!okLs) return;
        }
        const ok = confirm(
          `确认下注？\n\n选项：${best.side.name}\n金额：${best.stake} 金币\n赔率：1:${best.side.odds}\n\n注意：动态赔率可能在你确认前继续变化。`
        );
        if (ok) detail.submitBtn.click();
      }
    } catch (e) {
      err('applySelection failed', e);
      alert('填入失败：' + e.message);
    }
  }

  async function runAnalysis(detail, panel) {
    renderLoading(panel, '正在抓取 liquipedia...');
    try {
      const liqText = detail.liquipediaUrl ? await fetchLiquipedia(detail.liquipediaUrl) : '';

      renderLoading(panel, '正在调用大模型分析...（可能需要 5-30 秒）');
      const prediction = await callLLM(detail, liqText);
      log('LLM prediction', prediction);

      const decision = decideStake(prediction, detail);
      log('Decision', decision);

      // 写入预测缓存（过期时间=详情页截止时间；无则不写 expiresAt，永久保留）
      const detailId = extractDetailId(location.href);
      if (detailId) writePredCache(detailId, prediction, detail.deadlineTs);

      renderResult(panel, detail, prediction, decision);
    } catch (e) {
      err('runAnalysis failed', e);
      renderError(panel, e);
    }
  }

  // ============================================================
  // 设置面板（v0.2 自绘 Modal —— 预设+参数+测试连通性 一屏搞定）
  // ============================================================

  /** 通用 Modal 挂载。返回 { root, body, foot, close }。close 会解绑 ESC/点遮罩事件。 */
  function showModal(title) {
    // 单例：已存在就先移除
    const old = document.getElementById('sh-modal-mask');
    if (old) old.remove();

    const mask = document.createElement('div');
    mask.className = 'sh-modal-mask';
    mask.id = 'sh-modal-mask';
    mask.innerHTML =
      '<div class="sh-modal-dialog" role="dialog" aria-modal="true">' +
        '<div class="sh-modal-head">' +
          '<h3></h3>' +
          '<button type="button" class="sh-modal-x" title="关闭">×</button>' +
        '</div>' +
        '<div class="sh-modal-body"></div>' +
        '<div class="sh-modal-foot">' +
          '<div class="sh-foot-left"></div>' +
          '<div class="sh-foot-right"></div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(mask);
    mask.querySelector('.sh-modal-head h3').textContent = title || '设置';

    const dialog = mask.querySelector('.sh-modal-dialog');
    const body   = mask.querySelector('.sh-modal-body');
    const foot   = mask.querySelector('.sh-modal-foot');
    const footL  = foot.querySelector('.sh-foot-left');
    const footR  = foot.querySelector('.sh-foot-right');
    const closeBtn = mask.querySelector('.sh-modal-x');

    function close() {
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    document.addEventListener('keydown', onKey, true);

    // 点遮罩关（点对话框内不关）
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    // 拦截冒泡到站点的点击
    dialog.addEventListener('click', (e) => e.stopPropagation());
    closeBtn.addEventListener('click', close);

    return { root: mask, body, footLeft: footL, footRight: footR, close };
  }

  /** 打开设置面板（v0.2 主入口） */
  function openSettings() {
    const m = showModal('⚙️ LLM 竞猜辅助 · 设置');

    // -------- 表单模板 --------
    const html =
      '<div class="sh-section-title">🎯 服务预设</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-preset">快速填充</label>' +
        '<select id="sh-f-preset"></select>' +
      '</div>' +
      '<div id="sh-preset-note" class="sh-note" style="display:none"></div>' +

      '<div class="sh-section-title">🔑 LLM 连接</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-baseurl">base_url</label>' +
        '<input type="text" id="sh-f-baseurl" placeholder="https://api.deepseek.com" spellcheck="false"/>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-apikey">API Key</label>' +
        '<input type="password" id="sh-f-apikey" placeholder="sk-..." spellcheck="false" autocomplete="off"/>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-model">模型</label>' +
        '<select id="sh-f-model" style="display:none"></select>' +
        '<input type="text" id="sh-f-model-input" placeholder="deepseek-v4-flash" spellcheck="false"/>' +
      '</div>' +
      '<div class="sh-test-out" id="sh-test-out"></div>' +

      '<details class="sh-adv">' +
      '<summary>⚙️ 高级选项（稳赢模式 / 策略参数 / 调试日志）</summary>' +

      '<div class="sh-section-title">🛡️ 稳赢-回本模式 <span style="color:#bc4c00;font-weight:normal;font-size:11px;">(v0.3 新增)</span></div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-safe">稳赢模式</label>' +
        '<div class="sh-field-check">' +
          '<input type="checkbox" id="sh-f-safe"/>' +
          '<span style="color:#57606a;font-size:11px;">按 confidence 混合 LLM 概率与市场共识，减少小概率事件误推荐</span>' +
        '</div>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-allow-ls">允许冷门博</label>' +
        '<div class="sh-field-check">' +
          '<input type="checkbox" id="sh-f-allow-ls"/>' +
          '<span style="color:#57606a;font-size:11px;">高赔率+高 EV 时开小仓位（带明显警告和二次确认）</span>' +
        '</div>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-pfinal">主推荐最低胜率</label>' +
        '<input type="number" step="0.05" min="0.5" max="0.95" id="sh-f-pfinal"/>' +
        '<div class="sh-hint">混合胜率 ≥ 此值才归为「稳赢推荐」（0.55 = 55%）</div>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-ls-evmul">冷门 EV 倍数</label>' +
        '<input type="number" step="0.5" min="1" max="10" id="sh-f-ls-evmul"/>' +
        '<div class="sh-hint">冷门 EV 门槛 = 主推荐 EV × 此值（2.0 = 翻倍要求）</div>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-ls-stake">冷门 Kelly 折扣</label>' +
        '<input type="number" step="0.1" min="0.05" max="1" id="sh-f-ls-stake"/>' +
        '<div class="sh-hint">冷门 Kelly 打折（0.3 = 3 折仓位）</div>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-ls-cap">冷门余额上限%</label>' +
        '<input type="number" step="0.01" min="0.01" max="0.5" id="sh-f-ls-cap"/>' +
        '<div class="sh-hint">冷门单笔最多用余额百分比（0.05 = 5%）</div>' +
      '</div>' +

      '<div class="sh-section-title">📊 策略参数</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-temp">temperature</label>' +
        '<input type="number" step="0.1" min="0" max="2" id="sh-f-temp"/>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-kelly">凯利折扣</label>' +
        '<input type="number" step="0.05" min="0" max="1" id="sh-f-kelly"/>' +
        '<div class="sh-hint">0.5 = Half-Kelly（推荐）· 0.25 = Quarter · 1 = Full（不推荐）</div>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-minev">最小 EV</label>' +
        '<input type="number" step="0.01" min="0" max="1" id="sh-f-minev"/>' +
        '<div class="sh-hint">EV 低于此值则不推荐下注（0.05 = 5%）</div>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-pct">单笔上限%</label>' +
        '<input type="number" step="0.01" min="0" max="1" id="sh-f-pct"/>' +
        '<div class="sh-hint">占当前余额百分比（0.15 = 15%）</div>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-min">硬下限</label>' +
        '<input type="number" step="1" min="1" id="sh-f-min"/>' +
        '<div class="sh-hint">站点最低 100 金币</div>' +
      '</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-max">硬上限</label>' +
        '<input type="number" step="1" min="1" id="sh-f-max"/>' +
        '<div class="sh-hint">站点最高 10000 金币</div>' +
      '</div>' +

      '<div class="sh-section-title">🐞 调试</div>' +
      '<div class="sh-field">' +
        '<label for="sh-f-debug">调试日志</label>' +
        '<div class="sh-field-check">' +
          '<input type="checkbox" id="sh-f-debug"/>' +
          '<span style="color:#57606a;font-size:11px;">开启后 console 会输出详细日志</span>' +
        '</div>' +
      '</div>' +

      '</details>';

    m.body.innerHTML = html;

    // -------- 载入当前配置 --------
    const $ = (id) => m.body.querySelector(id);
    const inpBase   = $('#sh-f-baseurl');
    const inpKey    = $('#sh-f-apikey');
    const selModel  = $('#sh-f-model');
    const inpModel  = $('#sh-f-model-input');
    const inpTemp   = $('#sh-f-temp');
    const inpKelly  = $('#sh-f-kelly');
    const inpMinEv  = $('#sh-f-minev');
    const inpPct    = $('#sh-f-pct');
    const inpMinS   = $('#sh-f-min');
    const inpMaxS   = $('#sh-f-max');
    const inpDebug  = $('#sh-f-debug');
    const chkSafeMode = $('#sh-f-safe');
    const chkAllowLS  = $('#sh-f-allow-ls');
    const inpPFinal   = $('#sh-f-pfinal');
    const inpLsEvMul  = $('#sh-f-ls-evmul');
    const inpLsStake  = $('#sh-f-ls-stake');
    const inpLsCap    = $('#sh-f-ls-cap');
    const selPreset = $('#sh-f-preset');
    const noteBox   = $('#sh-preset-note');
    const testOut   = $('#sh-test-out');

    inpBase.value  = cfg(CONFIG_KEYS.baseUrl);
    inpKey.value   = cfg(CONFIG_KEYS.apiKey);
    inpModel.value = cfg(CONFIG_KEYS.model);
    inpTemp.value  = cfg(CONFIG_KEYS.temperature);
    inpKelly.value = cfg(CONFIG_KEYS.kellyFrac);
    inpMinEv.value = cfg(CONFIG_KEYS.minEV);
    inpPct.value   = cfg(CONFIG_KEYS.maxStakePct);
    inpMinS.value  = cfg(CONFIG_KEYS.minStake);
    inpMaxS.value  = cfg(CONFIG_KEYS.maxStake);
    inpDebug.checked = !!cfg(CONFIG_KEYS.debug);
    chkSafeMode.checked = !!cfg(CONFIG_KEYS.safeMode);
    chkAllowLS.checked  = !!cfg(CONFIG_KEYS.allowLongshot);
    inpPFinal.value  = cfg(CONFIG_KEYS.pFinalSafe);
    inpLsEvMul.value = cfg(CONFIG_KEYS.longshotEvMul);
    inpLsStake.value = cfg(CONFIG_KEYS.longshotStakeMul);
    inpLsCap.value   = cfg(CONFIG_KEYS.longshotBalanceCap);

    // -------- 预设下拉 --------
    const optPlaceholder = document.createElement('option');
    optPlaceholder.value = '';
    optPlaceholder.textContent = '— 选择快速填充 —';
    selPreset.appendChild(optPlaceholder);
    for (const p of PROVIDERS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      selPreset.appendChild(o);
    }

    /** 应用预设到表单（不写 GM_setValue，保存时才写） */
    function applyPreset(id) {
      const p = PROVIDERS.find(x => x.id === id);
      if (!p) return;
      if (p.id === 'custom') {
        // 自定义：清空 base_url 与模型下拉，让用户手填
        inpBase.value = '';
        selModel.style.display = 'none';
        inpModel.style.display = '';
        noteBox.style.display = 'none';
        return;
      }
      inpBase.value = p.baseUrl;

      // 填充模型下拉
      selModel.innerHTML = '';
      if (p.models && p.models.length > 0) {
        for (const mo of p.models) {
          const o = document.createElement('option');
          o.value = mo; o.textContent = mo;
          selModel.appendChild(o);
        }
        const oCustom = document.createElement('option');
        oCustom.value = '__custom'; oCustom.textContent = '— 手动输入 —';
        selModel.appendChild(oCustom);
        selModel.value = p.models[0];
        inpModel.value = p.models[0];
        selModel.style.display = '';
        inpModel.style.display = 'none';
      } else {
        selModel.style.display = 'none';
        inpModel.style.display = '';
      }

      // 本地代理无 key
      if (p.id === 'ollama' || p.id === 'copilot-proxy') {
        if (!inpKey.value) inpKey.value = 'x';
      }

      if (p.note) { noteBox.textContent = '📝 ' + p.note; noteBox.style.display = ''; }
      else { noteBox.style.display = 'none'; }
    }

    selPreset.addEventListener('change', () => applyPreset(selPreset.value));

    // 模型下拉切换 → 手动
    selModel.addEventListener('change', () => {
      if (selModel.value === '__custom') {
        selModel.style.display = 'none';
        inpModel.style.display = '';
        inpModel.value = '';
        inpModel.focus();
      } else {
        inpModel.value = selModel.value;
      }
    });

    // -------- 底部按钮 --------
    // 左：测试连通性 + 恢复默认
    const btnTest = document.createElement('button');
    btnTest.type = 'button'; btnTest.className = 'sh-btn2';
    btnTest.textContent = '🔌 测试连通性';
    m.footLeft.appendChild(btnTest);

    const btnReset = document.createElement('button');
    btnReset.type = 'button'; btnReset.className = 'sh-btn2 link';
    btnReset.textContent = '恢复默认';
    m.footLeft.appendChild(btnReset);

    // 右：取消 + 保存
    const btnCancel = document.createElement('button');
    btnCancel.type = 'button'; btnCancel.className = 'sh-btn2';
    btnCancel.textContent = '取消';
    m.footRight.appendChild(btnCancel);

    const btnSave = document.createElement('button');
    btnSave.type = 'button'; btnSave.className = 'sh-btn2 primary';
    btnSave.textContent = '保存';
    m.footRight.appendChild(btnSave);

    btnCancel.addEventListener('click', m.close);

    btnReset.addEventListener('click', () => {
      if (!confirm('恢复所有字段为默认值？（未保存前不会写入）')) return;
      inpBase.value  = DEFAULTS[CONFIG_KEYS.baseUrl];
      // apiKey 不重置（避免误删）
      inpModel.value = DEFAULTS[CONFIG_KEYS.model];
      selModel.style.display = 'none';
      inpModel.style.display = '';
      inpTemp.value  = DEFAULTS[CONFIG_KEYS.temperature];
      inpKelly.value = DEFAULTS[CONFIG_KEYS.kellyFrac];
      inpMinEv.value = DEFAULTS[CONFIG_KEYS.minEV];
      inpPct.value   = DEFAULTS[CONFIG_KEYS.maxStakePct];
      inpMinS.value  = DEFAULTS[CONFIG_KEYS.minStake];
      inpMaxS.value  = DEFAULTS[CONFIG_KEYS.maxStake];
      inpDebug.checked = !!DEFAULTS[CONFIG_KEYS.debug];
      chkSafeMode.checked = !!DEFAULTS[CONFIG_KEYS.safeMode];
      chkAllowLS.checked  = !!DEFAULTS[CONFIG_KEYS.allowLongshot];
      inpPFinal.value  = DEFAULTS[CONFIG_KEYS.pFinalSafe];
      inpLsEvMul.value = DEFAULTS[CONFIG_KEYS.longshotEvMul];
      inpLsStake.value = DEFAULTS[CONFIG_KEYS.longshotStakeMul];
      inpLsCap.value   = DEFAULTS[CONFIG_KEYS.longshotBalanceCap];
      selPreset.value = '';
      noteBox.style.display = 'none';
    });

    function currentModel() {
      if (selModel.style.display !== 'none') return selModel.value === '__custom' ? inpModel.value.trim() : selModel.value;
      return inpModel.value.trim();
    }

    // 测试连通性 —— 用表单当前值，不写库
    btnTest.addEventListener('click', async () => {
      const baseUrl = inpBase.value.trim();
      const apiKey  = inpKey.value.trim();
      const model   = currentModel();
      if (!baseUrl || !apiKey || !model) {
        testOut.className = 'sh-test-out show err';
        testOut.textContent = '❌ 请先填写 base_url / API Key / 模型';
        return;
      }
      testOut.className = 'sh-test-out show';
      testOut.textContent = '⏳ 正在测试...';
      btnTest.disabled = true;
      try {
        // 临时改写运行时配置来复用 callLLM，事后还原
        const backup = {
          baseUrl: cfg(CONFIG_KEYS.baseUrl),
          apiKey:  cfg(CONFIG_KEYS.apiKey),
          model:   cfg(CONFIG_KEYS.model),
          temp:    cfg(CONFIG_KEYS.temperature)
        };
        setCfg(CONFIG_KEYS.baseUrl, baseUrl);
        setCfg(CONFIG_KEYS.apiKey,  apiKey);
        setCfg(CONFIG_KEYS.model,   model);
        try {
          const dummy = {
            title: 'Test', category: '[test]', description: 'ping', liquipediaUrl: null,
            totalPool: 100, balance: 10000,
            choices: [
              { value: '0', name: 'Alpha', odds: 1.5, pool: 60 },
              { value: '1', name: 'Beta',  odds: 3.0, pool: 40 }
            ]
          };
          const r = await callLLM(dummy, '');
          testOut.className = 'sh-test-out show ok';
          testOut.textContent = '✅ LLM 连通\n\n' + JSON.stringify(r, null, 2);
        } finally {
          // 还原（用户没点保存 → 不应留下改动）
          setCfg(CONFIG_KEYS.baseUrl, backup.baseUrl);
          setCfg(CONFIG_KEYS.apiKey,  backup.apiKey);
          setCfg(CONFIG_KEYS.model,   backup.model);
          setCfg(CONFIG_KEYS.temperature, backup.temp);
        }
      } catch (e) {
        testOut.className = 'sh-test-out show err';
        testOut.textContent = '❌ ' + (e && e.message ? e.message : String(e));
      } finally {
        btnTest.disabled = false;
      }
    });

    // 保存 —— 校验+写入
    btnSave.addEventListener('click', () => {
      const baseUrl = inpBase.value.trim();
      const apiKey  = inpKey.value.trim();
      const model   = currentModel();
      if (!baseUrl) { alert('base_url 不能为空'); inpBase.focus(); return; }
      if (!apiKey)  { alert('API Key 不能为空'); inpKey.focus(); return; }
      if (!model)   { alert('模型名不能为空'); (selModel.style.display !== 'none' ? selModel : inpModel).focus(); return; }

      // 展开高级选项（若字段校验失败，需让用户看到出错的输入框）
      const ensureAdvOpen = (el) => {
        const d = el && el.closest && el.closest('details.sh-adv');
        if (d && !d.open) d.open = true;
      };

      const nums = [
        { el: inpTemp,    key: CONFIG_KEYS.temperature,        name: 'temperature' },
        { el: inpKelly,   key: CONFIG_KEYS.kellyFrac,          name: '凯利折扣' },
        { el: inpMinEv,   key: CONFIG_KEYS.minEV,              name: '最小 EV' },
        { el: inpPct,     key: CONFIG_KEYS.maxStakePct,        name: '单笔上限%' },
        { el: inpMinS,    key: CONFIG_KEYS.minStake,           name: '硬下限' },
        { el: inpMaxS,    key: CONFIG_KEYS.maxStake,           name: '硬上限' },
        { el: inpPFinal,  key: CONFIG_KEYS.pFinalSafe,         name: '主推荐最低胜率' },
        { el: inpLsEvMul, key: CONFIG_KEYS.longshotEvMul,      name: '冷门 EV 倍数' },
        { el: inpLsStake, key: CONFIG_KEYS.longshotStakeMul,   name: '冷门 Kelly 折扣' },
        { el: inpLsCap,   key: CONFIG_KEYS.longshotBalanceCap, name: '冷门余额上限%' }
      ];
      for (const n of nums) {
        const v = Number(n.el.value);
        if (!isFinite(v)) { ensureAdvOpen(n.el); alert(n.name + ' 无效：' + n.el.value); n.el.focus(); return; }
      }

      setCfg(CONFIG_KEYS.baseUrl, baseUrl);
      setCfg(CONFIG_KEYS.apiKey,  apiKey);
      setCfg(CONFIG_KEYS.model,   model);
      for (const n of nums) setCfg(n.key, Number(n.el.value));
      setCfg(CONFIG_KEYS.debug, !!inpDebug.checked);
      setCfg(CONFIG_KEYS.safeMode,      !!chkSafeMode.checked);
      setCfg(CONFIG_KEYS.allowLongshot, !!chkAllowLS.checked);

      m.close();
      // 用轻量提示替代 alert（避免打断）
      if (typeof GM_notification === 'function') {
        try { GM_notification({ title: 'SCBOY-Bet', text: '✅ 设置已保存', timeout: 2500 }); }
        catch (_) { alert('✅ 设置已保存'); }
      } else {
        alert('✅ 设置已保存');
      }
    });

    // 首次打开：如果当前 base_url 匹配某预设，自动选中并填充模型下拉
    (function autoDetectPreset() {
      const curBase = cfg(CONFIG_KEYS.baseUrl);
      const curModel = cfg(CONFIG_KEYS.model);
      const match = PROVIDERS.find(p => p.id !== 'custom' && p.baseUrl === curBase);
      if (!match) return;
      selPreset.value = match.id;
      // 填充模型下拉；若当前模型在预设列表里 → 选中；否则显示手动输入
      selModel.innerHTML = '';
      let found = false;
      for (const mo of (match.models || [])) {
        const o = document.createElement('option');
        o.value = mo; o.textContent = mo;
        selModel.appendChild(o);
        if (mo === curModel) found = true;
      }
      const oCustom = document.createElement('option');
      oCustom.value = '__custom'; oCustom.textContent = '— 手动输入 —';
      selModel.appendChild(oCustom);

      if (found) {
        selModel.value = curModel;
        selModel.style.display = '';
        inpModel.style.display = 'none';
      } else {
        selModel.value = '__custom';
        selModel.style.display = 'none';
        inpModel.style.display = '';
      }
      if (match.note) { noteBox.textContent = '📝 ' + match.note; noteBox.style.display = ''; }
    })();
  }

  // ============================================================
  // 辅助
  // ============================================================
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * 渲染「LLM vs 市场分歧」行：
   *   市场隐含胜率 = 该侧资金池 / 总池（是市场共识，不是真概率）
   *   分歧 = LLM 胜率 − 市场隐含胜率（>0 = LLM 认为该侧被市场低估，EV 正来源）
   *   分歧绝对值越大，越"偏离市场"；这是本脚本产生正 EV 的唯一来源。
   */
  function renderDivergenceRow(detail, prediction) {
    if (!detail || !detail.choices || detail.choices.length < 2) return '';
    const cs = detail.choices;
    const total = cs.reduce((s, c) => s + (c.pool || 0), 0);
    if (total <= 0) return '';
    const fmt = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
    const cls = v => Math.abs(v) < 0.03 ? '' : (v > 0 ? 'sh-pos' : 'sh-neg');

    const parts = cs.map((c, i) => {
      const m = (c.pool || 0) / total;
      const d = prediction.probs[i] - m;
      return `${escapeHtml(c.name)}: LLM ${(prediction.probs[i]*100).toFixed(1)}% − 市场 ${(m*100).toFixed(1)}% = <b class="${cls(d)}">${fmt(d)}</b>`;
    });

    return `
      <div class="sh-row" style="margin-top:4px;display:block;">
        <div class="k" style="margin-bottom:2px;">LLM vs 市场</div>
        <div class="v" style="font-size:11px;line-height:1.7;">${parts.join(' · ')}</div>
      </div>
      <div class="sh-row" style="font-size:11px;color:#57606a;">
        <span class="k"></span>
        <span class="v">分歧 &gt; 0 = LLM 认为该侧被市场低估 → 正 EV 来源；分歧越大越"偏离市场"。</span>
      </div>
    `;
  }

  // ============================================================
  // 列表页徽章注入
  // ============================================================
  function isListPage() {
    // 列表页典型特征：路径为 / 或空，且页面存在 li.media.thread
    const path = location.pathname || '/';
    if (path !== '/' && path !== '/index.php' && path !== '') return false;
    return !!document.querySelector('li.media.thread');
  }

  /** 从列表 li 里找到跳详情的 <a> 与 bet id */
  function extractRowLink(li) {
    // 首选 href 匹配 bet-detail-N.htm 的链接
    const anchors = Array.from(li.querySelectorAll('a[href]'));
    for (const a of anchors) {
      const id = extractBetId(a.getAttribute('href') || '');
      if (id) return { anchor: a, id, href: a.href };
    }
    return null;
  }

  /** 把已有缓存的 Tier 1 立即渲染到徽章 */
  function renderTier1(badgeEl, tier1) {
    if (!tier1) {
      badgeEl.className = 'sh-list-badge pending';
      badgeEl.textContent = '⚪ 未分析';
      return;
    }
    if (tier1.unknown) {
      badgeEl.className = 'sh-list-badge warn';
      badgeEl.textContent = '⚠️ ' + (tier1.reason || '池为空');
      badgeEl.title = tier1.reason ? ('跳过原因：' + tier1.reason) : '';
      return;
    }
    const markets = tier1.markets || [];
    if (markets.length === 0) {
      badgeEl.className = 'sh-list-badge warn';
      badgeEl.textContent = '⚠️ 无选项';
      return;
    }
    // 显示领跑者 + K 选一标记（K>2 时加）
    const sorted = markets.slice().sort((a, b) => b.market - a.market);
    const leader = sorted[0];
    const leadPct = Math.round(leader.market * 100);
    const imbPct  = Math.round(tier1.imbalance * 100);
    const kTag    = tier1.K > 2 ? ` (${tier1.K}选1)` : '';
    badgeEl.className = 'sh-list-badge info';
    badgeEl.textContent = `🔵 ${leader.name || '?'} ${leadPct}%${kTag} · 失衡 ${imbPct}%`;
    badgeEl.title =
      `市场共识（按资金池比例，不是真概率）\n` +
      markets.map(m =>
        `  ${m.name}: ${(m.market*100).toFixed(1)}%  池 ${m.pool}  赔率 1:${m.odds}`
      ).join('\n') +
      `\n失衡 = 最高% − 最低% = ${(tier1.imbalance*100).toFixed(1)}%\n` +
      (tier1.alreadyBet ? '（该场你已下注）' : '');
  }

  function injectListBadges() {
    const rows = Array.from(document.querySelectorAll('li.media.thread'));
    if (rows.length === 0) return;

    let injected = 0;
    for (const li of rows) {
      if (injected >= LIST_MAX_ROWS) break;
      if (li.querySelector('.sh-list-tools')) continue;  // 已注入

      // 只处理"竞猜中"的行
      const rowText = li.textContent || '';
      if (!/竞猜中/.test(rowText)) continue;

      const link = extractRowLink(li);
      if (!link) continue;

      injected++;

      const tools = document.createElement('span');
      tools.className = 'sh-list-tools';
      tools.setAttribute('data-bet-id', link.id);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sh-list-btn';
      btn.textContent = '🔍 分析';
      btn.title = 'Tier 1 分析：抓详情页 → 显示市场隐含胜率与失衡。不调用 LLM。';

      const badge = document.createElement('span');
      badge.className = 'sh-list-badge pending';
      badge.textContent = '⚪ 未分析';

      tools.appendChild(btn);
      tools.appendChild(badge);

      // 尝试插到链接后面；否则追加到 li 尾
      if (link.anchor && link.anchor.parentNode) {
        link.anchor.parentNode.insertBefore(tools, link.anchor.nextSibling);
      } else {
        li.appendChild(tools);
      }

      // 有缓存则直接渲染
      const cached = readCache(link.id);
      if (cached && cached.tier1) {
        renderTier1(badge, cached.tier1);
        const ageMin = Math.max(1, Math.round((Date.now() - cached.ts) / 60000));
        badge.textContent += ` · ⏱${ageMin}m 前`;
        badge.title = (badge.title || '') + `\n（缓存于 ${new Date(cached.ts).toLocaleTimeString()}，TTL 15 分钟；到期前不再重复请求）`;
      }

      btn.addEventListener('click', (ev) => {
        // 关键：阻止冒泡到父 <a>（否则会跳转到详情页）
        ev.preventDefault();
        ev.stopPropagation();
        if (btn.disabled) return;
        btn.disabled = true;
        badge.className = 'sh-list-badge loading';
        badge.textContent = '⏳ 抓详情…';
        badge.title = '';
        info('click →', link.id, link.href);

        listLimiter(async () => {
          await jitter(150, 600);   // 随机抖动，避免瞬时并发
          info('fetching', link.id);
          const detail = await fetchDetailByUrl(link.href);
          const tier1 = computeTier1(detail);
          writeCache(link.id, tier1);
          return tier1;
        })
          .then(tier1 => {
            info('done', link.id, tier1);
            renderTier1(badge, tier1);
          })
          .catch(e => {
            err('list Tier1 failed:', link.id, e && e.message ? e.message : e);
            badge.className = 'sh-list-badge err';
            badge.textContent = '❌ 失败';
            badge.title = (e && e.message) ? e.message : String(e);
          })
          .finally(() => { btn.disabled = false; });
      });

      // 存下引用便于后续 auto-scan 触发
      tools._shBtn = btn;
      tools._shCached = !!(cached && cached.tier1);
    }
    info('list badges injected:', injected);

    // 如果打开了"自动扫描"开关，把没缓存的行按顺序触发一遍
    // （listLimiter 控制真正的并发，这里只是排队进闸门）
    if (cfg(CONFIG_KEYS.listAutoScan)) {
      const pending = Array.from(document.querySelectorAll('.sh-list-tools'))
        .filter(t => !t._shCached && t._shBtn && !t._shBtn.disabled);
      if (pending.length > 0) {
        log('auto-scan triggered for', pending.length, 'rows');
        pending.forEach((t, i) => {
          // 每个按 200ms 间隔排队，避免瞬时全部进闸门
          setTimeout(() => { try { t._shBtn.click(); } catch (_) {} }, i * 200);
        });
      } else {
        log('auto-scan: all rows cached, nothing to do');
      }
    }
  }

  // ============================================================
  // 入口
  // ============================================================
  function main() {
    injectStyles();

    GM_registerMenuCommand('⚙️ 打开设置面板 (LLM / 策略 / 测试连通性)', openSettings);
    GM_registerMenuCommand(
      (cfg(CONFIG_KEYS.listAutoScan) ? '✅' : '⬜') + ' 列表页自动扫描（15 分缓存）',
      () => {
        const v = !cfg(CONFIG_KEYS.listAutoScan);
        setCfg(CONFIG_KEYS.listAutoScan, v);
        alert('列表页自动扫描已 ' + (v ? '开启' : '关闭') + '\n\n刷新页面生效。命中缓存的场次不会重复请求。');
      }
    );
    GM_registerMenuCommand('🧹 清空列表页缓存', () => {
      // 逐个删 GM_setValue 键；GM_listValues 不是所有引擎都有，做兼容
      let cleared = 0;
      try {
        if (typeof GM_listValues === 'function') {
          const keys = GM_listValues();
          for (const k of keys) {
            if (typeof k === 'string' && k.indexOf(LIST_CACHE_PREFIX) === 0) {
              try { GM_deleteValue(k); cleared++; } catch (_) {}
            }
          }
        }
      } catch (e) { warn('clear cache failed:', e.message); }
      alert('已清除 ' + cleared + ' 条列表缓存。刷新页面生效。');
    });
    GM_registerMenuCommand('🧹 清空详情页 LLM 缓存', () => {
      let cleared = 0;
      try {
        if (typeof GM_listValues === 'function') {
          const keys = GM_listValues();
          for (const k of keys) {
            if (typeof k === 'string' && k.indexOf(PRED_CACHE_PREFIX) === 0) {
              try { GM_deleteValue(k); cleared++; } catch (_) {}
            }
          }
        }
      } catch (e) { warn('clear pred cache failed:', e.message); }
      alert('已清除 ' + cleared + ' 条 LLM 分析缓存。刷新页面生效。');
    });
    GM_registerMenuCommand('🐞 切换调试日志',                     () => {
      const v = !cfg(CONFIG_KEYS.debug);
      setCfg(CONFIG_KEYS.debug, v);
      alert('调试日志已 ' + (v ? '开启' : '关闭'));
    });

    // 分支 1：详情页 —— 注入分析面板
    if (isDetailPage()) {
      const detail = parseDetail();
      if (!detail) { warn('parseDetail 返回 null'); return; }
      if (detail.alreadyBet) { log('already bet, skip panel'); return; }
      if (detail.choices.length < 2) {
        log('less than 2 choices, skip', detail.choices.length);
        return;
      }
      createPanel(detail);
      log('panel injected', detail);
      return;
    }

    // 分支 2：列表页 —— 注入 Tier 1 徽章（最多 20 条）
    if (isListPage()) {
      injectListBadges();
      return;
    }

    log('not detail/list page, skip');
  }

  main();
})();
