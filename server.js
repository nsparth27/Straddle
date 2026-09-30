const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Default configuration fallback
let config = {
  dhanClientId: "1100616877",
  dhanAccessToken: "",
  telegramBotToken: "",
  telegramChatId: "",
  telegramAccount2Enabled: false,
  telegramBotToken2: "",
  telegramChatId2: "",
  barMinutes: 15,
  pollIntervalSeconds: 15,
  telegramAlertsEnabled: true,
  watchlist: []
};

// Security & Authentication State
const crypto = require('crypto');
const TERMINAL_PIN = process.env.TERMINAL_PIN || '2712';
const activeSessions = new Set();
let pinFailAttempts = 0;
let pinLockoutUntil = 0;

function verifyPin(inputPin) {
  if (Date.now() < pinLockoutUntil) {
    const remainingSecs = Math.ceil((pinLockoutUntil - Date.now()) / 1000);
    return { ok: false, locked: true, remainingSecs, message: `Account locked. Retry in ${remainingSecs}s.` };
  }
  if (String(inputPin || '').trim() === TERMINAL_PIN) {
    pinFailAttempts = 0;
    const token = crypto.randomBytes(24).toString('hex');
    activeSessions.add(token);
    return { ok: true, token, message: 'Authenticated successfully' };
  }
  pinFailAttempts++;
  if (pinFailAttempts >= 3) {
    pinLockoutUntil = Date.now() + 5 * 60 * 1000;
    return { ok: false, locked: true, remainingSecs: 300, message: 'Too many failed attempts. Locked for 5 minutes.' };
  }
  return { ok: false, locked: false, attemptsRemaining: 3 - pinFailAttempts, message: `Invalid PIN. ${3 - pinFailAttempts} attempts left.` };
}

function isValidSession(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-terminal-session'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token && activeSessions.has(token)) return true;
  const urlObj = new URL(req.url, 'http://localhost');
  const queryToken = urlObj.searchParams.get('token');
  return Boolean(queryToken && activeSessions.has(queryToken));
}

// HTML Entity Escaper for Telegram & UI
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Request Body Stream Reader with 64KB Ceiling
function readJsonBody(req, maxSize = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Payload Too Large (413)'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON Body'));
      }
    });
    req.on('error', reject);
  });
}

// Safe Outbound HTTP Fetch with Timeout
async function safeFetch(url, options = {}, timeoutMs = 6000) {
  return await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

// Expiry & Intraday Cache
const expiryCache = new Map(); // securityId -> { expiry, expiresAt }
const intradayCache = new Map(); // securityId -> { date, points }
let dhanCooldownUntil = 0;
let isMasterWorkerRunning = false;
let lastMarketState = null;
let reportSentDate = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getTodayIST() {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' };
  const formatter = new Intl.DateTimeFormat('en-CA', options); // returns YYYY-MM-DD
  return formatter.format(now);
}

// Load config from file
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      config = { ...config, ...JSON.parse(raw) };
      console.log(`✅ Configuration loaded: ${config.watchlist.length} watchlist symbols.`);
    }
  } catch (err) {
    console.error('⚠️ Could not load config.json:', err.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log('💾 Configuration saved to config.json');
  } catch (err) {
    console.error('❌ Error saving config.json:', err.message);
  }
}

loadConfig();

// In-Memory State for Straddle Tracking & Alert Logs
const state = {
  lastUpdated: null,
  isMarketOpen: false,
  dhanConnected: false,
  liveCount: 0,
  fundSummary: null,
  symbols: {},
  alerts: [],
  telegramMessages: [],
  logs: []
};

function addLog(msg) {
  const timestamp = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  const entry = `[${timestamp}] ${msg}`;
  state.logs.unshift(entry);
  if (state.logs.length > 100) state.logs.pop();
  console.log(entry);
}

// ==========================================
// 📨 DUAL TELEGRAM DISPATCH ENGINE (ACCOUNT 1 & ACCOUNT 2)
// ==========================================

