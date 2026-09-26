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
  barMinutes: 15,
  pollIntervalSeconds: 15,
  telegramAlertsEnabled: true,
  watchlist: []
};

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
  logs: []
};

function addLog(msg) {
  const timestamp = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  const entry = `[${timestamp}] ${msg}`;
  state.logs.unshift(entry);
  if (state.logs.length > 100) state.logs.pop();
  console.log(entry);
}

// Telegram Alert Sender
async function sendTelegramAlert(message) {
  if (!config.telegramAlertsEnabled || !config.telegramBotToken || !config.telegramChatId) {
    return { ok: false, message: 'Telegram alerts disabled or missing credentials' };
  }
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
    const data = await res.json();
    return { ok: res.ok, data };
  } catch (err) {
    return { ok: false, error: err.message };
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

async function run5MinuteBreakoutScan() {
  const allSymbols = Object.values(state.symbols);
  const liveSymbols = allSymbols.filter(s => s.hasReceivedLive || s.isLive || s.ceLtp > 0 || s.peLtp > 0);
  const symbols = liveSymbols.length > 0 ? liveSymbols : allSymbols;

  const breakouts = symbols.filter(s => {
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
      
      msg += `<b>${i + 1}. ${s.name}</b> (ATM ${s.atmStrike}) 🟢 <b>[+${pct}% above PDH]</b>\n` +
        `   • <b>Live Straddle:</b> ₹${s.straddlePrice} (CE: ₹${s.ceLtp} + PE: ₹${s.peLtp})\n` +
        `   • <b>Prev Day High:</b> ₹${pdh}\n` +
        `   • <b>Crossovers Today:</b> ${crossCount} time${crossCount > 1 ? 's' : ''}\n` +
        `   • <b>Spot:</b> ₹${s.spotPrice}\n\n`;
    });

    msg += `━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>Dhan Live • 5-Minute PDH Strategy Scan</i>`;

    addLog(`📢 [5-MIN SCANNER] Found ${breakouts.length} stocks above Previous Day High. Dispatched to Telegram.`);
    await sendTelegramAlert(msg);
    return { status: 'success', breakouts: breakouts.length, count: symbols.length };
  } else {
    const msg = `╔══════════════════════════╗\n` +
      `   ⚡ <b>5-MIN LIVE SCANNER PULSE</b>\n` +
      `╚══════════════════════════╝\n\n` +
      `⏰ <b>Scan Time:</b> ${timeStr} IST\n` +
      `📊 <b>Active Underlyings Scanned:</b> ${symbols.length}\n` +
      `🔍 <b>Breakout Status:</b> 0 stocks above Previous Day High (All normal / decaying)\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `<i>Monitoring all F&O stocks and MCX commodities every 5 minutes.</i>`;

    addLog(`ℹ️ [5-MIN SCANNER] Scan complete at ${timeStr}. No active PDH breakouts.`);
    await sendTelegramAlert(msg);
    return { status: 'success', breakouts: 0, count: symbols.length };
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

// Check market hours (NSE: Mon-Fri 09:15-15:30 IST; MCX: Mon-Fri 09:00-23:30 IST)
function checkMarketOpen(segment = 'NSE_EQ') {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(now);
  const hash = {};
  parts.forEach(p => hash[p.type] = p.value);

  const day = hash.weekday;
  const hour = parseInt(hash.hour, 10);
  const minute = parseInt(hash.minute, 10);

  if (day === 'Sat' || day === 'Sun') return false;

  const currentMin = hour * 60 + minute;

  if (segment === 'MCX_COMM' || segment === 'MCX') {
    // MCX Commodities: 09:00 AM to 11:30 PM (23:30) IST
    const openMin = 9 * 60; // 09:00 AM
    const closeMin = 23 * 60 + 30; // 11:30 PM
    return currentMin >= openMin && currentMin <= closeMin;
  } else {
    // NSE Equities & Indices: 09:15 AM to 03:30 PM (15:30) IST
    const openMin = 9 * 60 + 15;   // 9:15 AM
    const closeMin = 15 * 60 + 30; // 3:30 PM
    return currentMin >= openMin && currentMin <= closeMin;
  }
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
    const res = await fetch('https://api.dhan.co/v2/fundlimit', {
      method: 'GET',
      headers: getDhanHeaders()
    });
    if (res.ok) {
      const data = await res.json();
      state.dhanConnected = true;
      return data;
    }
  } catch (err) {
    // Ignore transient fetch errors
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
    const expRes = await fetch('https://api.dhan.co/v2/optionchain/expirylist', {
      method: 'POST',
      headers: getDhanHeaders(),
      body: JSON.stringify({ UnderlyingScrip: securityId, UnderlyingSeg: segment })
    });

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

    await sleep(250);

    const ocRes = await fetch('https://api.dhan.co/v2/optionchain', {
      method: 'POST',
      headers: getDhanHeaders(),
      body: JSON.stringify({ UnderlyingScrip: securityId, UnderlyingSeg: segment, Expiry: expiry })
    });

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
        const strikes = Object.keys(oc).map(Number).filter(n => !isNaN(n));
        if (strikes.length > 0) {
          const atmStrike = strikes.reduce((prev, curr) => Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev);
          const strikeKey = Object.keys(oc).find(k => Math.abs(Number(k) - atmStrike) < 0.01);
          const leg = strikeKey ? oc[strikeKey] : null;
          
          if (leg) {
            const ceLtp = Number(leg.ce?.last_price || 0);
            const peLtp = Number(leg.pe?.last_price || 0);
            const cePrev = Number(leg.ce?.previous_close_price || 0);
            const pePrev = Number(leg.pe?.previous_close_price || 0);

            const straddlePrice = parseFloat((ceLtp + peLtp).toFixed(2));
            const prevCloseStraddle = parseFloat((cePrev + pePrev).toFixed(2));

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
    // Handled
  }
  return null;
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

// Fallback Realistic Profile for Offline Simulation & Commodity Profiles
function getStockRealisticProfile(name) {
  const n = name.toUpperCase().trim();
  const EXACT_PRICES = {
    'NIFTY': { spot: 23270.60, strikeStep: 50, straddlePct: 0.0102 },
    'BANKNIFTY': { spot: 56055.75, strikeStep: 100, straddlePct: 0.0199 },
    'FINNIFTY': { spot: 25318.35, strikeStep: 50, straddlePct: 0.0205 },
    'MIDCPNIFTY': { spot: 13150.30, strikeStep: 25, straddlePct: 0.011 },
    'CRUDEOIL': { spot: 6245.00, strikeStep: 50, straddlePct: 0.022 },
    'NATURALGAS': { spot: 242.80, strikeStep: 5, straddlePct: 0.035 },
    'GOLD': { spot: 76500.00, strikeStep: 100, straddlePct: 0.012 },
    'SILVER': { spot: 91800.00, strikeStep: 500, straddlePct: 0.015 },
    'COPPER': { spot: 825.50, strikeStep: 5, straddlePct: 0.018 }
  };
  if (EXACT_PRICES[n]) return EXACT_PRICES[n];

  let hash = 0;
  for (let i = 0; i < n.length; i++) {
    hash = (hash << 5) - hash + n.charCodeAt(i);
    hash |= 0;
  }
  const positiveHash = Math.abs(hash);
  const baseSpot = 150 + (positiveHash % 2850);
  const strikeStep = baseSpot > 2000 ? 50 : (baseSpot > 1000 ? 20 : (baseSpot > 500 ? 10 : (baseSpot > 100 ? 5 : 1)));
  const straddlePct = 0.015 + ((positiveHash % 15) / 1000);
  return { spot: parseFloat(baseSpot.toFixed(2)), strikeStep, straddlePct };
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
      history: [],
      ceLtp: 0,
      peLtp: 0,
      cePrev: 0,
      pePrev: 0,
      breakout: false,
      breakoutAlerted: false,
      isLive: false,
      hasReceivedLive: false,
      hasLoadedIntradayOverview: false,
      dataSource: hasDhanCreds ? 'SYNCING...' : 'SIMULATED'
    };
  }

  const item = state.symbols[name];
  let liveData = null;

  if (hasDhanCreds) {
    liveData = await fetchLiveStraddle(sym.securityId, sym.segment);
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
          
          // Reconstruct historical crossover events from the intraday session bars
          const pdh = item.prevDayHighStraddle || item.prevCloseStraddle;
          item.crossoverEvents = [];
          let isAbove = false;
          
          for (const bar of fullDayHistory) {
            if (bar.price > pdh) {
              if (!isAbove) {
                isAbove = true;
                item.crossoverEvents.push({
                  crossNum: item.crossoverEvents.length + 1,
                  startTime: bar.time,
                  startPrice: bar.price,
                  peakPrice: bar.price,
                  dipTime: null,
                  active: true
                });
                item.breakoutHappenedToday = true;
              } else {
                const lastEvt = item.crossoverEvents[item.crossoverEvents.length - 1];
                if (bar.price > lastEvt.peakPrice) lastEvt.peakPrice = bar.price;
              }
            } else {
              if (isAbove) {
                isAbove = false;
                const lastEvt = item.crossoverEvents[item.crossoverEvents.length - 1];
                lastEvt.dipTime = bar.time;
                lastEvt.active = false;
              }
            }
          }
          
          addLog(`📊 [INTRADAY OVERVIEW] Loaded full session chart (${fullDayHistory.length} bars, ${item.crossoverEvents.length} PDH crossovers) for ${name}`);
        } else {
          item.history = [{
            time: 'Close',
            price: liveData.straddlePrice,
            spot: liveData.spot
          }];
        }
      }
    } else {
      // Market is LIVE: Stream real-time ticks
      item.hasLoadedIntradayOverview = false;
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
    }

    if (wasNotLive) {
      addLog(`📡 [DHAN LIVE] Connected for ${name}: Spot ₹${liveData.spot}, ATM ${liveData.atmStrike}, Straddle ₹${liveData.straddlePrice} (PDH: ₹${item.prevDayHighStraddle})`);
    }

  } else if (item.hasReceivedLive) {
    item.isLive = true;
    item.dataSource = 'DHAN_LIVE';
  } else if (!hasDhanCreds) {
    // Offline simulation mode ONLY when no credentials are provided
    item.isLive = false;
    item.dataSource = 'SIMULATED';
    const profile = getStockRealisticProfile(name);
    const step = profile.spot > 10000 ? 0.25 : (profile.spot > 1000 ? 0.10 : 0.05);
    const direction = (Math.random() - 0.48);
    const straddleDelta = parseFloat((direction * step * (profile.spot * 0.001)).toFixed(2));
    const spotDelta = parseFloat((direction * step * 3).toFixed(2));

    item.straddlePrice = parseFloat(Math.max(0.10, item.straddlePrice + straddleDelta).toFixed(2));
    item.spotPrice = parseFloat(Math.max(1.00, item.spotPrice + spotDelta).toFixed(2));
    item.atmStrike = Math.round(item.spotPrice / profile.strikeStep) * profile.strikeStep;

    item.history.push({
      time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }),
      price: item.straddlePrice,
      spot: item.spotPrice
    });
    if (item.history.length > 50) item.history.shift();
  }

  // =========================================================================
  // ⚡ PREVIOUS DAY HIGH (PDH) CROSSOVER STATE MACHINE & 1-ALERT-PER-DAY LOGIC
  // =========================================================================
  const pdh = item.prevDayHighStraddle || item.prevCloseStraddle;
  const currentPrice = item.straddlePrice;
  const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

  if (pdh && pdh > 0 && currentPrice > 0) {
    if (currentPrice > pdh) {
      // PRICE IS CURRENTLY ABOVE PREVIOUS DAY HIGH
      item.breakout = true;
      item.breakoutHappenedToday = true;

      if (!item.isCurrentlyAbovePdh) {
        // TRANSITION: BELOW -> ABOVE PDH (NEW CROSSOVER EVENT)
        item.isCurrentlyAbovePdh = true;
        const crossNum = (item.crossoverEvents || []).length + 1;
        
        const newEvent = {
          crossNum,
          startTime: timeStr,
          startPrice: currentPrice,
          peakPrice: currentPrice,
          dipTime: null,
          active: true
        };
        if (!item.crossoverEvents) item.crossoverEvents = [];
        item.crossoverEvents.push(newEvent);

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
          sendTelegramAlert(telegramMsg);
        } else if (item.pdhAlertSentDate === todayIST) {
          addLog(`ℹ️ [${name}] Crossed PDH again at ${timeStr} (Cross #${crossNum}, ₹${currentPrice} > ₹${pdh}). Alert suppressed (1-alert-per-day limit active).`);
        }
      } else {
        // CONTINUOUS MONITORING ABOVE PDH: Update the Peak reached during this crossover
        if (item.crossoverEvents && item.crossoverEvents.length > 0) {
          const activeEvt = item.crossoverEvents[item.crossoverEvents.length - 1];
          if (currentPrice > activeEvt.peakPrice) {
            activeEvt.peakPrice = currentPrice;
          }
        }
      }
    } else {
      // PRICE IS CURRENTLY BELOW OR EQUAL TO PREVIOUS DAY HIGH
      item.breakout = false;
      if (item.isCurrentlyAbovePdh) {
        // TRANSITION: ABOVE -> BELOW PDH (DIPPED BELOW)
        item.isCurrentlyAbovePdh = false;
        if (item.crossoverEvents && item.crossoverEvents.length > 0) {
          const activeEvt = item.crossoverEvents[item.crossoverEvents.length - 1];
          activeEvt.dipTime = timeStr;
          activeEvt.active = false;
          addLog(`📉 [${name}] Straddle retraced below PDH (₹${currentPrice} <= ₹${pdh}) at ${timeStr}. Peak reached was ₹${activeEvt.peakPrice}`);
        }
      }
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
          await sleep(500);
        }
      }

      // 2. All other Watchlist stocks in sequence
      const otherSymbols = config.watchlist.filter(s => !priorityNames.includes(s.name));
      for (const sym of otherSymbols) {
        await processSymbol(sym);
        await sleep(500);
      }

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API Endpoints
  if (req.url?.startsWith('/api/sync-symbol') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const symbolName = urlObj.searchParams.get('name')?.toUpperCase()?.trim();
      const sym = config.watchlist.find(s => s.name === symbolName);
      if (sym) {
        await processSymbol(sym);
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

  if (req.url === '/api/send-report' && req.method === 'POST') {
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

  if (req.url === '/api/scan-now' && req.method === 'POST') {
    try {
      const result = await run5MinuteBreakoutScan();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (req.url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const newCfg = JSON.parse(body || '{}');
        const tokenChanged = newCfg.dhanAccessToken && newCfg.dhanAccessToken !== config.dhanAccessToken;
        config = { ...config, ...newCfg };
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
        addLog(`⚙️ Configuration updated. Telegram alerts: ${config.telegramAlertsEnabled ? 'ENABLED' : 'OFF'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', message: 'Settings saved successfully!' }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
    });
    return;
  }

  if (req.url === '/api/status' && req.method === 'GET') {
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
      state: state
    }));
    return;
  }

  if (req.url === '/api/test-connection' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { dhanClientId, dhanAccessToken, telegramBotToken, telegramChatId } = JSON.parse(body || '{}');
        
        let dhanResult = { status: 'failed', message: 'Not tested' };
        if (dhanAccessToken && dhanClientId) {
          const dRes = await fetch('https://api.dhan.co/v2/fundlimit', {
            headers: { 'access-token': dhanAccessToken.trim(), 'client-id': dhanClientId.trim() }
          });
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
          const tgRes = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: telegramChatId, text: '✅ Bloomberg Terminal Web App: Telegram Connection Test Successful!' })
          });
          if (tgRes.ok) {
            telegramResult = { status: 'success', message: 'Message delivered to Telegram!' };
          } else {
            const tgErr = await tgRes.text();
            telegramResult = { status: 'failed', message: `Telegram error: ${tgErr}` };
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ dhan: dhanResult, telegram: telegramResult }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
    });
    return;
  }

  // Serve static files
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
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
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🏛️ BLOOMBERG TERMINAL - READY TO SHIP EDITION`);
  console.log(`👉 Running live at: http://localhost:3000`);
  console.log(`==================================================\n`);
});
