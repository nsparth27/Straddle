// Security PIN Protection & 3-Attempts Lockout Engine
let lockoutInterval = null;

function getActivePin() {
  return localStorage.getItem('terminal_active_pin') || '2711';
}

function getFailCount() {
  return parseInt(localStorage.getItem('terminal_fail_count') || '0', 10);
}

function getBlockUntil() {
  return parseInt(localStorage.getItem('terminal_block_until') || '0', 10);
}

function updateLockoutUI() {
  const blockUntil = getBlockUntil();
  const now = Date.now();
  const lockoutBox = document.getElementById('pinLockoutBox');
  const pinInput = document.getElementById('pinInput');
  const pinSubmitBtn = document.getElementById('pinSubmitBtn');
  const attemptsLabel = document.getElementById('pinAttemptsLabel');
  const timerEl = document.getElementById('lockoutTimer');
  const pinError = document.getElementById('pinError');
  const pinBadge = document.getElementById('pinBadge');

  if (blockUntil > now) {
    // Currently in 5-minute Lockout Mode
    if (lockoutBox) lockoutBox.style.display = 'block';
    if (pinInput) {
      pinInput.disabled = true;
      pinInput.placeholder = 'LOCKED';
    }
    if (pinSubmitBtn) pinSubmitBtn.disabled = true;
    if (pinBadge) {
      pinBadge.textContent = '⛔ TERMINAL BLOCKED';
      pinBadge.style.borderColor = 'var(--bb-red)';
      pinBadge.style.color = 'var(--bb-red)';
      pinBadge.style.background = 'rgba(255, 61, 0, 0.15)';
    }
    if (attemptsLabel) attemptsLabel.textContent = '🔒 Access locked for 5 minutes';

    const remainingSec = Math.ceil((blockUntil - now) / 1000);
    const mins = String(Math.floor(remainingSec / 60)).padStart(2, '0');
    const secs = String(remainingSec % 60).padStart(2, '0');
    if (timerEl) timerEl.textContent = `⏳ ${mins}:${secs}`;

    if (!lockoutInterval) {
      lockoutInterval = setInterval(updateLockoutUI, 1000);
    }
  } else {
    // Normal / Unlocked Mode
    if (lockoutInterval) {
      clearInterval(lockoutInterval);
      lockoutInterval = null;
    }
    if (blockUntil > 0 && blockUntil <= now) {
      // 5-minute lockout finished! Reset attempts, keep new PIN (2711)
      localStorage.removeItem('terminal_block_until');
      localStorage.setItem('terminal_fail_count', '0');
      if (pinError) pinError.textContent = 'ℹ️ Lockout expired. You may try again.';
    }

    if (lockoutBox) lockoutBox.style.display = 'none';
    if (pinInput) {
      pinInput.disabled = false;
      pinInput.placeholder = '••••';
    }
    if (pinSubmitBtn) pinSubmitBtn.disabled = false;
    if (pinBadge) {
      pinBadge.textContent = '🔒 SECURITY LEVEL 1';
      pinBadge.style.borderColor = 'var(--bb-amber)';
      pinBadge.style.color = 'var(--bb-amber)';
      pinBadge.style.background = 'rgba(255, 176, 0, 0.12)';
    }

    const fails = getFailCount();
    const remainingAttempts = Math.max(0, 3 - fails);
    if (attemptsLabel) {
      attemptsLabel.textContent = `Attempts remaining: ${remainingAttempts} / 3`;
    }
  }
}

function checkAuth() {
  const isAuth = sessionStorage.getItem('terminal_auth');
  const modal = document.getElementById('pinLockModal');
  if (isAuth === 'true') {
    if (modal) modal.style.display = 'none';
    return true;
  } else {
    if (modal) modal.style.display = 'flex';
    updateLockoutUI();
    setTimeout(() => {
      const pinInput = document.getElementById('pinInput');
      if (pinInput && !pinInput.disabled) pinInput.focus();
    }, 100);
    return false;
  }
}