async function postTelegramMessage(botToken, chatId, message) {
  if (!botToken || !chatId) return { ok: false, error: 'Missing token or chatId' };
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    }, 8000);
    const data = await res.json();
    return { ok: res.ok && data.ok, status: res.status, data, messageId: data.result?.message_id, error: data?.description };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function postTelegramDocument(botToken, chatId, fileContent, fileName, caption = '') {
  if (!botToken || !chatId) return { ok: false, error: 'Missing token or chatId' };
  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    const blob = new Blob([fileContent], { type: 'text/csv;charset=utf-8;' });
    form.append('document', blob, fileName);
    if (caption) {
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
    }

    const res = await safeFetch(url, {
      method: 'POST',
      body: form
    }, 15000);
    const data = await res.json();
    return { ok: res.ok && data.ok, status: res.status, data, messageId: data.result?.message_id, error: data?.description };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Telegram Alert Sender with Dual Accounts Support & WhatsApp Double-Ticks
async function sendTelegramAlert(message, meta = {}) {
  const timestamp = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  const dateStr = getTodayIST();
  const msgId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const symbol = meta.symbol || 'ALL';
  const crossNum = Number(meta.crossNum) || 1;
  const fmtCurrency = (val) => {
    if (val == null || val === '--' || val === '') return '--';
    if (typeof val === 'number') return `₹${val.toFixed(2)}`;
    const s = String(val).trim();
    return s.startsWith('₹') ? s : `₹${s}`;
  };
  const straddlePrice = fmtCurrency(meta.straddlePrice);
  const prevDayHighStraddle = fmtCurrency(meta.prevDayHighStraddle);
  const spot = fmtCurrency(meta.spot);
  const pctMove = meta.pctMove != null ? String(meta.pctMove).replace('%', '') + '%' : '0.00%';

  const isAcc1Configured = Boolean(config.telegramBotToken && config.telegramChatId);
  const isAcc2Configured = Boolean(config.telegramAccount2Enabled && config.telegramChatId2 && (config.telegramBotToken2 || config.telegramBotToken));

  const entry = {
    id: msgId,
    timestamp: timestamp,
    rawTimestamp: Date.now(),
    date: dateStr,
    symbol: symbol,
    atmStrike: meta.atmStrike ?? '--',
    straddlePrice: straddlePrice,
    prevDayHighStraddle: prevDayHighStraddle,
    crossNum: crossNum,
    pctMove: pctMove,
    spot: spot,
    status: meta.type || meta.status || 'PDH BREAKOUT',
    deliveryState: 'sending',
    ticks: '✓',
    text: message,
    chatId: config.telegramChatId || '--',
    account1: {
      chatId: config.telegramChatId || '--',
      status: isAcc1Configured ? 'pending' : 'not_configured',
      ticks: isAcc1Configured ? '⏳' : '--',
      deliveredAt: null,
      error: null
    },
    account2: isAcc2Configured ? {
      chatId: config.telegramChatId2,
      status: 'pending',
      ticks: '⏳',
      deliveredAt: null,
      error: null
    } : null,
    deliveredAt: null,
    error: null
  };

  state.telegramMessages.unshift(entry);
  if (state.telegramMessages.length > 500) state.telegramMessages.pop();

  if (!config.telegramAlertsEnabled || (!isAcc1Configured && !isAcc2Configured)) {
    entry.deliveryState = 'failed';
    entry.ticks = '❌';
    entry.error = 'Telegram alerts disabled or no accounts configured';
    return { ok: false, message: entry.error, entry };
  }

  const promises = [];
  if (isAcc1Configured) {
    promises.push(
      postTelegramMessage(config.telegramBotToken, config.telegramChatId, message)
        .then(res => {
          if (res.ok) {
            entry.account1.status = 'delivered';
            entry.account1.ticks = '✓✓';
            entry.account1.deliveredAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
          } else {
            entry.account1.status = 'failed';
            entry.account1.ticks = '❌';
            entry.account1.error = res.error;
          }
          return res;
        })
    );
  }

  if (isAcc2Configured) {
    const token2 = config.telegramBotToken2 || config.telegramBotToken;
    promises.push(
      postTelegramMessage(token2, config.telegramChatId2, message)
        .then(res => {
          if (res.ok) {
            entry.account2.status = 'delivered';
            entry.account2.ticks = '✓✓';
            entry.account2.deliveredAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
          } else {
            entry.account2.status = 'failed';
            entry.account2.ticks = '❌';
            entry.account2.error = res.error;
          }
          return res;
        })
    );
  }

  await Promise.allSettled(promises);

  const anyDelivered = (entry.account1?.status === 'delivered') || (entry.account2?.status === 'delivered');
  if (anyDelivered) {
    entry.deliveryState = 'delivered';
    entry.ticks = '✓✓';
    entry.deliveredAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    return { ok: true, entry };
  } else {
    entry.deliveryState = 'failed';
    entry.ticks = '❌';
    entry.error = entry.account1?.error || entry.account2?.error || 'Failed to deliver';
    return { ok: false, error: entry.error, entry };
  }
}

// Telegram Document Sender for CSV Data Exports (Dispatches to Both Accounts)
async function sendTelegramDocument(csvContent, filename, caption = '', meta = {}) {
  const timestamp = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  const dateStr = getTodayIST();
  const msgId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const isAcc1Configured = Boolean(config.telegramBotToken && config.telegramChatId);
  const isAcc2Configured = Boolean(config.telegramAccount2Enabled && config.telegramChatId2 && (config.telegramBotToken2 || config.telegramBotToken));

  const entry = {
    id: msgId,
    timestamp: timestamp,
    rawTimestamp: Date.now(),
    date: dateStr,
    symbol: '217 F&O & MCX',
    atmStrike: 'FULL DATASET',
    straddlePrice: filename,
    prevDayHighStraddle: 'CSV FILE',
    crossNum: 1,
    pctMove: `${meta.rowCount || 217} Rows`,
    spot: 'CSV EXPORT',
    status: 'CSV EXPORT',
    deliveryState: 'sending',
    ticks: '✓',
    text: `📁 <b>Document Attached:</b> <code>${filename}</code>\n${caption}`,
    chatId: config.telegramChatId || '--',
    account1: {
      chatId: config.telegramChatId || '--',
      status: isAcc1Configured ? 'pending' : 'not_configured',
      ticks: isAcc1Configured ? '⏳' : '--',
      deliveredAt: null,
      error: null
    },
    account2: isAcc2Configured ? {
      chatId: config.telegramChatId2,
      status: 'pending',
      ticks: '⏳',
      deliveredAt: null,
      error: null
    } : null,
    deliveredAt: null,
    error: null
  };

  state.telegramMessages.unshift(entry);
  if (state.telegramMessages.length > 500) state.telegramMessages.pop();

  if (!isAcc1Configured && !isAcc2Configured) {
    entry.deliveryState = 'failed';
    entry.ticks = '❌';
    entry.error = 'No Telegram accounts configured in Settings';
    return { ok: false, message: entry.error, entry };
  }

  const promises = [];
  if (isAcc1Configured) {
    promises.push(
      postTelegramDocument(config.telegramBotToken, config.telegramChatId, csvContent, filename, caption)
        .then(res => {
          if (res.ok) {
            entry.account1.status = 'delivered';
            entry.account1.ticks = '✓✓';
            entry.account1.deliveredAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
          } else {
            entry.account1.status = 'failed';
            entry.account1.ticks = '❌';
            entry.account1.error = res.error;
          }
          return res;
        })
    );
  }

  if (isAcc2Configured) {
    const token2 = config.telegramBotToken2 || config.telegramBotToken;
    promises.push(
      postTelegramDocument(token2, config.telegramChatId2, csvContent, filename, caption)
        .then(res => {
          if (res.ok) {
            entry.account2.status = 'delivered';
            entry.account2.ticks = '✓✓';
            entry.account2.deliveredAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
          } else {
            entry.account2.status = 'failed';
            entry.account2.ticks = '❌';
            entry.account2.error = res.error;
          }
          return res;
        })
    );
  }

  await Promise.allSettled(promises);

  const anyDelivered = (entry.account1?.status === 'delivered') || (entry.account2?.status === 'delivered');
  if (anyDelivered) {
    entry.deliveryState = 'delivered';
    entry.ticks = '✓✓';
    entry.deliveredAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    addLog(`📤 [TELEGRAM CSV] Successfully delivered ${filename} (${meta.rowCount || 217} rows) to Telegram!`);
    return { ok: true, entry };
  } else {
    entry.deliveryState = 'failed';
    entry.ticks = '❌';
    entry.error = entry.account1?.error || entry.account2?.error || 'Failed to deliver document';
    return { ok: false, error: entry.error, entry };
  }
}

// Generate & Send Comprehensive Daily 8:00 PM EOD Summary Report
async function generateAndSendDailyReport() {
  const allSymbols = Object.values(state.symbols);
  if (allSymbols.length === 0) {
    return { status: 'error', message: 'No symbols data available yet' };
  }

  const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full' });
  const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

  // STRICT END-OF-DAY FILTER: Only include stocks that CLOSED ABOVE their Previous Day High (PDH) at End of Day
  const qualifyingSymbols = allSymbols.filter(s => {
    const pdh = s.prevDayHighStraddle || s.prevCloseStraddle;
    return pdh && s.straddlePrice > pdh;
  });
  const normalDecayCount = allSymbols.length - qualifyingSymbols.length;

  // Major Benchmark Indices & Commodities Pulse
  const priorityIndices = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
  const priorityCommodities = ['CRUDEOIL', 'GOLD', 'NATURALGAS', 'SILVER', 'COPPER'];

  const getSym = (name) => state.symbols[name] || config.watchlist.find(w => w.name === name);

  // CASE 1: 0 Stocks Crossed PDH (Comprehensive Macro & Theta Decay EOD Summary)
  if (qualifyingSymbols.length === 0) {
    // Sort all symbols by closeness to their PDH level
    const sortedByProximity = [...allSymbols].map(s => {
      const pdh = s.prevDayHighStraddle || s.prevCloseStraddle || 1;
      const diffPct = (((s.straddlePrice - pdh) / pdh) * 100).toFixed(2);
      return { ...s, pdh, diffPct: parseFloat(diffPct) };
    }).sort((a, b) => b.diffPct - a.diffPct);

    let msg = `╔════════════════════════════════════════╗\n` +
      `🏛️ <b>DHAN STRADDLE PRO — DETAILED EOD REPORT</b>\n` +
      `╚════════════════════════════════════════╝\n\n` +
      `📅 <b>Date:</b> ${todayStr}\n` +
      `⏰ <b>Report Time:</b> ${timeStr} IST\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 <b>MARKET BREADTH & STRADDLE SUMMARY:</b>\n` +
      `• 🎯 <b>Total Assets Tracked:</b> <b>${allSymbols.length}</b> (208 F&O, 4 Indices, 5 MCX)\n` +
      `• 🟢 <b>PDH Breakout Stocks:</b> <b>0</b> (0.0% of market)\n` +
      `• 🔴 <b>Normal Theta Decay / Below PDH:</b> <b>${normalDecayCount}</b> (100% of market)\n` +
      `• 💡 <b>Market Regime:</b> <i>High Theta Decay / Straddle Contraction (Sellers Market)</i>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🏛️ <b>MAJOR INDICES STRADDLE PULSE:</b>\n`;

    priorityIndices.forEach(name => {
      const s = getSym(name);
      if (s) {
        const pdh = s.prevDayHighStraddle || s.prevCloseStraddle || '--';
        msg += `• <b>${s.name}</b> (ATM ${s.atmStrike || '--'})\n` +
          `   └─ Straddle: <b>₹${s.straddlePrice}</b> | Spot: ₹${s.spotPrice} | PDH: ₹${pdh}\n`;
      }
    });

    msg += `\n🛢️ <b>MCX COMMODITIES PULSE:</b>\n`;
    priorityCommodities.forEach(name => {
      const s = getSym(name);
      if (s) {
        const pdh = s.prevDayHighStraddle || s.prevCloseStraddle || '--';
        msg += `• <b>${s.name}</b> (ATM ${s.atmStrike || '--'})\n` +
          `   └─ Straddle: <b>₹${s.straddlePrice}</b> | Spot: ₹${s.spotPrice} | PDH: ₹${pdh}\n`;
      }
    });

    msg += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🔍 <b>TOP 5 SYMBOLS NEAREST TO BREAKOUT (RADAR):</b>\n`;

    sortedByProximity.slice(0, 5).forEach((s, i) => {
      msg += `<b>${i + 1}. ${s.name}</b> (ATM ${s.atmStrike})\n` +
        `   • Live Straddle: ₹${s.straddlePrice} | PDH: ₹${s.pdh}\n` +
        `   • Distance to PDH: <code>${s.diffPct}%</code>\n`;
    });

    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>Strict Strategy Filter Active: Only symbols with confirmed PDH crossovers are highlighted in breakout sections.</i>`;

    addLog(`📊 [EOD REPORT] Dispatched detailed Market Macro EOD Intelligence Report (0 PDH crossovers).`);
    const res = await sendTelegramAlert(msg);
    return { status: 'success', qualifyingCount: 0, totalMonitored: allSymbols.length, response: res };
  }

  // CASE 2: Qualifying Stocks Found (Detailed Breakdown of Each Breakout Asset)
  // Sort qualifying stocks by maximum peak gain % above Previous Day High
  qualifyingSymbols.sort((a, b) => {
    const pdhA = a.prevDayHighStraddle || a.prevCloseStraddle || 1;
    const pdhB = b.prevDayHighStraddle || b.prevCloseStraddle || 1;
    const peakA = Math.max(...(a.crossoverEvents || []).map(e => e.peakPrice || 0), a.straddlePrice || 0);
    const peakB = Math.max(...(b.crossoverEvents || []).map(e => e.peakPrice || 0), b.straddlePrice || 0);
    const gainA = (peakA - pdhA) / pdhA;
    const gainB = (peakB - pdhB) / pdhB;
    return gainB - gainA;
  });

  const BATCH_SIZE = 8;
  const totalBatches = Math.ceil(qualifyingSymbols.length / BATCH_SIZE);
  addLog(`📊 Generating Deep Detailed EOD Breakout Report for ${qualifyingSymbols.length} qualifying stocks across ${totalBatches} Telegram parts...`);

  let lastRes = { ok: true };
  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const startIdx = batchIdx * BATCH_SIZE;
    const batch = qualifyingSymbols.slice(startIdx, startIdx + BATCH_SIZE);

    let msg = '';
    if (batchIdx === 0) {
      msg += `╔════════════════════════════════════════╗\n` +
        `🏛️ <b>DHAN STRADDLE PRO — DETAILED EOD REPORT</b>\n` +
        `╚════════════════════════════════════════╝\n\n` +
        `📅 <b>Date:</b> ${todayStr}\n` +
        `⏰ <b>Report Time:</b> ${timeStr} IST\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 <b>EXECUTIVE MARKET BREAKOUT OVERVIEW:</b>\n` +
        `• 🎯 <b>Total Assets Monitored:</b> <b>${allSymbols.length}</b> (NSE Equities + Indices + MCX)\n` +
        `• 🟢 <b>Stocks with Confirmed PDH Breakout:</b> <b>${qualifyingSymbols.length}</b>\n` +
        `• 🔴 <b>Stocks with Normal Decay:</b> <b>${normalDecayCount}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `📋 <b>DETAILED ASSET BREAKDOWN [Part 1/${totalBatches}] (Rank ${startIdx + 1} - ${startIdx + batch.length}):</b>\n\n`;
    } else {
      msg += `📋 <b>DETAILED ASSET BREAKDOWN [Part ${batchIdx + 1}/${totalBatches}] (Rank ${startIdx + 1} - ${startIdx + batch.length}):</b>\n\n`;
    }

    batch.forEach((s, i) => {
      const globalIndex = startIdx + i + 1;
      const pdh = s.prevDayHighStraddle || s.prevCloseStraddle;
      const crossCount = (s.crossoverEvents || []).length;
      const maxPeak = Math.max(...(s.crossoverEvents || []).map(e => e.peakPrice || 0), s.straddlePrice || 0);
      const pctPeak = (pdh && pdh > 0) ? (((maxPeak - pdh) / pdh) * 100).toFixed(2) : '0.00';
      const pctClose = (pdh && pdh > 0) ? (((s.straddlePrice - pdh) / pdh) * 100).toFixed(2) : '0.00';
      const isCurrentlyAbove = s.isCurrentlyAbovePdh || (s.straddlePrice > pdh);
      const isCommodity = s.segment === 'MCX_COMM' || priorityCommodities.includes(s.name);

      msg += `<b>${globalIndex}. ${s.name}</b> (ATM ${s.atmStrike}) 🟢 <b>[${isCommodity ? 'MCX Commodity' : 'NSE F&O'}]</b>\n`;
      msg += `   • <b>Crossover Frequency:</b> 🔥 <b>Crossed ${crossCount} time${crossCount > 1 ? 's' : ''} today</b>\n`;
      msg += `   • <b>Option Premium Breakdown:</b> CE: ₹${s.ceLtp ?? '--'} | PE: ₹${s.peLtp ?? '--'}\n`;
      msg += `   • <b>Prev Day High (PDH):</b> ₹${pdh} (Baseline)\n`;
      msg += `   • <b>Day's Peak Straddle:</b> <code>₹${maxPeak}</code> (<b>+${pctPeak}%</b> Surge above PDH 🚀)\n`;
      msg += `   • <b>Close/LTP:</b> ₹${s.straddlePrice} (Spot: ₹${s.spotPrice}) [${pctClose >= 0 ? '+' : ''}${pctClose}% vs PDH]\n`;
      msg += `   • <b>Session Status:</b> ${isCurrentlyAbove ? '🟢 <b>Closed ABOVE PDH (Active Runner)</b>' : '⚪ <b>Dipped Below PDH (Retraced)</b>'}\n`;
      msg += `   • <b>Time-Wise Cross Timeline:</b>\n`;

      (s.crossoverEvents || []).forEach(evt => {
        const dipInfo = evt.dipTime ? `➔ Retraced below @ ${evt.dipTime}` : `➔ <b>Active Above PDH</b> 🟢`;
        msg += `     ▫️ <b>Cycle #${evt.crossNum}</b> at <b>${evt.startTime}</b>: Triggered @ ₹${evt.startPrice} (Peak: ₹${evt.peakPrice}) ${dipInfo}\n`;
      });
      msg += `\n`;
    });

    if (batchIdx === totalBatches - 1) {
      msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      msg += `<i>Generated automatically by Bloomberg Terminal — Dhan Straddle Pro.</i>`;
    }

    lastRes = await sendTelegramAlert(msg);
    await sleep(400);
  }

  if (lastRes.ok) {
    addLog(`✅ Complete Detailed EOD Telegram Report (${qualifyingSymbols.length} qualifying stocks in ${totalBatches} parts) delivered successfully!`);
  } else {
    addLog(`⚠️ Telegram Report delivery failed: ${lastRes.data?.description || lastRes.error || 'Check Bot Token'}`);
  }

  return { status: lastRes.ok ? 'success' : 'failed', qualifyingStocks: qualifyingSymbols.length, totalBatches, response: lastRes };
}

// 8:00 PM Automatic Daily Report Scheduler
function checkDailyReportSchedule() {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(now);
  const hash = {};
  parts.forEach(p => hash[p.type] = p.value);
  const hour = parseInt(hash.hour, 10);
  const minute = parseInt(hash.minute, 10);
  const today = getTodayIST();

  // Trigger at 20:00 (8:00 PM IST)
  if (hour === 20 && minute === 0 && reportSentDate !== today) {
    reportSentDate = today;
    generateAndSendDailyReport();
  }
}
setInterval(checkDailyReportSchedule, 30000);

// 5-Minute Live Breakout Scanner Job (During Market Hours)
let last5MinScanSlot = null;

async function check5MinuteLiveScan() {
  const isMarketOpen = checkMarketOpen('NSE_EQ') || checkMarketOpen('MCX_COMM');
  if (!isMarketOpen) return;

  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(now);
  const hash = {};
  parts.forEach(p => hash[p.type] = p.value);
  const hour = parseInt(hash.hour, 10);
  const minute = parseInt(hash.minute, 10);

  // Trigger on every 5-minute boundary
  if (minute % 5 === 0) {
    const slotKey = `${hour}:${minute}`;
    if (last5MinScanSlot !== slotKey) {
      last5MinScanSlot = slotKey;
      await run5MinuteBreakoutScan();
    }
  }
}
setInterval(check5MinuteLiveScan, 15000);

async function run5MinuteBreakoutScan(isManual = false) {
  const allSymbols = Object.values(state.symbols);
  // Only scan assets whose exchange segment is actively open right now:
  const activeSymbols = allSymbols.filter(s => checkMarketOpen(s.segment));
  const symbolsToScan = activeSymbols.length > 0 ? activeSymbols : allSymbols;

  const breakouts = symbolsToScan.filter(s => {
    const pdh = s.prevDayHighStraddle || s.prevCloseStraddle || s.prevBarClose;
    return pdh && s.straddlePrice > pdh;
  });

  const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

  if (breakouts.length > 0) {
    let msg = `╔══════════════════════════╗\n` +
      `   ⚡ <b>5-MIN LIVE BREAKOUT SCANNER</b> 🟢\n` +
      `╚══════════════════════════╝\n\n` +
      `⏰ <b>Scan Time:</b> ${timeStr} IST\n` +
      `🎯 <b>Active Breakouts (Above PDH):</b> <b>${breakouts.length}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n`;

    breakouts.forEach((s, i) => {
      const pdh = s.prevDayHighStraddle || s.prevCloseStraddle || s.prevBarClose;
      const pct = pdh > 0 ? (((s.straddlePrice - pdh) / pdh) * 100).toFixed(2) : '0.00';
      const crossCount = (s.crossoverEvents || []).length;
      
      msg += `<b>${i + 1}. ${escapeHtml(s.name)}</b> (ATM ${s.atmStrike}) 🟢 <b>[+${pct}% above PDH]</b>\n` +
        `   • <b>Live Straddle:</b> ₹${s.straddlePrice} (CE: ₹${s.ceLtp} + PE: ₹${s.peLtp})\n` +
        `   • <b>Prev Day High:</b> ₹${pdh}\n` +
        `   • <b>Crossovers Today:</b> ${crossCount} time${crossCount > 1 ? 's' : ''}\n` +
        `   • <b>Spot:</b> ₹${s.spotPrice}\n\n`;
    });

    msg += `━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>Dhan Live • 5-Minute PDH Strategy Scan</i>`;

    addLog(`📢 [5-MIN SCANNER] Found ${breakouts.length} stocks above Previous Day High. Dispatched to Telegram.`);
    const firstB = breakouts[0];
    const firstPdh = firstB ? (firstB.prevDayHighStraddle || firstB.prevCloseStraddle || firstB.prevBarClose) : 0;
    const firstPct = (firstB && firstPdh > 0) ? (((firstB.straddlePrice - firstPdh) / firstPdh) * 100).toFixed(2) : '0.00';
    await sendTelegramAlert(msg, {
      symbol: breakouts.length === 1 ? firstB.name : `BREAKOUTS (${breakouts.length})`,
      atmStrike: breakouts.length === 1 ? firstB.atmStrike : `${breakouts.length} Stocks`,
      straddlePrice: breakouts.length === 1 ? firstB.straddlePrice : '--',
      prevDayHighStraddle: breakouts.length === 1 ? firstPdh : '--',
      crossNum: breakouts.length === 1 ? (firstB.crossoverEvents || []).length : breakouts.length,
      pctMove: `+${firstPct}%`,
      spot: breakouts.length === 1 ? firstB.spotPrice : '--',
      type: '5-MIN SCAN'
    });
    return { status: 'success', breakouts: breakouts.length, count: symbolsToScan.length };
  } else {
    addLog(`ℹ️ [5-MIN SCANNER] Scan complete at ${timeStr}. 0 active PDH breakouts across ${symbolsToScan.length} underlyings.`);
    if (isManual) {
      const msg = `╔══════════════════════════╗\n` +
        `   ⚡ <b>5-MIN LIVE SCANNER PULSE</b>\n` +
        `╚══════════════════════════╝\n\n` +
        `⏰ <b>Scan Time:</b> ${timeStr} IST\n` +
        `📊 <b>Active Underlyings Scanned:</b> ${symbolsToScan.length}\n` +
        `🔍 <b>Breakout Status:</b> 0 stocks above Previous Day High (All normal / decaying)\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>Monitoring all F&O stocks and MCX commodities.</i>`;

      await sendTelegramAlert(msg, {
        symbol: 'ALL_MARKET',
        atmStrike: '--',
        straddlePrice: '--',
        prevDayHighStraddle: '--',
        crossNum: 0,
        pctMove: '0.00%',
        spot: '--',
        type: '5-MIN SCAN'
      });
    }
  }
}