function verifyPin() {
  const now = Date.now();
  if (getBlockUntil() > now) {
    updateLockoutUI();
    return;
  }

  const pinInput = document.getElementById('pinInput');
  const pinError = document.getElementById('pinError');
  const enteredPin = (pinInput.value || '').trim();
  const currentPin = getActivePin();

  if (enteredPin === currentPin) {
    // Successful Authentication
    sessionStorage.setItem('terminal_auth', 'true');
    localStorage.setItem('terminal_fail_count', '0');
    localStorage.removeItem('terminal_block_until');
    
    const modal = document.getElementById('pinLockModal');
    if (modal) modal.style.display = 'none';
    pinError.textContent = '';
    pinInput.value = '';
    loadSettings();
    fetchStatus();
  } else {
    // Failed Authentication Attempt
    const newFails = getFailCount() + 1;
    localStorage.setItem('terminal_fail_count', String(newFails));

    if (newFails >= 3) {
      // 🚨 Trigger 5-minute Lockout + Change PIN to 2712
      const blockTime = Date.now() + 5 * 60 * 1000;
      localStorage.setItem('terminal_block_until', String(blockTime));
      localStorage.setItem('terminal_active_pin', '2712'); // Dynamic PIN Change to 2712
      pinError.textContent = '⛔ 3 Failed Attempts: Access Blocked for 5 Minutes!';
      updateLockoutUI();
    } else {
      const left = 3 - newFails;
      pinError.textContent = `❌ ACCESS DENIED: Invalid Security PIN (${left} attempt${left > 1 ? 's' : ''} left)`;
      pinInput.value = '';
      pinInput.focus();
      pinInput.classList.add('shake');
      setTimeout(() => pinInput.classList.remove('shake'), 500);
      updateLockoutUI();
    }
  }
}

function lockTerminal() {
  sessionStorage.removeItem('terminal_auth');
  checkAuth();
}

// Global Chart instances and filter state
const charts = {};
let currentFilter = 'ALL'; // 'ALL', 'INDICES', 'BREAKOUTS'
let searchQuery = '';

// Setup PIN Enter Key listener on page load
document.addEventListener('DOMContentLoaded', () => {
  const pinInput = document.getElementById('pinInput');
  if (pinInput) {
    pinInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        verifyPin();
      }
    });
  }
  checkAuth();
});

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  const targetBtn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick').includes(tabId));
  if (targetBtn) targetBtn.classList.add('active');

  const targetContent = document.getElementById(`tab-${tabId}`);
  if (targetContent) targetContent.classList.add('active');
}

// Clock Manager (IST)
function updateClock() {
  const now = new Date();
  const options = { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
  document.getElementById('clockIST').textContent = `${now.toLocaleTimeString('en-IN', options)} IST`;
}
setInterval(updateClock, 1000);
updateClock();

// Load Config into Settings Form
async function loadSettings() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
      document.getElementById('cfgDhanClientId').value = cfg.dhanClientId || '';
      document.getElementById('cfgDhanAccessToken').value = cfg.dhanAccessToken || '';
      document.getElementById('cfgTelegramBotToken').value = cfg.telegramBotToken || '';
      document.getElementById('cfgTelegramChatId').value = cfg.telegramChatId || '';
      document.getElementById('cfgBarMinutes').value = cfg.barMinutes || 15;
      document.getElementById('cfgPollInterval').value = cfg.pollIntervalSeconds || 15;
      document.getElementById('cfgTelegramAlertsEnabled').checked = Boolean(cfg.telegramAlertsEnabled);
      document.getElementById('fnoCountLabel').textContent = `${(cfg.watchlist || []).length} F&O STOCKS ACTIVE`;
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}
loadSettings();

// Filter Handlers
function filterSymbols() {
  searchQuery = document.getElementById('symbolSearch').value.trim().toUpperCase();
  fetchStatus();
}

function setFilter(filterType) {
  currentFilter = filterType;
  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`filterBtn${filterType}`).classList.add('active');
  fetchStatus();
}

// Settings Form Submission
document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const toast = document.getElementById('settingsToast');
  toast.style.display = 'none';

  const newCfg = {
    dhanClientId: document.getElementById('cfgDhanClientId').value.trim(),
    dhanAccessToken: document.getElementById('cfgDhanAccessToken').value.trim(),
    telegramBotToken: document.getElementById('cfgTelegramBotToken').value.trim(),
    telegramChatId: document.getElementById('cfgTelegramChatId').value.trim(),
    telegramAlertsEnabled: document.getElementById('cfgTelegramAlertsEnabled').checked,
    barMinutes: parseInt(document.getElementById('cfgBarMinutes').value, 10),
    pollIntervalSeconds: parseInt(document.getElementById('cfgPollInterval').value, 10)
  };

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newCfg)
    });
    const data = await res.json();
    if (res.ok) {
      toast.className = 'alert-toast success';
      toast.textContent = '✅ Settings saved successfully! Real-time monitor updated.';
      toast.style.display = 'block';
    } else {
      toast.className = 'alert-toast error';
      toast.textContent = `❌ ${data.message}`;
      toast.style.display = 'block';
    }
  } catch (err) {
    toast.className = 'alert-toast error';
    toast.textContent = `❌ Server connection failed: ${err.message}`;
    toast.style.display = 'block';
  }
});

// Run Diagnostics Connection Test
async function runConnectionTest() {
  const diagDhan = document.getElementById('diagDhan');
  const diagTelegram = document.getElementById('diagTelegram');

  diagDhan.innerHTML = 'Testing Dhan Trading & Data API...';
  diagDhan.className = 'diag-result info';
  diagTelegram.innerHTML = 'Testing Telegram Bot connection...';
  diagTelegram.className = 'diag-result info';

  const payload = {
    dhanClientId: document.getElementById('cfgDhanClientId').value.trim(),
    dhanAccessToken: document.getElementById('cfgDhanAccessToken').value.trim(),
    telegramBotToken: document.getElementById('cfgTelegramBotToken').value.trim(),
    telegramChatId: document.getElementById('cfgTelegramChatId').value.trim()
  };

  try {
    const res = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.dhan?.status === 'success') {
      diagDhan.className = 'diag-result success';
      diagDhan.innerHTML = `✅ <b>DHAN API OK:</b> ${data.dhan.message}`;
    } else {
      diagDhan.className = 'diag-result error';
      diagDhan.innerHTML = `❌ <b>DHAN API ERROR:</b> ${data.dhan?.message || 'Connection failed'}`;
    }

    if (data.telegram?.status === 'success') {
      diagTelegram.className = 'diag-result success';
      diagTelegram.innerHTML = `✅ <b>TELEGRAM BOT OK:</b> ${data.telegram.message}`;
    } else {
      diagTelegram.className = 'diag-result error';
      diagTelegram.innerHTML = `❌ <b>TELEGRAM ERROR:</b> ${data.telegram?.message || 'Connection failed'}`;
    }
  } catch (err) {
    diagDhan.className = 'diag-result error';
    diagDhan.innerHTML = `❌ Dhan Test Failed: ${err.message}`;
    diagTelegram.className = 'diag-result error';
    diagTelegram.innerHTML = `❌ Telegram Test Failed: ${err.message}`;
  }
}

// Trigger Manual EOD Telegram Report
async function triggerDailyReport() {
  try {
    const res = await fetch('/api/send-report', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'success') {
      alert('✅ Daily EOD Summary Report sent to Telegram successfully!');
    } else {
      alert('⚠️ Report generated, but Telegram send returned: ' + (data.response?.data?.description || data.message || 'Check Bot'));
    }
  } catch(err) {
    alert('❌ Error requesting report: ' + err.message);
  }
}