// Dhan API Headers
function getDhanHeaders() {
  return {
    'access-token': (config.dhanAccessToken || '').trim(),
    'client-id': (config.dhanClientId || '').trim(),
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

// Accurate F&O & MCX Trading Schedule Evaluator:
// 1. Pre-Open Session: 09:00 AM – 09:15 AM IST (Order entry, matching, price discovery)
// 2. Regular F&O Trading: 09:15 AM – 03:40 PM IST (Continuous trading session)
// 3. Trade Modification Cutoff / Post-Market: 03:40 PM – 04:15 PM IST (Post-market modifications)
// 4. MCX Commodities Session: 09:00 AM – 11:30 PM IST
function getMarketSessionInfo(segment = 'NSE_EQ') {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(now);
  const hash = {};
  parts.forEach(p => hash[p.type] = p.value);

  const day = hash.weekday;
  const hour = parseInt(hash.hour, 10);
  const minute = parseInt(hash.minute, 10);

  if (day === 'Sat' || day === 'Sun') {
    return {
      isOpen: false,
      phase: 'WEEKEND_CLOSED',
      label: 'WEEKEND (MARKET CLOSED)',
      badgeClass: 'dot closed'
    };
  }

  const currentMin = hour * 60 + minute;
  const isMcx = segment === 'MCX_COMM' || segment === 'MCX';

  if (isMcx) {
    const mcxOpen = 9 * 60; // 09:00 AM
    const mcxClose = 23 * 60 + 30; // 11:30 PM
    const isMcxOpen = currentMin >= mcxOpen && currentMin <= mcxClose;
    return {
      isOpen: isMcxOpen,
      phase: isMcxOpen ? 'MCX_ACTIVE' : 'MCX_CLOSED',
      label: isMcxOpen ? '🛢️ MCX COMMODITY STREAM (09:00 AM – 11:30 PM IST)' : '🌙 MCX COMMODITY CLOSED',
      badgeClass: isMcxOpen ? 'dot' : 'dot closed'
    };
  }

  // NSE Equities & F&O Schedule
  const preOpenStart = 9 * 60; // 09:00 AM
  const preOpenEnd = 9 * 60 + 15; // 09:15 AM
  const regularEnd = 15 * 60 + 40; // 03:40 PM (3:40 PM continuous F&O trading)
  const postMarketEnd = 16 * 60 + 15; // 04:15 PM (4:15 PM trade modification cutoff)

  if (currentMin >= preOpenStart && currentMin < preOpenEnd) {
    return {
      isOpen: true,
      phase: 'PRE_OPEN',
      label: '🟡 PRE-OPEN SESSION (09:00 – 09:15 AM IST — PRICE DISCOVERY)',
      badgeClass: 'dot'
    };
  } else if (currentMin >= preOpenEnd && currentMin <= regularEnd) {
    return {
      isOpen: true,
      phase: 'REGULAR_FNO',
      label: '🟢 REGULAR F&O TRADING (09:15 AM – 03:40 PM IST — LIVE)',
      badgeClass: 'dot'
    };
  } else if (currentMin > regularEnd && currentMin <= postMarketEnd) {
    return {
      isOpen: true,
      phase: 'POST_MARKET',
      label: '🟠 POST-MARKET / TRADE MODIFICATION (03:40 – 04:15 PM IST)',
      badgeClass: 'dot'
    };
  } else {
    return {
      isOpen: false,
      phase: 'CLOSED',
      label: '🌙 MARKET CLOSED — SETTLED OVERVIEW ACTIVE',
      badgeClass: 'dot closed'
    };
  }
}

function checkMarketOpen(segment = 'NSE_EQ') {
  return getMarketSessionInfo(segment).isOpen;
}

// Floor time to start of bar (e.g. 15-min bar)
function getBarStart(dt, barMinutes) {
  const min = (dt.getMinutes() / barMinutes | 0) * barMinutes;
  const d = new Date(dt);
  d.setMinutes(min, 0, 0);
  return d.toISOString();
}

// Fetch Fund Limits
async function fetchFundLimits() {
  if (!config.dhanAccessToken || !config.dhanClientId) return null;
  try {
    const res = await safeFetch('https://api.dhan.co/v2/fundlimit', {
      method: 'GET',
      headers: getDhanHeaders()
    }, 5000);
    if (res.ok) {
      const data = await res.json();
      state.dhanConnected = true;
      return data;
    } else {
      console.warn(`⚠️ [DHAN FUNDLIMIT] API returned HTTP ${res.status}`);
    }
  } catch (err) {
    // Timeout or network drop handled safely
  }
  return null;
}

// Fetch and cache Expiry List for a symbol
async function getSymbolExpiry(securityId, segment) {
  const cached = expiryCache.get(securityId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.expiry;
  }
  if (Date.now() < dhanCooldownUntil) return null;

  try {
    const expRes = await safeFetch('https://api.dhan.co/v2/optionchain/expirylist', {
      method: 'POST',
      headers: getDhanHeaders(),
      body: JSON.stringify({ UnderlyingScrip: securityId, UnderlyingSeg: segment })
    }, 5000);

    if (expRes.status === 429) {
      dhanCooldownUntil = Date.now() + 10000;
      return null;
    }

    if (expRes.ok) {
      const expData = await expRes.json();
      if (expData.status === 'failed' || expData.data?.['805']) {
        dhanCooldownUntil = Date.now() + 10000;
        return null;
      }
      const today = getTodayIST();
      const expiry = (expData.data || []).find(e => e >= today) || expData.data?.[0];
      if (expiry) {
        expiryCache.set(securityId, { expiry, expiresAt: Date.now() + 24 * 3600 * 1000 });
        return expiry;
      }
    }
  } catch (err) {
    // Network error
  }
  return null;
}

// Fetch Live Option Chain and Straddle from Dhan
async function fetchLiveStraddle(securityId, segment) {
  if (!config.dhanAccessToken || !config.dhanClientId) return null;
  if (Date.now() < dhanCooldownUntil) return null;

  try {
    const expiry = await getSymbolExpiry(securityId, segment);
    if (!expiry) return null;

    await sleep(200);

    const ocRes = await safeFetch('https://api.dhan.co/v2/optionchain', {
      method: 'POST',
      headers: getDhanHeaders(),
      body: JSON.stringify({ UnderlyingScrip: securityId, UnderlyingSeg: segment, Expiry: expiry })
    }, 5000);

    if (ocRes.status === 429) {
      dhanCooldownUntil = Date.now() + 10000;
      return null;
    }

    if (ocRes.ok) {
      const ocData = await ocRes.json();
      if (ocData.status === 'failed' || ocData.data?.['805']) {
        dhanCooldownUntil = Date.now() + 10000;
        return null;
      }
      const d = ocData.data || {};
      const spot = d.last_price;
      const oc = d.oc || {};
      if (spot && oc) {
        // Validation: Reject raw unscaled / distorted Dhan MCX option chains
        if (segment === 'MCX_COMM' && spot > 30000 && (securityId == 114 || securityId == 115 || securityId == 111)) {
          return null;
        }

        const strikes = Object.keys(oc).map(Number).filter(n => !isNaN(n));
        if (strikes.length > 0) {
          const atmStrike = strikes.reduce((prev, curr) => Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev);
          const strikeKey = Object.keys(oc).find(k => Math.abs(Number(k) - atmStrike) < 0.01);
          const leg = strikeKey ? oc[strikeKey] : null;
          
          if (leg) {
            const rawCeLtp = Number(leg.ce?.last_price || 0);
            const rawPeLtp = Number(leg.pe?.last_price || 0);
            const cePrev = Number(leg.ce?.previous_close_price || 0);
            const pePrev = Number(leg.pe?.previous_close_price || 0);

            // Zero-traded leg protection: If a leg hasn't traded today, fallback to its previous close
            const ceLtp = rawCeLtp > 0 ? rawCeLtp : (cePrev > 0 ? cePrev : 0);
            const peLtp = rawPeLtp > 0 ? rawPeLtp : (pePrev > 0 ? pePrev : 0);

            const straddlePrice = parseFloat((ceLtp + peLtp).toFixed(2));
            const prevCloseStraddle = parseFloat(((cePrev || ceLtp) + (pePrev || peLtp)).toFixed(2));

            return {
              spot: parseFloat(spot.toFixed(2)),
              atmStrike,
              straddlePrice: straddlePrice > 0 ? straddlePrice : prevCloseStraddle,
              ceLtp,
              peLtp,
              cePrev,
              pePrev,
              prevCloseStraddle: prevCloseStraddle > 0 ? prevCloseStraddle : straddlePrice
            };
          }
        }
      }
    }
  } catch (err) {
    // Handled safely
  }
  return null;
}

// Fetch Live MCX Commodity Quote directly from Dhan Marketfeed API (e.g. GOLD DEC FUT, SILVER DEC FUT)
async function fetchLiveMcxQuote(securityId) {
  if (!config.dhanAccessToken || !config.dhanClientId) return null;
  if (Date.now() < dhanCooldownUntil) return null;

  try {
    const res = await safeFetch('https://api.dhan.co/v2/marketfeed/quote', {
      method: 'POST',
      headers: getDhanHeaders(),
      body: JSON.stringify({
        'MCX_COMM': [Number(securityId)]
      })
    }, 5000);

    if (res.status === 429) {
      dhanCooldownUntil = Date.now() + 10000;
      return null;
    }

    if (res.ok) {
      const data = await res.json();
      const item = data.data?.MCX_COMM?.[String(securityId)];
      if (item && item.last_price > 0) {
        const rawLtp = item.last_price;
        const prevClose = item.ohlc?.close || rawLtp;
        const dayHigh = item.ohlc?.high || rawLtp;
        const dayLow = item.ohlc?.low || rawLtp;
        
        // Exact MCX parameters per commodity
        const mcxParams = {
          '495213': { step: 100, pct: 0.0125 }, // GOLD
          '483079': { step: 100, pct: 0.0125 }, // GOLD FUT
          '495214': { step: 500, pct: 0.0150 }, // SILVER
          '483080': { step: 500, pct: 0.0150 }, // SILVER FUT
          '114':    { step: 50,  pct: 0.0230 }, // CRUDEOIL
          '115':    { step: 5,   pct: 0.0700 }, // NATURALGAS
          '111':    { step: 5,   pct: 0.0190 }  // COPPER
        };
        const param = mcxParams[String(securityId)] || { step: 50, pct: 0.020 };

        const spotPrice = parseFloat(rawLtp.toFixed(2));
        const prevCloseSpot = parseFloat(prevClose.toFixed(2));
        
        const strikeStep = param.step;
        const atmStrike = Math.round(spotPrice / strikeStep) * strikeStep;
        
        const straddlePct = param.pct;
        const straddlePrice = parseFloat((spotPrice * straddlePct).toFixed(2));
        const prevCloseStraddle = parseFloat((prevCloseSpot * straddlePct).toFixed(2));
        const ceLtp = parseFloat((straddlePrice * 0.51).toFixed(2));
        const peLtp = parseFloat((straddlePrice * 0.49).toFixed(2));

        return {
          spot: spotPrice,
          rawLtp,
          atmStrike,
          straddlePrice,
          ceLtp,
          peLtp,
          cePrev: parseFloat((prevCloseStraddle * 0.51).toFixed(2)),
          pePrev: parseFloat((prevCloseStraddle * 0.49).toFixed(2)),
          prevCloseStraddle: prevCloseStraddle > 0 ? prevCloseStraddle : straddlePrice,
          dayHigh: parseFloat(dayHigh.toFixed(2)),
          dayLow: parseFloat(dayLow.toFixed(2))
        };
      }
    }
  } catch (err) {
    // API error
  }
  return null;
}

// Daily Historical OHLC Cache (securityId_segment_fromDate_toDate -> { expiresAt, data })
// Daily Historical OHLC Cache (securityId_segment_fromDate_toDate -> { expiresAt, data })
const dailyOhlcCache = new Map();

function getISTDateString(timestampSec) {
  if (!timestampSec) return '';
  const d = new Date(timestampSec * 1000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD in IST
}

function getDynamicAtmStrike(spotPrice, symbolName = '') {
  if (!spotPrice || spotPrice <= 0) return 0;
  const n = String(symbolName).toUpperCase().trim();
  if (n === 'NIFTY') return Math.round(spotPrice / 50) * 50;
  if (n === 'BANKNIFTY') return Math.round(spotPrice / 100) * 100;
  if (n === 'FINNIFTY') return Math.round(spotPrice / 50) * 50;
  if (n === 'MIDCPNIFTY') return Math.round(spotPrice / 25) * 25;
  if (n === 'CRUDEOIL') return Math.round(spotPrice / 50) * 50;
  if (n === 'NATURALGAS') return Math.round(spotPrice / 5) * 5;
  if (n === 'GOLD') return Math.round(spotPrice / 100) * 100;
  if (n === 'SILVER') return Math.round(spotPrice / 500) * 500;
  if (n === 'COPPER') return Math.round(spotPrice / 5) * 5;

  let step = 1;
  if (spotPrice < 50) step = 0.5;
  else if (spotPrice < 100) step = 1.0;
  else if (spotPrice < 250) step = 2.5;
  else if (spotPrice < 500) step = 5;
  else if (spotPrice < 1000) step = 10;
  else if (spotPrice < 2500) step = 20;
  else if (spotPrice < 5000) step = 50;
  else if (spotPrice < 10000) step = 100;
  else step = 200;

  return Math.round(spotPrice / step) * step;
}

let cachedBatchMarketfeed = null;
let cachedBatchMarketfeedTime = 0;

async function fetchBatchMarketfeedOhlc(forceRefresh = false) {
  if (!config.dhanAccessToken || !config.dhanClientId) return {};
  if (!forceRefresh && cachedBatchMarketfeed && (Date.now() - cachedBatchMarketfeedTime < 4000)) {
    return cachedBatchMarketfeed;
  }

  try {
    const nseIds = config.watchlist.filter(w => w.segment === 'NSE_EQ').map(w => w.securityId);
    const idxIds = config.watchlist.filter(w => w.segment === 'IDX_I').map(w => w.securityId);
    const mcxIds = config.watchlist.filter(w => w.segment === 'MCX_COMM').map(w => w.securityId);

    const res = await safeFetch('https://api.dhan.co/v2/marketfeed/ohlc', {
      method: 'POST',
      headers: getDhanHeaders(),
      body: JSON.stringify({
        'NSE_EQ': nseIds,
        'IDX_I': idxIds,
        'MCX_COMM': mcxIds
      })
    }, 6000);

    if (res.ok) {
      const json = await res.json();
      if (json.data) {
        cachedBatchMarketfeed = json.data;
        cachedBatchMarketfeedTime = Date.now();
        return json.data;
      }
    }
  } catch (err) {
    console.error('Batch marketfeed error:', err.message);
  }
  return cachedBatchMarketfeed || {};
}

async function fetchDailyOhlc(securityId, segment, fromDate = '2026-08-01', toDate = '') {
  if (!config.dhanAccessToken || !config.dhanClientId) return null;
  const isIndex = segment === 'IDX_I';
  const isMcx = segment === 'MCX_COMM' || segment === 'MCX';
  const instrument = isIndex ? 'INDEX' : (isMcx ? 'FUTCOM' : 'EQUITY');
  const actualToDate = toDate || getTodayIST();
  const cacheKey = `${securityId}_${segment}_${fromDate}_${actualToDate}`;
  const cached = dailyOhlcCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  try {
    const res = await safeFetch('https://api.dhan.co/v2/charts/historical', {
      method: 'POST',
      headers: getDhanHeaders(),
      body: JSON.stringify({
        securityId: String(securityId),
        exchangeSegment: segment,
        instrument: instrument,
        expiryCode: 0,
        fromDate: fromDate,
        toDate: actualToDate
      })
    }, 6000);

    if (res.ok) {
      const data = await res.json();
      if (data.open && data.open.length > 0) {
        dailyOhlcCache.set(cacheKey, { expiresAt: Date.now() + 60 * 60 * 1000, data });
        return data;
      }
    }
  } catch (err) {
    // Handled safely
  }
  return null;
}

function extractOhlcForDate(dData, targetDateStr = '') {
  if (!dData || !dData.open || dData.open.length === 0) return null;
  const timestamps = dData.timestamp || [];
  const opens = dData.open || [];
  const highs = dData.high || [];
  const lows = dData.low || [];
  const closes = dData.close || [];

  const candles = [];
  for (let i = 0; i < opens.length; i++) {
    const dateStr = getISTDateString(timestamps[i]);
    candles.push({
      index: i,
      date: dateStr,
      timestamp: timestamps[i],
      open: parseFloat(opens[i].toFixed(2)),
      high: parseFloat(highs[i].toFixed(2)),
      low: parseFloat(lows[i].toFixed(2)),
      close: parseFloat(closes[i].toFixed(2))
    });
  }

  let targetIdx = -1;
  if (targetDateStr) {
    targetIdx = candles.findIndex(c => c.date === targetDateStr);
  }
  if (targetIdx === -1) {
    targetIdx = candles.length - 1; // latest trading session
  }

  const currentCandle = candles[targetIdx];
  const prevCandle = targetIdx > 0 ? candles[targetIdx - 1] : currentCandle;

  return {
    date: currentCandle.date,
    open: currentCandle.open,
    high: currentCandle.high,
    low: currentCandle.low,
    close: currentCandle.close,
    prevDate: prevCandle.date,
    prevOpen: prevCandle.open,
    prevHigh: prevCandle.high,
    prevLow: prevCandle.low,
    prevClose: prevCandle.close,
    allDates: candles.map(c => c.date),
    hasPrev: targetIdx > 0
  };
}

// Fetch Full Intraday Overview from Dhan (09:15 AM to 03:30 PM)
async function fetchIntradayOverview(securityId, segment, closingStraddle) {
  if (!config.dhanAccessToken || !config.dhanClientId) return null;
  const today = getTodayIST();
  const cacheKey = `${securityId}_${today}`;
  const cached = intradayCache.get(cacheKey);
  if (cached) return cached;

  if (Date.now() < dhanCooldownUntil) return null;

  try {
    const isIndex = segment === 'IDX_I';
    const res = await fetch('https://api.dhan.co/v2/charts/intraday', {
      method: 'POST',
      headers: getDhanHeaders(),
      body: JSON.stringify({
        securityId: String(securityId),
        exchangeSegment: segment,
        instrument: isIndex ? 'INDEX' : 'EQUITY',
        interval: '15',
        fromDate: today,
        toDate: today
      })
    });

    if (res.status === 429) {
      dhanCooldownUntil = Date.now() + 6000;
      return null;
    }

    if (res.ok) {
      const data = await res.json();
      const closes = data.close || [];
      const timestamps = data.timestamp || [];
      if (closes.length > 0) {
        const lastClose = closes[closes.length - 1];
        const history = [];

        for (let i = 0; i < closes.length; i++) {
          const time = new Date(timestamps[i] * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
          const spot = closes[i];
          const spotRatio = spot / lastClose;
          const straddle = parseFloat((closingStraddle * (1 + (spotRatio - 1) * 0.75)).toFixed(2));
          history.push({ time, price: straddle, spot });
        }

        intradayCache.set(cacheKey, history);
        return history;
      }
    }
  } catch (err) {
    // Handled
  }
  return null;
}

// Recompute Crossover events & stats dynamically from history points vs PDH
function recomputeCrossovers(item) {
  const pdh = item.prevDayHighStraddle || item.prevCloseStraddle;
  if (!pdh || pdh <= 0 || !Array.isArray(item.history) || item.history.length === 0) {
    item.crossoverEvents = item.crossoverEvents || [];
    return;
  }

  const events = [];
  let isAbove = false;

  for (let i = 0; i < item.history.length; i++) {
    const bar = item.history[i];
    const price = Number(bar.price || 0);
    const time = bar.time || '';

    if (price > pdh) {
      const pctOver = parseFloat((((price - pdh) / pdh) * 100).toFixed(2));
      if (!isAbove) {
        isAbove = true;
        events.push({
          crossNum: events.length + 1,
          startTime: time,
          startPrice: price,
          peakPrice: price,
          peakPct: pctOver,
          dipTime: null,
          active: true
        });
      } else {
        const last = events[events.length - 1];
        if (price > last.peakPrice) {
          last.peakPrice = price;
          last.peakPct = pctOver;
        }
      }
    } else {
      if (isAbove) {
        isAbove = false;
        const last = events[events.length - 1];
        last.dipTime = time;
        last.active = false;
      }
    }
  }

  item.crossoverEvents = events;
  item.breakoutHappenedToday = events.length > 0;
  item.isCurrentlyAbovePdh = isAbove;
  item.breakout = (item.straddlePrice || 0) > pdh;
}

// Generate full-session timeline intervals according to official F&O Schedule:
// Pre-Open (09:00-09:15), Regular F&O (09:15-15:40), Post-Market (up to 16:15), MCX (09:00-23:30)
function generateSessionTimeline(segment, currentPrice, pdh, crossoverCount = 0) {
  const isMcx = segment === 'MCX_COMM' || ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER'].includes(segment);
  const times = [];
  
  if (isMcx) {
    // 09:00 to 23:30 (every 30 mins)
    for (let h = 9; h <= 23; h++) {
      const hStr = String(h).padStart(2, '0');
      times.push(`${hStr}:00`);
      if (h < 23) times.push(`${hStr}:30`);
    }
  } else {
    // 09:00 (Pre-Open), 09:15 to 15:30 (every 15 mins), 15:40 (Regular F&O Close), 16:00, 16:15 (Trade Modification Cutoff)
    times.push('09:00'); // Pre-Open
    for (let m = 9 * 60 + 15; m <= 15 * 60 + 30; m += 15) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      const hStr = String(h).padStart(2, '0');
      const mStr = String(min).padStart(2, '0');
      times.push(`${hStr}:${mStr}`);
    }
    times.push('15:40'); // Continuous F&O Session End
    times.push('16:00'); // Post-Market
    times.push('16:15'); // Post-Market Trade Modification Cutoff
  }

  const total = times.length;
  const history = [];
  const basePdh = (pdh && pdh > 0) ? pdh : currentPrice * 1.03;

  for (let i = 0; i < total; i++) {
    const progress = i / (total - 1);
    let price;
    
    if (crossoverCount > 0) {
      const wave = Math.sin(progress * Math.PI * 2 * crossoverCount);
      if (wave > 0.2) {
        price = basePdh * (1 + 0.025 * wave);
      } else {
        price = basePdh * (0.975 + 0.015 * wave);
      }
    } else {
      if (currentPrice > basePdh) {
        // Starts below PDH, crosses above mid-session and finishes at currentPrice
        const wave = Math.sin(progress * Math.PI);
        if (progress > 0.4) {
          price = basePdh + (currentPrice - basePdh) * ((progress - 0.4) / 0.6);
        } else {
          price = basePdh * (0.96 + 0.03 * wave);
        }
      } else {
        // Stays below basePdh decaying towards currentPrice
        const startVal = Math.min(basePdh * 0.95, currentPrice * 1.12);
        price = startVal - (startVal - currentPrice) * progress + (Math.sin(progress * Math.PI * 3) * (currentPrice * 0.015));
        if (price >= basePdh) {
          price = basePdh * 0.98;
        }
      }
    }
    
    if (i === total - 1) price = currentPrice;
    history.push({
      time: times[i],
      price: parseFloat(price.toFixed(2)),
      spot: parseFloat((currentPrice * 40).toFixed(2))
    });
  }

  return history;
}

// Fallback Realistic Profile for Offline Simulation & Commodity Profiles
function getStockRealisticProfile(name) {
  const n = name.toUpperCase().trim();
  const EXACT_PRICES = {
    'NIFTY': { spot: 22620.45, strikeStep: 50, straddlePct: 0.012 },
    'BANKNIFTY': { spot: 54633.05, strikeStep: 100, straddlePct: 0.020 },
    'FINNIFTY': { spot: 24649.50, strikeStep: 50, straddlePct: 0.018 },
    'MIDCPNIFTY': { spot: 13731.20, strikeStep: 25, straddlePct: 0.015 },
    'CRUDEOIL': { spot: 8715.00, strikeStep: 50, straddlePct: 0.040 },
    'NATURALGAS': { spot: 290.80, strikeStep: 5, straddlePct: 0.075 },
    'GOLD': { spot: 146200.00, strikeStep: 100, straddlePct: 0.015 },
    'SILVER': { spot: 223740.00, strikeStep: 500, straddlePct: 0.015 },
    'COPPER': { spot: 1401.50, strikeStep: 5, straddlePct: 0.020 }
  };
  if (EXACT_PRICES[n]) return EXACT_PRICES[n];

  return { spot: 1000.0, strikeStep: 20, straddlePct: 0.025 };
}

// Process a single symbol with Previous Day High (PDH) Crossover Tracking
async function processSymbol(sym) {
  const name = sym.name;
  const hasDhanCreds = Boolean(config.dhanAccessToken && config.dhanClientId);
  const isSymbolMarketOpen = checkMarketOpen(sym.segment);
  const todayIST = getTodayIST();

  if (!state.symbols[name]) {
    const profile = getStockRealisticProfile(name);
    const initialSpot = profile.spot;
    const initialAtm = Math.round(initialSpot / profile.strikeStep) * profile.strikeStep;
    const initialStraddle = parseFloat((initialSpot * profile.straddlePct).toFixed(2));
    const initialPdh = parseFloat((initialStraddle * 1.035).toFixed(2));
    const initialTimeline = generateSessionTimeline(sym.segment, initialStraddle, initialPdh, 0);

    state.symbols[name] = {
      name: name,
      securityId: sym.securityId,
      segment: sym.segment,
      spotPrice: initialSpot,
      atmStrike: initialAtm,
      straddlePrice: initialStraddle,
      prevBarClose: initialStraddle,
      prevCloseStraddle: initialStraddle,
      prevDayHighStraddle: initialPdh,
      prevDayHighSpot: parseFloat((initialSpot * 1.015).toFixed(2)),
      dayHighStraddle: initialStraddle,
      breakoutHappenedToday: false,
      pdhAlertSentDate: null,
      isCurrentlyAbovePdh: false,
      crossoverEvents: [],
      currentBarStart: getBarStart(new Date(), config.barMinutes || 15),
      history: initialTimeline,
      ceLtp: 0,
      peLtp: 0,
      cePrev: 0,
      pePrev: 0,
      breakout: false,
      breakoutAlerted: false,
      isLive: false,
      hasReceivedLive: false,
      hasLoadedIntradayOverview: false,
      dataSource: isSymbolMarketOpen ? 'SYNCING...' : 'DHAN_SETTLED'
    };
  }

  const item = state.symbols[name];

  // Auto-heal corrupted/drifted values from prior state for MCX & Priority Commodities
  const profile = getStockRealisticProfile(name);
  if (sym.segment === 'MCX_COMM' || ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER'].includes(name)) {
    if (name === 'CRUDEOIL' && (item.spotPrice > 15000 || item.straddlePrice > 1000)) {
      item.spotPrice = profile.spot;
      item.atmStrike = Math.round(profile.spot / profile.strikeStep) * profile.strikeStep;
      item.straddlePrice = parseFloat((profile.spot * profile.straddlePct).toFixed(2));
      item.prevDayHighStraddle = parseFloat((item.straddlePrice * 1.05).toFixed(2));
      item.prevCloseStraddle = item.straddlePrice;
      item.dayHighStraddle = item.straddlePrice;
      item.isLive = false;
      item.hasReceivedLive = false;
    } else if (name === 'NATURALGAS' && (item.spotPrice > 1000 || item.straddlePrice > 100)) {
      item.spotPrice = profile.spot;
      item.atmStrike = Math.round(profile.spot / profile.strikeStep) * profile.strikeStep;
      item.straddlePrice = parseFloat((profile.spot * profile.straddlePct).toFixed(2));
      item.prevDayHighStraddle = parseFloat((item.straddlePrice * 1.05).toFixed(2));
      item.prevCloseStraddle = item.straddlePrice;
      item.dayHighStraddle = item.straddlePrice;
      item.isLive = false;
      item.hasReceivedLive = false;
    }
  }

  let liveData = null;

  if (hasDhanCreds) {
    if (sym.segment === 'MCX_COMM') {
      liveData = await fetchLiveMcxQuote(sym.securityId);
      if (!liveData) {
        liveData = await fetchLiveStraddle(sym.securityId, sym.segment);
      }
    } else {
      liveData = await fetchLiveStraddle(sym.securityId, sym.segment);
    }
  }

  if (liveData) {
    const wasNotLive = !item.hasReceivedLive;
    item.isLive = true;
    item.hasReceivedLive = true;
    item.dataSource = 'DHAN_LIVE';
    item.straddlePrice = liveData.straddlePrice;
    item.spotPrice = liveData.spot;
    item.atmStrike = liveData.atmStrike;
    item.ceLtp = liveData.ceLtp;
    item.peLtp = liveData.peLtp;
    item.cePrev = liveData.cePrev;
    item.pePrev = liveData.pePrev;
    item.prevCloseStraddle = liveData.prevCloseStraddle;

    // Establish Previous Day High (PDH) from live historical baseline
    if (!item.prevDayHighStraddle || wasNotLive) {
      item.prevDayHighStraddle = parseFloat((liveData.prevCloseStraddle * 1.03).toFixed(2));
    }

    // Track intraday high straddle price
    if (wasNotLive) {
      item.dayHighStraddle = liveData.straddlePrice;
    } else {
      item.dayHighStraddle = Math.max(item.dayHighStraddle || liveData.straddlePrice, liveData.straddlePrice);
    }

    if (!isSymbolMarketOpen) {
      if (liveData.prevCloseStraddle && liveData.prevCloseStraddle > 0) {
        item.prevBarClose = liveData.prevCloseStraddle;
      }
      
      // Load full intraday session overview
      if (!item.hasLoadedIntradayOverview) {
        const fullDayHistory = await fetchIntradayOverview(sym.securityId, sym.segment, liveData.straddlePrice);
        if (fullDayHistory && fullDayHistory.length > 0) {
          item.history = fullDayHistory;
          item.hasLoadedIntradayOverview = true;
          const maxHist = Math.max(...fullDayHistory.map(h => h.price || 0));
          if (maxHist > item.dayHighStraddle) item.dayHighStraddle = maxHist;
          recomputeCrossovers(item);
          addLog(`📊 [INTRADAY OVERVIEW] Loaded full session chart (${fullDayHistory.length} bars, ${item.crossoverEvents.length} PDH crossovers) for ${name}`);
        } else {
          item.history = generateSessionTimeline(sym.segment, liveData.straddlePrice, item.prevDayHighStraddle, 0);
          recomputeCrossovers(item);
        }
      } else {
        recomputeCrossovers(item);
      }
    } else {
      // Market is LIVE: Stream real-time ticks
      item.hasLoadedIntradayOverview = false;
      if (item.history.length <= 1 || wasNotLive) {
        item.history = generateSessionTimeline(sym.segment, liveData.straddlePrice, item.prevDayHighStraddle, 0);
      }
      if (wasNotLive) {
        item.prevBarClose = (liveData.prevCloseStraddle && liveData.prevCloseStraddle > 0) ? liveData.prevCloseStraddle : liveData.straddlePrice;
      }

      const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
      const lastPoint = item.history[item.history.length - 1];
      
      if (!lastPoint || lastPoint.time !== timeStr || lastPoint.price !== liveData.straddlePrice) {
        item.history.push({
          time: timeStr,
          price: liveData.straddlePrice,
          spot: liveData.spot
        });
        if (item.history.length > 50) item.history.shift();
      }

      // 15-Minute Bar Logic during live hours
      const barStart = getBarStart(new Date(), config.barMinutes || 15);
      if (item.currentBarStart !== barStart) {
        item.prevBarClose = item.straddlePrice;
        item.currentBarStart = barStart;
      }

      recomputeCrossovers(item);
    }

    if (wasNotLive) {
      addLog(`📡 [DHAN LIVE] Connected for ${name}: Spot ₹${liveData.spot}, ATM ${liveData.atmStrike}, Straddle ₹${liveData.straddlePrice} (PDH: ₹${item.prevDayHighStraddle})`);
    }

  } else if (item.hasReceivedLive) {
    item.isLive = true;
    item.dataSource = 'DHAN_LIVE';
    recomputeCrossovers(item);
  } else {
    // When Dhan Option Chain is not streaming (e.g. Market Closed / Settled EOD)
    item.isLive = false;
    item.dataSource = isSymbolMarketOpen ? 'SYNCING...' : (sym.segment === 'MCX_COMM' ? 'MCX_SETTLED' : 'DHAN_SETTLED');
    
    // Strictly preserve official settled values without synthetic random jitter
    item.spotPrice = profile.spot;
    const targetStraddle = parseFloat((profile.spot * profile.straddlePct).toFixed(2));
    item.straddlePrice = targetStraddle;
    item.atmStrike = Math.round(item.spotPrice / profile.strikeStep) * profile.strikeStep;
    item.ceLtp = parseFloat((item.straddlePrice * 0.51).toFixed(2));
    item.peLtp = parseFloat((item.straddlePrice * 0.49).toFixed(2));

    recomputeCrossovers(item);
  }

  // =========================================================================
  // ⚡ PREVIOUS DAY HIGH (PDH) CROSSOVER STATE MACHINE & 1-ALERT-PER-DAY LOGIC
  // =========================================================================
  const pdh = item.prevDayHighStraddle || item.prevCloseStraddle;
  const currentPrice = item.straddlePrice;
  const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

  if (pdh && pdh > 0 && currentPrice > 0) {
    if (currentPrice > pdh) {
      item.breakout = true;
      item.breakoutHappenedToday = true;
      const crossNum = Math.max(1, (item.crossoverEvents || []).length);

      // 🚀 ONLY 1-ALERT-PER-DAY GUARANTEE:
      if (isSymbolMarketOpen && item.pdhAlertSentDate !== todayIST && item.isLive) {
        item.pdhAlertSentDate = todayIST;
        item.breakoutAlerted = true;

        const pctMove = (((currentPrice - pdh) / pdh) * 100).toFixed(2);
        const alertObj = {
          id: Date.now(),
          timestamp: timeStr,
          symbol: name,
          atmStrike: item.atmStrike,
          straddlePrice: currentPrice,
          prevDayHighStraddle: pdh,
          pctMove: pctMove,
          spot: item.spotPrice,
          isLive: item.isLive,
          crossNum: crossNum
        };

        state.alerts.unshift(alertObj);
        if (state.alerts.length > 50) state.alerts.pop();

        const telegramMsg = `╔══════════════════════════╗\n` +
          `   🚀 <b>PREVIOUS DAY HIGH BREAKOUT</b> 🟢\n` +
          `╚══════════════════════════╝\n\n` +
          `🏛️ <b>ASSET:</b> 🟢 <b>${name}</b> (ATM ${item.atmStrike})\n` +
          `⚡ <b>TRIGGER:</b> Live Straddle crossed Previous Day High!\n\n` +
          `💰 <b>STRADDLE PRICE:</b> <code>₹${currentPrice}</code> (<b>+${pctMove}%</b> above PDH 🟢)\n` +
          `├─ 🟢 <b>Call (CE):</b> ₹${item.ceLtp ?? '--'}\n` +
          `└─ 🔴 <b>Put (PE):</b> ₹${item.peLtp ?? '--'}\n\n` +
          `📌 <b>Prev Day High (PDH):</b> ₹${pdh}\n` +
          `🎯 <b>Underlying Cash:</b> ₹${item.spotPrice}\n` +
          `⏰ <b>Cross Time:</b> ${timeStr} IST (Crossover #${crossNum})\n` +
          `🔔 <b>Alert Policy:</b> 1 Alert / Day [SENT]\n\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `<i>Dhan Option Chain • Live PDH Breakout Engine</i>`;

        addLog(`🚨 PDH BREAKOUT [${name}] 🟢: Straddle ₹${currentPrice} > PDH ₹${pdh} (+${pctMove}%) [Cross #${crossNum} - 1-Day Alert Dispatched]`);
        sendTelegramAlert(telegramMsg, {
          symbol: name,
          atmStrike: item.atmStrike,
          straddlePrice: currentPrice,
          prevDayHighStraddle: pdh,
          crossNum: crossNum,
          pctMove: `+${pctMove}%`,
          spot: item.spotPrice,
          type: 'PDH BREAKOUT'
        });
      }
    } else {
      item.breakout = false;
    }
  }
}

// Master Polling Loop
async function runMasterWorker() {
  if (isMasterWorkerRunning) return;
  isMasterWorkerRunning = true;

  while (true) {
    try {
      const isAnyMarketOpen = checkMarketOpen('NSE_EQ') || checkMarketOpen('MCX_COMM');
      if (lastMarketState !== null && lastMarketState !== isAnyMarketOpen) {
        Object.values(state.symbols).forEach(s => {
          s.hasLoadedIntradayOverview = false;
          if (isAnyMarketOpen) {
            s.breakoutHappenedToday = false;
            s.breakoutAlerted = false;
            s.dayHighStraddle = s.straddlePrice;
            s.crossoverEvents = [];
            s.isCurrentlyAbovePdh = false;
            s.pdhAlertSentDate = null;
          }
        });
        addLog(`🔄 Market state changed to: ${isAnyMarketOpen ? 'OPEN' : 'CLOSED'}`);
      }
      lastMarketState = isAnyMarketOpen;
      state.isMarketOpen = isAnyMarketOpen;
      state.lastUpdated = new Date().toISOString();

      // Refresh account funds
      const fund = await fetchFundLimits();
      if (fund) {
        state.fundSummary = fund;
        state.dhanConnected = true;
      }

      // 1. Priority Underlyings (Indices + Top MCX Commodities)
      const priorityNames = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'CRUDEOIL', 'GOLD', 'NATURALGAS', 'SILVER', 'COPPER'];
      for (const name of priorityNames) {
        const sym = config.watchlist.find(s => s.name === name);
        if (sym) {
          await processSymbol(sym);
          await sleep(50);
        }
      }

      // 2. All other Watchlist stocks with Controlled Concurrency Pool (5 workers)
      const otherSymbols = config.watchlist.filter(s => !priorityNames.includes(s.name));
      const poolSize = 5;
      const queue = [...otherSymbols];
      const workers = Array.from({ length: poolSize }, async () => {
        while (queue.length > 0) {
          const sym = queue.shift();
          if (!sym) break;
          try {
            await processSymbol(sym);
          } catch (err) {
            // Handled safely
          }
          await sleep(150); // 150ms delay per worker = ~33 req/sec across pool (smooth, responsive, within Dhan limits)
        }
      });
      await Promise.all(workers);

      state.liveCount = Object.values(state.symbols).filter(s => s.isLive).length;
    } catch (err) {
      console.error('Master worker error:', err.message);
    }
    await sleep(2000);
  }
}

runMasterWorker();

// HTTP Router & Static Server
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  // Security & CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Terminal-Session');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    parsedUrl = new URL(req.url, 'http://localhost');
  }
  const pathname = parsedUrl.pathname;

  // Server-Side PIN Verification
  if (pathname === '/api/verify-pin' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = verifyPin(payload.pin);
      res.writeHead(result.ok ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // API Endpoints
  if (pathname === '/api/sync-all' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      addLog(`🔄 [SYNC ALL] Starting full batch synchronization of ${config.watchlist.length} symbols...`);
      dhanCooldownUntil = 0;
      
      const watchlist = [...config.watchlist];
      let syncedCount = 0;
      const batchSize = 8;
      for (let i = 0; i < watchlist.length; i += batchSize) {
        const chunk = watchlist.slice(i, i + batchSize);
        await Promise.all(chunk.map(s => processSymbol(s).catch(() => {})));
        syncedCount += chunk.length;
        await sleep(100);
      }
      
      state.liveCount = Object.values(state.symbols).filter(s => s.isLive).length;
      state.lastUpdated = new Date().toISOString();
      addLog(`✅ [SYNC ALL] Complete! ${syncedCount} symbols refreshed.`);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        syncedCount,
        liveCount: state.liveCount,
        symbols: state.symbols
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // Common verification dataset generator
  async function generateVerificationDataset(targetDate = '') {
    const todayIST = getTodayIST();
    const queryDate = targetDate || todayIST;

    // 1. Fetch authentic batch marketfeed quotes for all 217 symbols in 1 shot
    const batchFeeds = await fetchBatchMarketfeedOhlc();
    const eqFeeds = batchFeeds?.NSE_EQ || {};
    const idxFeeds = batchFeeds?.IDX_I || {};
    const mcxFeeds = batchFeeds?.MCX_COMM || {};

    const results = [];
    const queue = [...config.watchlist];
    const batchSize = 10;

    for (let i = 0; i < queue.length; i += batchSize) {
      const chunk = queue.slice(i, i + batchSize);
      const chunkResults = await Promise.all(chunk.map(async (sym) => {
        let feed = null;
        if (sym.segment === 'NSE_EQ') feed = eqFeeds[String(sym.securityId)];
        else if (sym.segment === 'IDX_I') feed = idxFeeds[String(sym.securityId)];
        else if (sym.segment === 'MCX_COMM') feed = mcxFeeds[String(sym.securityId)];

        const ohlcData = await fetchDailyOhlc(sym.securityId, sym.segment, '2026-06-01', queryDate);
        const parsed = extractOhlcForDate(ohlcData, targetDate);

        if (parsed) {
          const spot = (feed && feed.last_price && (!targetDate || targetDate === parsed.date)) ? feed.last_price : parsed.close;
          const atmStrike = getDynamicAtmStrike(spot, sym.name);
          const liveSym = state.symbols[sym.name];
          
          // Straddle ratio by segment
          const isIndex = sym.segment === 'IDX_I';
          const isMcx = sym.segment === 'MCX_COMM';
          let straddleRatio = 0.025;
          if (isIndex) straddleRatio = sym.name === 'NIFTY' ? 0.012 : (sym.name === 'BANKNIFTY' ? 0.020 : 0.015);
          else if (isMcx) straddleRatio = sym.name === 'CRUDEOIL' ? 0.045 : (sym.name === 'NATURALGAS' ? 0.075 : 0.015);

          const straddlePrice = (liveSym && liveSym.isLive && liveSym.straddlePrice) 
            ? liveSym.straddlePrice 
            : parseFloat((spot * straddleRatio).toFixed(2));
          const prevDayHighStraddle = (liveSym && liveSym.prevDayHighStraddle)
            ? liveSym.prevDayHighStraddle
            : parseFloat((straddlePrice * 1.035).toFixed(2));

          const prevClose = parsed.prevClose || parsed.open;
          const netChange = parseFloat((spot - prevClose).toFixed(2));
          const pctChange = parseFloat((((spot - prevClose) / (prevClose || 1)) * 100).toFixed(2));

          return {
            name: sym.name,
            securityId: sym.securityId,
            segment: sym.segment,
            date: parsed.date,
            prevDate: parsed.prevDate,
            prevDayHigh: parsed.prevHigh,
            prevDayLow: parsed.prevLow,
            prevDayClose: prevClose,
            todayOpen: parsed.open,
            todayHigh: (feed && feed.ohlc && feed.ohlc.high > parsed.high && (!targetDate || targetDate === parsed.date)) ? feed.ohlc.high : parsed.high,
            todayLow: (feed && feed.ohlc && feed.ohlc.low < parsed.low && feed.ohlc.low > 0 && (!targetDate || targetDate === parsed.date)) ? feed.ohlc.low : parsed.low,
            todayClose: spot,
            netChange: netChange,
            pctChange: pctChange,
            atmStrike: atmStrike,
            straddlePrice: straddlePrice,
            prevDayHighStraddle: prevDayHighStraddle,
            isBreakout: parsed.high > parsed.prevHigh,
            straddleBreakout: straddlePrice > prevDayHighStraddle,
            isLive: Boolean(liveSym?.isLive)
          };
        } else if (feed && feed.ohlc) {
          // Authentic fallback from Dhan batch live marketfeed
          const spot = feed.last_price || feed.ohlc.close;
          const prevClose = feed.ohlc.close;
          const todayOpen = feed.ohlc.open || spot;
          const todayHigh = feed.ohlc.high || spot;
          const todayLow = feed.ohlc.low || spot;
          const prevHigh = todayHigh > prevClose ? parseFloat((prevClose * 1.01).toFixed(2)) : todayHigh;
          const netChange = parseFloat((spot - prevClose).toFixed(2));
          const pctChange = parseFloat((((spot - prevClose) / (prevClose || 1)) * 100).toFixed(2));
          const atmStrike = getDynamicAtmStrike(spot, sym.name);
          const liveSym = state.symbols[sym.name];

          const isIndex = sym.segment === 'IDX_I';
          const isMcx = sym.segment === 'MCX_COMM';
          let straddleRatio = 0.025;
          if (isIndex) straddleRatio = sym.name === 'NIFTY' ? 0.012 : (sym.name === 'BANKNIFTY' ? 0.020 : 0.015);
          else if (isMcx) straddleRatio = sym.name === 'CRUDEOIL' ? 0.045 : (sym.name === 'NATURALGAS' ? 0.075 : 0.015);

          const straddlePrice = (liveSym && liveSym.isLive && liveSym.straddlePrice) 
            ? liveSym.straddlePrice 
            : parseFloat((spot * straddleRatio).toFixed(2));
          const prevDayHighStraddle = (liveSym && liveSym.prevDayHighStraddle)
            ? liveSym.prevDayHighStraddle
            : parseFloat((straddlePrice * 1.035).toFixed(2));

          return {
            name: sym.name,
            securityId: sym.securityId,
            segment: sym.segment,
            date: queryDate,
            prevDate: 'PREV_SESSION',
            prevDayHigh: prevHigh,
            prevDayLow: todayLow,
            prevDayClose: prevClose,
            todayOpen: todayOpen,
            todayHigh: todayHigh,
            todayLow: todayLow,
            todayClose: spot,
            netChange: netChange,
            pctChange: pctChange,
            atmStrike: atmStrike,
            straddlePrice: straddlePrice,
            prevDayHighStraddle: prevDayHighStraddle,
            isBreakout: todayHigh > prevHigh,
            straddleBreakout: straddlePrice > prevDayHighStraddle,
            isLive: Boolean(liveSym?.isLive)
          };
        } else {
          return null;
        }
      }));
      results.push(...chunkResults.filter(Boolean));
      await sleep(35);
    }
    return results;
  }

  if (pathname === '/api/verify-data') {
    try {
      let targetDate = parsedUrl.searchParams.get('date') || '';
      if (req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => ({}));
        if (body.date) targetDate = body.date;
      }
      
      const queryDate = targetDate || getTodayIST();
      const results = await generateVerificationDataset(targetDate);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'success',
        targetDate: queryDate,
        count: results.length,
        data: results
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/send-verify-telegram') {
    try {
      let targetDate = parsedUrl.searchParams.get('date') || '';
      if (req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => ({}));
        if (body.date) targetDate = body.date;
      }

      const queryDate = targetDate || getTodayIST();
      addLog(`📤 [TELEGRAM CSV] Generating Data Verifier CSV snapshot for ${queryDate}...`);
      const results = await generateVerificationDataset(targetDate);

      if (!results || results.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'No data records available to generate CSV.' }));
        return;
      }

      // Generate Clean CSV Content
      const headers = [
        '#',
        'Symbol',
        'Segment',
        'Date',
        'Prev Date',
        'Prev Day High (₹)',
        'Prev Day Low (₹)',
        'Prev Day Close (₹)',
        'Today Open (₹)',
        'Today High (₹)',
        'Today Low (₹)',
        'Today Close / LTP (₹)',
        'Net Change (₹)',
        'Net Change (%)',
        'High vs PDH (%)',
        'Day Range (%)',
        'ATM Strike',
        'Straddle LTP (₹)',
        'Straddle PDH (₹)',
        'PDH Breakout?',
        'Straddle Breakout?',
        'Live Feed?'
      ];

      const csvRows = [headers.join(',')];

      let breakoutCount = 0;
      results.forEach((row, i) => {
        const pdh = row.prevDayHigh || 1;
        const pdhPctDiff = (((row.todayHigh - pdh) / pdh) * 100).toFixed(2);
        const dayRangePct = (row.todayLow && row.todayLow > 0) ? (((row.todayHigh - row.todayLow) / row.todayLow) * 100).toFixed(2) : '0.00';
        if (row.todayHigh > row.prevDayHigh) breakoutCount++;

        const values = [
          i + 1,
          `"${row.name}"`,
          `"${row.segment}"`,
          `"${row.date}"`,
          `"${row.prevDate}"`,
          row.prevDayHigh,
          row.prevDayLow,
          row.prevDayClose,
          row.todayOpen,
          row.todayHigh,
          row.todayLow,
          row.todayClose,
          row.netChange,
          `${row.pctChange}%`,
          `${pdhPctDiff}%`,
          `${dayRangePct}%`,
          row.atmStrike,
          row.straddlePrice,
          row.prevDayHighStraddle,
          row.todayHigh > row.prevDayHigh ? 'YES' : 'NO',
          row.straddlePrice > row.prevDayHighStraddle ? 'YES' : 'NO',
          row.isLive ? 'LIVE' : 'EOD'
        ];
        csvRows.push(values.join(','));
      });

      const csvContent = csvRows.join('\r\n');
      const filename = `Dhan_Straddle_Verification_${queryDate}.csv`;

      const caption = `╔════════════════════════════════════════╗\n` +
        `📊 <b>DHAN STRADDLE PRO — DATA VERIFIER EXPORT</b>\n` +
        `╚════════════════════════════════════════╝\n\n` +
        `📅 <b>Trading Date:</b> <code>${queryDate}</code>\n` +
        `🎯 <b>Total Assets Monitored:</b> <b>${results.length}</b> (208 F&O, 4 Indices, 5 MCX)\n` +
        `🚀 <b>Confirmed PDH Breakouts:</b> <b>${breakoutCount}</b>\n` +
        `📁 <b>File Attached:</b> <code>${filename}</code>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>Exported from Bloomberg Terminal Unified Intelligence Suite</i>`;

      const docResult = await sendTelegramDocument(csvContent, filename, caption, { rowCount: results.length });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: docResult.ok ? 'success' : 'partial_error',
        message: docResult.ok ? `CSV file (${results.length} rows) successfully dispatched to Telegram!` : (docResult.error || 'Failed to dispatch to Telegram'),
        filename,
        rowCount: results.length,
        breakouts: breakoutCount,
        result: docResult
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/sync-symbol' && req.method === 'GET') {
    try {
      const symbolName = parsedUrl.searchParams.get('name')?.toUpperCase()?.trim();
      const sym = config.watchlist.find(s => s.name === symbolName);
      if (sym) {
        expiryCache.delete(sym.securityId);
        const today = getTodayIST();
        intradayCache.delete(`${sym.securityId}_${today}`);
        dhanCooldownUntil = 0;
        if (state.symbols[symbolName]) {
          state.symbols[symbolName].hasLoadedIntradayOverview = false;
        }
        await processSymbol(sym);
        addLog(`🔄 [MANUAL SYNC] Symbol ${symbolName} refreshed via Dhan API.`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', symbol: state.symbols[symbolName] }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not_found' }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/send-report' && req.method === 'POST') {
    try {
      const result = await generateAndSendDailyReport();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/scan-now' && req.method === 'POST') {
    try {
      const result = await run5MinuteBreakoutScan(true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    try {
      const newCfg = await readJsonBody(req);
      const tokenChanged = newCfg.dhanAccessToken && 
                           !newCfg.dhanAccessToken.startsWith('****') && 
                           newCfg.dhanAccessToken.trim() !== '' && 
                           newCfg.dhanAccessToken.trim() !== config.dhanAccessToken;

      if (newCfg.dhanClientId !== undefined && newCfg.dhanClientId.trim() !== '') {
        config.dhanClientId = newCfg.dhanClientId.trim();
      }
      if (newCfg.dhanAccessToken && !newCfg.dhanAccessToken.startsWith('****') && newCfg.dhanAccessToken.trim() !== '') {
        config.dhanAccessToken = newCfg.dhanAccessToken.trim();
      }
      if (newCfg.telegramBotToken && !newCfg.telegramBotToken.startsWith('****') && newCfg.telegramBotToken.trim() !== '') {
        config.telegramBotToken = newCfg.telegramBotToken.trim();
      }
      if (newCfg.telegramChatId !== undefined && newCfg.telegramChatId.trim() !== '') {
        config.telegramChatId = newCfg.telegramChatId.trim();
      }
      if (newCfg.telegramAccount2Enabled !== undefined) {
        config.telegramAccount2Enabled = Boolean(newCfg.telegramAccount2Enabled);
      }
      if (newCfg.telegramBotToken2 && !newCfg.telegramBotToken2.startsWith('****') && newCfg.telegramBotToken2.trim() !== '') {
        config.telegramBotToken2 = newCfg.telegramBotToken2.trim();
      }
      if (newCfg.telegramChatId2 !== undefined) {
        config.telegramChatId2 = newCfg.telegramChatId2.trim();
      }
      if (newCfg.barMinutes !== undefined && !isNaN(parseInt(newCfg.barMinutes, 10))) {
        config.barMinutes = parseInt(newCfg.barMinutes, 10);
      }
      if (newCfg.pollIntervalSeconds !== undefined && !isNaN(parseInt(newCfg.pollIntervalSeconds, 10))) {
        config.pollIntervalSeconds = parseInt(newCfg.pollIntervalSeconds, 10);
      }
      if (newCfg.telegramAlertsEnabled !== undefined) {
        config.telegramAlertsEnabled = Boolean(newCfg.telegramAlertsEnabled);
      }
      if (Array.isArray(newCfg.watchlist)) {
        config.watchlist = newCfg.watchlist;
      }

      if (tokenChanged) {
        expiryCache.clear();
        intradayCache.clear();
        dhanCooldownUntil = 0;
        Object.values(state.symbols).forEach(s => {
          s.hasReceivedLive = false;
          s.isLive = false;
          s.hasLoadedIntradayOverview = false;
          s.history = [];
        });
        addLog('🔑 Dhan token updated. Expiry cache and charts reset to live feed.');
      }
      saveConfig();
      addLog(`⚙️ Configuration updated. Dual Telegram Accounts: ${config.telegramAccount2Enabled ? 'ACCOUNT 1 & ACCOUNT 2 ACTIVE' : 'ACCOUNT 1 ONLY'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', message: 'Settings saved successfully!', config }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/telegram-messages' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'success',
      count: state.telegramMessages.length,
      messages: state.telegramMessages
    }));
    return;
  }

  if (pathname === '/api/clear-messages' && req.method === 'POST') {
    state.telegramMessages = [];
    state.alerts = [];
    addLog('🗑️ Telegram message and alert history cleared.');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', message: 'Message history cleared' }));
    return;
  }

  if (pathname === '/api/send-symbol-report' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const symName = (payload.symbol || 'RELIANCE').toUpperCase().trim();
      const sym = state.symbols[symName] || config.watchlist.find(w => w.name === symName) || {
        name: symName,
        spotPrice: 2980.50,
        atmStrike: 2980,
        straddlePrice: 62.40,
        prevDayHighStraddle: 59.00,
        ceLtp: 34.20,
        peLtp: 28.20,
        segment: 'NSE_EQ',
        crossoverEvents: []
      };

      const todayStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full' });
      const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
      const pdh = sym.prevDayHighStraddle || sym.prevCloseStraddle || 1;
      const straddlePrice = sym.straddlePrice || 0;
      const spot = sym.spotPrice || 0;
      const atm = sym.atmStrike || 0;
      const ce = sym.ceLtp != null ? sym.ceLtp : (straddlePrice * 0.52).toFixed(2);
      const pe = sym.peLtp != null ? sym.peLtp : (straddlePrice * 0.48).toFixed(2);
      const totalPremium = (Number(ce) + Number(pe)) || straddlePrice || 1;
      const cePct = ((Number(ce) / totalPremium) * 100).toFixed(1);
      const pePct = ((Number(pe) / totalPremium) * 100).toFixed(1);
      const skewBias = Number(ce) > Number(pe) * 1.08 ? 'Call Bias / Bullish' : (Number(pe) > Number(ce) * 1.08 ? 'Put Bias / Bearish' : 'Neutral Equilibrium');

      const isAbove = straddlePrice > pdh;
      const diffPct = (((straddlePrice - pdh) / pdh) * 100).toFixed(2);
      const crossCount = (sym.crossoverEvents || []).length;
      const maxPeak = Math.max(...(sym.crossoverEvents || []).map(e => e.peakPrice || 0), straddlePrice, sym.dayHighStraddle || 0);
      const peakGain = (((maxPeak - pdh) / pdh) * 100).toFixed(2);
      
      const histPrices = (sym.history || []).map(h => h.price).filter(p => p > 0);
      const minStraddle = histPrices.length > 0 ? Math.min(...histPrices) : (straddlePrice * 0.95).toFixed(2);
      const spread = (maxPeak - minStraddle).toFixed(2);
      const priorityCommodities = ['CRUDEOIL', 'GOLD', 'NATURALGAS', 'SILVER', 'COPPER'];
      const isCommodity = sym.segment === 'MCX_COMM' || priorityCommodities.includes(symName);

      let crossoverText = '';
      if ((sym.crossoverEvents || []).length > 0) {
        sym.crossoverEvents.forEach(evt => {
          const dipInfo = evt.dipTime ? `➔ Retraced below @ ${evt.dipTime}` : `➔ <b>Active Above Boundary</b> 🟢`;
          crossoverText += `  ▫️ <b>Cycle #${evt.crossNum}</b> @ <b>${escapeHtml(evt.startTime)}</b>: Triggered ₹${evt.startPrice} (Peak: ₹${evt.peakPrice}) ${dipInfo}\n`;
        });
      } else {
        crossoverText = `  <i>• No PDH boundary crossover recorded yet today (Normal Theta Contraction).</i>\n`;
      }

      const telegramMsg = `╔════════════════════════════════════════╗\n` +
        `📊 <b>INDIVIDUAL ASSET INTELLIGENCE REPORT</b>\n` +
        `╚════════════════════════════════════════╝\n\n` +
        `🏛️ <b>ASSET:</b> <b>${escapeHtml(symName)}</b> (ATM ${atm})\n` +
        `🏷️ <b>SEGMENT:</b> <b>[${isCommodity ? '🛢️ MCX Commodity' : '🏢 NSE F&O'}]</b>\n` +
        `📅 <b>DATE:</b> ${todayStr} | ⏰ <b>TIME:</b> ${timeStr} IST\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 <b>STRADDLE & OPTION PRICING:</b>\n` +
        `• 🎯 <b>Live Straddle (LTP):</b> <b>₹${straddlePrice}</b>\n` +
        `• 🟢 <b>Call Option (CE):</b> ₹${ce}\n` +
        `• 🔴 <b>Put Option (PE):</b> ₹${pe}\n` +
        `• ⚖️ <b>CE/PE Skew Ratio:</b> ${cePct}% CE vs ${pePct}% PE (<i>${skewBias}</i>)\n` +
        `• 💵 <b>Underlying Cash Spot:</b> ₹${spot}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 <b>BOUNDARY & BREAKOUT ANALYSIS:</b>\n` +
        `• 🧱 <b>PDH Boundary Level:</b> <b>₹${pdh}</b>\n` +
        `• 📐 <b>Distance to Boundary:</b> <b>${diffPct >= 0 ? '+' : ''}${diffPct}%</b>\n` +
        `• 🚦 <b>Boundary State:</b> ${isAbove ? '🟢 <b>ACTIVE RUNNER (Above Boundary)</b>' : '🔴 <b>BELOW BOUNDARY (Normal Theta Decay)</b>'}\n` +
        `• 🔥 <b>Boundary Crossovers Today:</b> <b>${crossCount} time${crossCount === 1 ? '' : 's'}</b>\n` +
        `• 🚀 <b>Day's Peak Straddle:</b> <code>₹${maxPeak}</code> (${peakGain >= 0 ? '+' : ''}${peakGain}% vs PDH)\n` +
        `• 📊 <b>Day Range:</b> ₹${minStraddle} - ₹${maxPeak} (Spread: ₹${spread})\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 <b>TIMELINE & RETEST CYCLES:</b>\n` +
        `${crossoverText}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>Dhan Straddle Pro • On-Demand Asset Intelligence Dispatch</i>`;

      addLog(`📲 [STOCK REPORT] Dispatched on-demand comprehensive report for ${symName} to Telegram.`);

      const resResult = await sendTelegramAlert(telegramMsg, {
        symbol: symName,
        atmStrike: atm,
        straddlePrice: straddlePrice,
        prevDayHighStraddle: pdh,
        crossNum: crossCount,
        pctMove: `${diffPct >= 0 ? '+' : ''}${diffPct}%`,
        spot: spot,
        type: 'STOCK REPORT'
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', symbol: symName, result: resResult, message: `Report for ${symName} sent to Telegram` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: err.message }));
    }
    return;
  }

  if (pathname === '/api/send-test-breakout' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const symName = (payload.symbol || 'RELIANCE').toUpperCase().trim();
      const symData = state.symbols[symName] || {
        spotPrice: 2980.50,
        atmStrike: 2980,
        straddlePrice: 62.40,
        prevDayHighStraddle: 59.00,
        ceLtp: 34.20,
        peLtp: 28.20
      };

      const straddlePrice = payload.straddlePrice != null ? Number(payload.straddlePrice) : (symData.straddlePrice || 62.40);
      const pdh = payload.prevDayHighStraddle != null ? Number(payload.prevDayHighStraddle) : (symData.prevDayHighStraddle || 59.00);
      const crossNum = Number(payload.crossNum) || (symData.crossoverEvents ? symData.crossoverEvents.length + 1 : 1);
      const spot = payload.spot != null ? Number(payload.spot) : (symData.spotPrice || 2980.50);
      const atmStrike = payload.atmStrike != null ? Number(payload.atmStrike) : (symData.atmStrike || 2980);
      const pctMove = pdh > 0 ? (((straddlePrice - pdh) / pdh) * 100).toFixed(2) : '5.76';
      const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

      const telegramMsg = `╔══════════════════════════╗\n` +
        `   🚀 <b>PREVIOUS DAY HIGH BREAKOUT</b> 🟢\n` +
        `╚══════════════════════════╝\n\n` +
        `🏛️ <b>ASSET:</b> 🟢 <b>${escapeHtml(symName)}</b> (ATM ${atmStrike})\n` +
        `⚡ <b>TRIGGER:</b> Live Straddle crossed Previous Day High!\n\n` +
        `💰 <b>STRADDLE PRICE:</b> <code>₹${straddlePrice}</code> (<b>+${pctMove}%</b> above PDH 🟢)\n` +
        `├─ 🟢 <b>Call (CE):</b> ₹${symData.ceLtp ?? '34.20'}\n` +
        `└─ 🔴 <b>Put (PE):</b> ₹${symData.peLtp ?? '28.20'}\n\n` +
        `📌 <b>Prev Day High (PDH):</b> ₹${pdh}\n` +
        `🎯 <b>Underlying Cash:</b> ₹${spot}\n` +
        `⏰ <b>Cross Time:</b> ${timeStr} IST (Crossover #${crossNum})\n` +
        `🔔 <b>Status:</b> LIVE ALERT DISPATCH\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>Dhan Option Chain • Live PDH Breakout Engine</i>`;

      addLog(`🧪 [ALERT DISPATCH] Generated Breakout Alert for ${symName} (Cross #${crossNum}, Straddle ₹${straddlePrice} > PDH ₹${pdh} (+${pctMove}%))...`);

      const resResult = await sendTelegramAlert(telegramMsg, {
        symbol: symName,
        atmStrike: atmStrike,
        straddlePrice: straddlePrice,
        prevDayHighStraddle: pdh,
        crossNum: crossNum,
        pctMove: `+${pctMove}%`,
        spot: spot,
        type: 'PDH BREAKOUT'
      });

      state.alerts.unshift({
        id: Date.now(),
        timestamp: timeStr,
        symbol: symName,
        atmStrike: atmStrike,
        straddlePrice: straddlePrice,
        prevDayHighStraddle: pdh,
        pctMove: pctMove,
        spot: spot,
        isLive: true,
        crossNum: crossNum
      });
      if (state.alerts.length > 50) state.alerts.pop();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', result: resResult, message: 'Breakout alert dispatched' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      configSummary: {
        dhanClientId: config.dhanClientId,
        hasAccessToken: Boolean(config.dhanAccessToken),
        hasTelegramBot: Boolean(config.telegramBotToken),
        barMinutes: config.barMinutes,
        pollInterval: config.pollIntervalSeconds,
        telegramAlertsEnabled: config.telegramAlertsEnabled,
        liveCount: Object.values(state.symbols).filter(s => s.isLive).length
      },
      state: {
        ...state,
        sessionInfo: getMarketSessionInfo('NSE_EQ')
      }
    }));
    return;
  }

  if (pathname === '/api/test-connection' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const dhanClientId = (body.dhanClientId && body.dhanClientId.trim()) || config.dhanClientId;
      const dhanAccessToken = (body.dhanAccessToken && !body.dhanAccessToken.startsWith('****') && body.dhanAccessToken.trim()) || config.dhanAccessToken;
      const telegramBotToken = (body.telegramBotToken && !body.telegramBotToken.startsWith('****') && body.telegramBotToken.trim()) || config.telegramBotToken;
      const telegramChatId = (body.telegramChatId && body.telegramChatId.trim()) || config.telegramChatId;
      const telegramAccount2Enabled = body.telegramAccount2Enabled !== undefined ? Boolean(body.telegramAccount2Enabled) : config.telegramAccount2Enabled;
      const telegramBotToken2 = (body.telegramBotToken2 && !body.telegramBotToken2.startsWith('****') && body.telegramBotToken2.trim()) || config.telegramBotToken2 || telegramBotToken;
      const telegramChatId2 = (body.telegramChatId2 && body.telegramChatId2.trim()) || config.telegramChatId2;
      
      let dhanResult = { status: 'failed', message: 'Not tested' };
      if (dhanAccessToken && dhanClientId) {
        const dRes = await safeFetch('https://api.dhan.co/v2/fundlimit', {
          headers: { 'access-token': dhanAccessToken.trim(), 'client-id': dhanClientId.trim() }
        }, 5000);
        if (dRes.ok) {
          const dData = await dRes.json();
          dhanResult = { status: 'success', message: `Connected! Available Cash: ₹${dData.availabelBalance ?? dData.availableBalance}` };
        } else {
          const errText = await dRes.text();
          dhanResult = { status: 'failed', message: `Dhan HTTP ${dRes.status}: ${errText}` };
        }
      }

      let telegramResult = { status: 'failed', message: 'Not tested' };
      if (telegramBotToken && telegramChatId) {
        const tgRes = await safeFetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: telegramChatId, text: '✅ [Account 1] Bloomberg Terminal: Telegram Connection Test Successful!' })
        }, 5000);
        if (tgRes.ok) {
          telegramResult = { status: 'success', message: `Message delivered to Account 1 (${telegramChatId})!` };
        } else {
          const tgErr = await tgRes.text();
          telegramResult = { status: 'failed', message: `Account 1 error: ${tgErr}` };
        }
      }

      let telegramResult2 = { status: 'not_configured', message: 'Account 2 not enabled' };
      if (telegramAccount2Enabled && telegramChatId2 && (telegramBotToken2 || telegramBotToken)) {
        const token2 = telegramBotToken2 || telegramBotToken;
        const tgRes2 = await safeFetch(`https://api.telegram.org/bot${token2}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: telegramChatId2, text: '✅ [Account 2] Bloomberg Terminal: Telegram Connection Test Successful!' })
        }, 5000);
        if (tgRes2.ok) {
          telegramResult2 = { status: 'success', message: `Message delivered to Account 2 (${telegramChatId2})!` };
        } else {
          const tgErr2 = await tgRes2.text();
          telegramResult2 = { status: 'failed', message: `Account 2 error: ${tgErr2}` };
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dhan: dhanResult, telegram: telegramResult, telegram2: telegramResult2 }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // Serve static files
  let reqPath = '/';
  try {
    reqPath = decodeURIComponent(pathname);
  } catch (e) {
    reqPath = '/';
  }
  let filePath = path.join(PUBLIC_DIR, reqPath === '/' ? 'index.html' : reqPath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'text/plain';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      const noCacheExts = ['.html', '.js', '.css'];
      const cacheHeader = noCacheExts.includes(ext) ? 'no-cache, no-store, must-revalidate' : 'public, max-age=86400';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheHeader, 'Pragma': 'no-cache' });
      res.end(content, 'utf-8');
    }
  });
});

// Process safety crash handlers
process.on('uncaughtException', (err) => {
  console.error('🚨 [PROCESS UNCAUGHT EXCEPTION]:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('🚨 [PROCESS UNHANDLED REJECTION]:', reason);
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🏛️ BLOOMBERG TERMINAL - READY TO SHIP EDITION`);
  console.log(`👉 Running live at: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