// Trigger Manual 5-Minute Live Breakout Scan
async function trigger5MinScan() {
  try {
    const res = await fetch('/api/scan-now', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'success') {
      alert(`⚡ 5-Minute Live Scan executed! Found ${data.breakouts} breakout stocks out of ${data.count} scanned.`);
    } else {
      alert('⚠️ Scan error: ' + (data.message || 'Check server'));
    }
  } catch(err) {
    alert('❌ Error requesting 5-min scan: ' + err.message);
  }
}

// Trigger Simple Ping Test Alert
async function triggerTestAlert() {
  runConnectionTest();
  switchTab('settings');
}

// Render/Update Live Symbol Cards & Chart.js Graphs smoothly
function renderSymbolCard(sym, isMarketOpen) {
  const container = document.getElementById('symbolsContainer');
  let card = document.getElementById(`card-${sym.name}`);

  const pdh = sym.prevDayHighStraddle || sym.prevCloseStraddle || sym.prevBarClose;
  const isBreakout = sym.breakout || (pdh && sym.straddlePrice > pdh);
  const pctMovePdh = (pdh && pdh > 0) ? (((sym.straddlePrice - pdh) / pdh) * 100).toFixed(2) : '0.00';
  const crossCount = (sym.crossoverEvents || []).length;
  const isLive = Boolean(sym.isLive);
  const historyData = sym.history || [];
  const isCommodity = sym.segment === 'MCX_COMM' || ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER'].includes(sym.name);
  const sessionLabel = isMarketOpen ? (isCommodity ? 'MCX STREAM' : 'LIVE STREAM') : 'SETTLED OVERVIEW';

  if (!card) {
    card = document.createElement('div');
    card.id = `card-${sym.name}`;
    card.className = 'bb-panel';
    card.innerHTML = `
      <div class="panel-header">
        <div class="panel-title" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
          <span>${sym.name} STRADDLE</span>
          <span class="badge-breakout" id="source-${sym.name}" style="background: ${isLive ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255, 176, 0, 0.1)'}; color: ${isLive ? 'var(--bb-green)' : 'var(--bb-amber)'}; border-color: ${isLive ? 'var(--bb-green)' : 'var(--bb-amber)'}; font-size: 0.65rem;">
            ${isLive ? `🟢 DHAN ${sessionLabel}` : '🟠 SYNCING...'}
          </span>
          <span class="badge-breakout" id="badge-${sym.name}" style="background: ${isBreakout ? 'var(--bb-green-glow)' : 'rgba(255, 176, 0, 0.1)'}; color: ${isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)'}; border-color: ${isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)'};">
            ${isBreakout ? `🚀 ABOVE PDH (+${pctMovePdh}%)` : (isMarketOpen ? '🟡 MONITORING' : '🌙 SETTLED')}
          </span>
          ${crossCount > 0 ? `<span class="badge-breakout" id="crossbadge-${sym.name}" style="background: rgba(0, 255, 255, 0.15); color: var(--bb-cyan); border-color: var(--bb-cyan);">🔥 ${crossCount} Cross${crossCount > 1 ? 'es' : ''} Today</span>` : ''}
        </div>
        <span style="font-size: 0.8rem; color: var(--bb-text-muted);">ATM Strike: <b style="color: var(--bb-cyan);" id="strike-${sym.name}">${sym.atmStrike || '--'}</b></span>
      </div>

      <div class="grid-4" style="margin-bottom: 1rem;">
        <div class="stat-card ${isBreakout ? 'breakout' : ''}" id="statcard-${sym.name}">
          <div class="stat-label">Live Straddle</div>
          <div class="stat-val" id="price-${sym.name}" style="color: ${isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)'};">₹${sym.straddlePrice || '0.00'}</div>
          <div class="stat-sub" id="legs-${sym.name}">CE: ₹${sym.ceLtp || '--'} | PE: ₹${sym.peLtp || '--'}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Prev Day High (PDH)</div>
          <div class="stat-val" id="prevclose-${sym.name}">₹${pdh || '0.00'}</div>
          <div class="stat-sub" id="prevlegs-${sym.name}">Breakout Level</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Move vs PDH</div>
          <div class="stat-val" id="move-${sym.name}" style="color: ${pctMovePdh >= 0 ? 'var(--bb-green)' : 'var(--bb-red)'};">${pctMovePdh >= 0 ? '+' : ''}${pctMovePdh}%</div>
          <div class="stat-sub" id="crosscount-${sym.name}">${crossCount > 0 ? `${crossCount} Crossover${crossCount > 1 ? 's' : ''}` : 'No Crossover Yet'}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Underlying Spot</div>
          <div class="stat-val" style="color: var(--bb-cyan);" id="spot-${sym.name}">₹${sym.spotPrice || '0.00'}</div>
          <div class="stat-sub">${isCommodity ? 'MCX Commodity' : 'Spot Price'}</div>
        </div>
      </div>

      <div class="chart-container">
        <canvas id="chart-${sym.name}"></canvas>
      </div>
    `;
    container.appendChild(card);

    // Initialize Chart.js Instance ONCE
    const ctx = document.getElementById(`chart-${sym.name}`).getContext('2d');
    charts[sym.name] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: historyData.map(h => h.time),
        datasets: [{
          label: `${sym.name} Straddle Price (₹)`,
          data: historyData.map(h => h.price),
          borderColor: isLive ? '#00E676' : '#FFB000',
          backgroundColor: isLive ? 'rgba(0, 230, 118, 0.12)' : 'rgba(255, 176, 0, 0.08)',
          borderWidth: 2,
          fill: true,
          tension: 0.2,
          pointRadius: historyData.length > 30 ? 2 : 3,
          pointHoverRadius: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` Straddle: ₹${ctx.parsed.y} | Spot: ₹${(historyData[ctx.dataIndex]?.spot || sym.spotPrice)}`
            }
          }
        },
        scales: {
          x: { ticks: { color: '#64748B', font: { family: 'JetBrains Mono', size: 9 }, maxRotation: 45 }, grid: { color: '#1E2330' } },
          y: { ticks: { color: '#FFB000', font: { family: 'JetBrains Mono', size: 10 } }, grid: { color: '#1E2330' } }
        }
      }
    });
  } else {
    // Smooth DOM Update
    document.getElementById(`price-${sym.name}`).textContent = `₹${sym.straddlePrice}`;
    document.getElementById(`price-${sym.name}`).style.color = isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)';
    document.getElementById(`prevclose-${sym.name}`).textContent = `₹${pdh}`;
    
    const legsEl = document.getElementById(`legs-${sym.name}`);
    if (legsEl && sym.ceLtp != null && sym.peLtp != null) {
      legsEl.textContent = `CE: ₹${sym.ceLtp} | PE: ₹${sym.peLtp}`;
    }

    const moveEl = document.getElementById(`move-${sym.name}`);
    moveEl.textContent = `${pctMovePdh >= 0 ? '+' : ''}${pctMovePdh}%`;
    moveEl.style.color = pctMovePdh >= 0 ? 'var(--bb-green)' : 'var(--bb-red)';

    const crossSub = document.getElementById(`crosscount-${sym.name}`);
    if (crossSub) {
      crossSub.textContent = crossCount > 0 ? `${crossCount} Crossover${crossCount > 1 ? 's' : ''}` : 'No Crossover Yet';
    }

    document.getElementById(`spot-${sym.name}`).textContent = `₹${sym.spotPrice}`;
    document.getElementById(`strike-${sym.name}`).textContent = sym.atmStrike;

    const sourceBadge = document.getElementById(`source-${sym.name}`);
    if (sourceBadge) {
      sourceBadge.textContent = isLive ? `🟢 DHAN ${sessionLabel}` : '🟠 SYNCING...';
      sourceBadge.style.background = isLive ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255, 176, 0, 0.1)';
      sourceBadge.style.color = isLive ? 'var(--bb-green)' : 'var(--bb-amber)';
      sourceBadge.style.borderColor = isLive ? 'var(--bb-green)' : 'var(--bb-amber)';
    }

    const badge = document.getElementById(`badge-${sym.name}`);
    badge.textContent = isBreakout ? `🚀 ABOVE PDH (+${pctMovePdh}%)` : (isMarketOpen ? '🟡 MONITORING' : '🌙 SETTLED');
    badge.style.background = isBreakout ? 'var(--bb-green-glow)' : 'rgba(255, 176, 0, 0.1)';
    badge.style.color = isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)';
    badge.style.borderColor = isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)';

    if (charts[sym.name]) {
      charts[sym.name].data.labels = historyData.map(h => h.time);
      charts[sym.name].data.datasets[0].data = historyData.map(h => h.price);
      charts[sym.name].data.datasets[0].borderColor = isLive ? '#00E676' : '#FFB000';
      charts[sym.name].data.datasets[0].backgroundColor = isLive ? (isBreakout ? 'rgba(0, 230, 118, 0.2)' : 'rgba(0, 230, 118, 0.10)') : 'rgba(255, 176, 0, 0.08)';
      charts[sym.name].options.scales.x.ticks.font.size = historyData.length > 20 ? 8 : 10;
      charts[sym.name].update('none');
    }
  }
}

// Fetch & Update Live Status from Server
async function fetchStatus() {
  if (sessionStorage.getItem('terminal_auth') !== 'true') {
    return;
  }
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;

    const data = await res.json();
    const state = data.state || {};
    const configSummary = data.configSummary || {};
    const isMarketOpen = Boolean(state.isMarketOpen);

    // 1. Market & Dhan Connection Status
    const marketDot = document.getElementById('marketDot');
    const marketText = document.getElementById('marketStatusText');
    const hasDhan = Boolean(configSummary.hasAccessToken);

    if (hasDhan) {
      if (isMarketOpen) {
        marketDot.className = 'dot';
        marketText.textContent = '🟢 MARKET OPEN (NSE & MCX REAL-TIME STREAM)';
      } else {
        marketDot.className = 'dot closed';
        marketText.textContent = '🌙 MARKET CLOSED — SETTLED OVERVIEW ACTIVE';
      }
    } else {
      marketDot.className = 'dot closed';
      marketText.textContent = '🟠 SIMULATION MODE (ENTER DHAN KEYS IN SETTINGS)';
    }

    // 2. Account Funds
    const fund = state.fundSummary || {};
    if (fund.dhanClientId) {
      document.getElementById('dhanClientIdLabel').textContent = `Client ID: ${fund.dhanClientId}`;
    }
    const avail = fund.availabelBalance ?? fund.availableBalance ?? 0;
    const util = fund.utilizedAmount ?? 0;
    const collat = fund.collateralAmount ?? 0;

    document.getElementById('fundAvail').textContent = `₹${avail.toLocaleString('en-IN')}`;
    document.getElementById('fundUtilized').textContent = `₹${util.toLocaleString('en-IN')}`;
    document.getElementById('fundCollateral').textContent = `₹${collat.toLocaleString('en-IN')}`;

    // Update Ticker Top Tape
    const symbolsMap = state.symbols || {};
    if (symbolsMap['NIFTY']) {
      document.getElementById('tNiftySpot').textContent = `₹${symbolsMap['NIFTY'].spotPrice}`;
      document.getElementById('tNiftyStraddle').textContent = `Straddle: ₹${symbolsMap['NIFTY'].straddlePrice}`;
    }
    if (symbolsMap['BANKNIFTY']) {
      document.getElementById('tBankSpot').textContent = `₹${symbolsMap['BANKNIFTY'].spotPrice}`;
      document.getElementById('tBankStraddle').textContent = `Straddle: ₹${symbolsMap['BANKNIFTY'].straddlePrice}`;
    }
    if (symbolsMap['FINNIFTY']) {
      document.getElementById('tFinSpot').textContent = `₹${symbolsMap['FINNIFTY'].spotPrice}`;
      document.getElementById('tFinStraddle').textContent = `Straddle: ₹${symbolsMap['FINNIFTY'].straddlePrice}`;
    }

    // 3. Filter Symbols based on Search & Category
    let symbolList = Object.values(symbolsMap);

    // Apply Search filter
    if (searchQuery) {
      symbolList = symbolList.filter(s => s.name.toUpperCase().includes(searchQuery));
    }

    // Apply Category Filter
    if (currentFilter === 'INDICES') {
      symbolList = symbolList.filter(s => ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(s.name));
    } else if (currentFilter === 'COMMODITIES') {
      symbolList = symbolList.filter(s => ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER'].includes(s.name) || s.segment === 'MCX_COMM');
    } else if (currentFilter === 'BREAKOUTS') {
      symbolList = symbolList.filter(s => s.breakout || (s.crossoverEvents && s.crossoverEvents.length > 0));
    }

    const container = document.getElementById('symbolsContainer');
    const visibleSymbols = symbolList.slice(0, 30);
    
    // Clear removed cards
    const visibleNames = new Set(visibleSymbols.map(s => s.name));
    Array.from(container.children).forEach(child => {
      const cardName = child.id.replace('card-', '');
      if (!visibleNames.has(cardName)) {
        child.remove();
        if (charts[cardName]) {
          charts[cardName].destroy();
          delete charts[cardName];
        }
      }
    });

    if (visibleSymbols.length === 0) {
      container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; color: var(--bb-text-muted); padding: 3rem; background: var(--bb-panel); border: 1px solid var(--bb-panel-border); border-radius: 4px;">No symbols match your search "${searchQuery}". Type another F&O or MCX commodity name like CRUDEOIL, GOLD, RELIANCE, TCS...</div>`;
    } else {
      visibleSymbols.forEach(sym => {
        renderSymbolCard(sym, isMarketOpen);
        // Instant on-demand sync for visible symbols needing data
        if (!sym.isLive || !sym.history || sym.history.length === 0) {
          fetch(`/api/sync-symbol?name=${encodeURIComponent(sym.name)}`).catch(() => {});
        }
      });
    }

    // 4. Update Terminal Console Logs
    const consoleBox = document.getElementById('consoleLogs');
    const logs = state.logs || [];
    consoleBox.innerHTML = logs.map(l => `<div class="console-line">${l}</div>`).join('');

    // 5. Update Alerts Table
    const alerts = state.alerts || [];
    const alertsBody = document.getElementById('alertsTableBody');
    if (alerts.length > 0) {
      alertsBody.innerHTML = alerts.map(a => `
        <tr>
          <td style="color: var(--bb-cyan);">${a.timestamp}</td>
          <td style="font-weight: 800; color: var(--bb-amber);">${a.symbol}</td>
          <td>${a.atmStrike}</td>
          <td style="color: var(--bb-green); font-weight: 800;">₹${a.straddlePrice}</td>
          <td>₹${a.prevDayHighStraddle || a.prevBarClose}</td>
          <td style="color: var(--bb-cyan); font-weight: 700;">#${a.crossNum || 1}</td>
          <td style="color: var(--bb-green); font-weight: 800;">+${a.pctMove}%</td>
          <td>₹${a.spot}</td>
          <td><span class="badge-breakout">${a.isLive ? '🟢 DHAN LIVE' : '🚀 PDH CROSS'}</span></td>
        </tr>
      `).join('');
    }

  } catch (err) {
    console.error('Fetch status error:', err);
  }
}

// Start Live Polling
setInterval(fetchStatus, 2000);
fetchStatus();
