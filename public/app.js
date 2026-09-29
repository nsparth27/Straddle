// ==========================================
// 🔒 SERVER-VERIFIED PIN AUTHENTICATION
// ==========================================
let lockoutInterval = null;

// Bloomberg Non-Blocking Toast System
function showToast(msg, type = 'success') {
  let container = document.querySelector('.bb-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'bb-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `bb-toast ${type}`;
  const icon = type === 'success' ? '⚡' : (type === 'error' ? '❌' : '⚠️');
  toast.innerHTML = `<span>${icon}</span> <span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function checkTerminalAuth() {
  const isAuth = sessionStorage.getItem('terminal_auth') === 'true';
  const modal = document.getElementById('pinLockModal');
  if (!modal) return isAuth;

  const blockUntil = parseInt(localStorage.getItem('terminal_block_until') || '0', 10);
  const now = Date.now();

  if (blockUntil > now) {
    modal.style.display = 'flex';
    triggerLockoutState(blockUntil);
    return false;
  }

  if (isAuth) {
    modal.style.display = 'none';
    return true;
  } else {
    modal.style.display = 'flex';
    resetPinInputUI();
    const pinInput = document.getElementById('pinInput');
    if (pinInput) setTimeout(() => pinInput.focus(), 150);
    return false;
  }
}

function resetPinInputUI() {
  const inputContainer = document.getElementById('pinInputContainer');
  const lockoutBox = document.getElementById('pinLockoutBox');
  const attemptsLabel = document.getElementById('pinAttemptsLabel');
  const errorEl = document.getElementById('pinError');
  const pinInput = document.getElementById('pinInput');

  if (lockoutInterval) {
    clearInterval(lockoutInterval);
    lockoutInterval = null;
  }

  if (inputContainer) inputContainer.style.display = 'flex';
  if (lockoutBox) lockoutBox.style.display = 'none';
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }
  if (pinInput) {
    pinInput.disabled = false;
    pinInput.value = '';
  }

  if (attemptsLabel) {
    attemptsLabel.textContent = `Enter your 4-digit security PIN`;
    attemptsLabel.style.color = 'var(--bb-text-muted)';
  }
}

function triggerLockoutState(blockUntil) {
  const inputContainer = document.getElementById('pinInputContainer');
  const lockoutBox = document.getElementById('pinLockoutBox');
  const timerEl = document.getElementById('lockoutTimer');
  const attemptsLabel = document.getElementById('pinAttemptsLabel');
  const errorEl = document.getElementById('pinError');

  if (inputContainer) inputContainer.style.display = 'none';
  if (errorEl) errorEl.style.display = 'none';
  if (lockoutBox) lockoutBox.style.display = 'flex';
  if (attemptsLabel) {
    attemptsLabel.textContent = '🔒 Security Lockout Active (Failed Attempts)';
    attemptsLabel.style.color = '#FF5252';
  }

  function updateTimer() {
    const remainingMs = blockUntil - Date.now();
    if (remainingMs <= 0) {
      if (lockoutInterval) clearInterval(lockoutInterval);
      lockoutInterval = null;
      localStorage.removeItem('terminal_block_until');
      resetPinInputUI();
      const pinInput = document.getElementById('pinInput');
      if (pinInput) pinInput.focus();
      return;
    }

    const totalSeconds = Math.ceil(remainingMs / 1000);
    const mins = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const secs = String(totalSeconds % 60).padStart(2, '0');
    if (timerEl) timerEl.textContent = `⏳ ${mins}:${secs}`;
  }

  updateTimer();
  if (lockoutInterval) clearInterval(lockoutInterval);
  lockoutInterval = setInterval(updateTimer, 1000);
}

async function verifyPin() {
  const blockUntil = parseInt(localStorage.getItem('terminal_block_until') || '0', 10);
  if (blockUntil > Date.now()) {
    triggerLockoutState(blockUntil);
    return;
  }

  const pinInput = document.getElementById('pinInput');
  const errorEl = document.getElementById('pinError');
  const modal = document.getElementById('pinLockModal');
  const card = modal?.querySelector('.pin-card');
  const val = (pinInput?.value || '').trim();

  if (!val) {
    if (errorEl) {
      errorEl.textContent = 'Please enter the 4-digit PIN.';
      errorEl.style.display = 'block';
    }
    return;
  }

  try {
    const res = await fetch('/api/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: val })
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      sessionStorage.setItem('terminal_auth', 'true');
      if (data.token) sessionStorage.setItem('terminal_session', data.token);
      localStorage.removeItem('terminal_block_until');
      if (modal) modal.style.display = 'none';
      if (errorEl) errorEl.style.display = 'none';
      showToast('Authentication successful. Terminal unlocked!', 'success');
      loadSettings();
      fetchStatus();
      return;
    }

    // Invalid PIN or Lockout
    if (pinInput) {
      pinInput.value = '';
      pinInput.focus();
    }
    if (card) {
      card.classList.add('shake');
      setTimeout(() => card.classList.remove('shake'), 500);
    }

    if (data.locked) {
      const lockUntil = Date.now() + (data.remainingSecs || 300) * 1000;
      localStorage.setItem('terminal_block_until', lockUntil);
      triggerLockoutState(lockUntil);
    } else {
      if (errorEl) {
        errorEl.textContent = `❌ ${data.message || 'Incorrect PIN!'}`;
        errorEl.style.display = 'block';
      }
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = `Connection error: ${err.message}`;
      errorEl.style.display = 'block';
    }
  }
}

function lockTerminal() {
  sessionStorage.removeItem('terminal_auth');
  checkTerminalAuth();
}

// Terminal Initialization & Global State
const charts = {};
let currentFilter = 'ALL'; // 'ALL', 'INDICES', 'BREAKOUTS'
let searchQuery = '';

document.addEventListener('DOMContentLoaded', () => {
  if (checkTerminalAuth()) {
    loadSettings();
    fetchStatus();
  }
});

// Global State
let lastSymbolsMap = {};

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  const tabBtnMap = {
    dashboard: 'tabBtnDashboard',
    alerts: 'tabBtnAlerts',
    settings: 'tabBtnSettings',
    radar: 'tabBtnRadar',
    charts: 'tabBtnCharts'
  };

  const targetBtn = document.getElementById(tabBtnMap[tabId]) ||
    Array.from(document.querySelectorAll('.tab-btn')).find(b => (b.getAttribute('onclick') || '').includes(tabId));
  if (targetBtn) targetBtn.classList.add('active');

  const targetContent = document.getElementById(`tab-${tabId}`);
  if (targetContent) targetContent.classList.add('active');

  if (tabId === 'radar') {
    renderRadarLeaderboard();
  } else if (tabId === 'charts') {
    renderActiveRuleTable();
  }
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
const settingsFormEl = document.getElementById('settingsForm');
if (settingsFormEl) settingsFormEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  const toast = document.getElementById('settingsToast');
  if (toast) toast.style.display = 'none';

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
      if (toast) { toast.className = 'alert-toast success'; toast.textContent = '✅ Settings saved successfully! Real-time monitor updated.'; toast.style.display = 'block'; }
    } else {
      if (toast) { toast.className = 'alert-toast error'; toast.textContent = `❌ ${data.message}`; toast.style.display = 'block'; }
    }
  } catch (err) {
    if (toast) { toast.className = 'alert-toast error'; toast.textContent = `❌ Server connection failed: ${err.message}`; toast.style.display = 'block'; }
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

// Manual On-Demand Sync for Individual Symbol Box
async function manualSyncSymbol(symName, btnEl) {
  if (!btnEl) btnEl = document.getElementById(`syncbtn-${symName}`);
  if (btnEl) {
    btnEl.classList.add('loading');
    btnEl.innerHTML = `<span class="sync-icon">🔄</span> SYNCING...`;
    btnEl.disabled = true;
  }

  try {
    const res = await fetch(`/api/sync-symbol?name=${encodeURIComponent(symName)}`);
    const data = await res.json();
    if (data.status === 'success' && data.symbol) {
      renderSymbolCard(data.symbol, true);
      if (btnEl) {
        btnEl.classList.remove('loading');
        btnEl.classList.add('synced');
        btnEl.innerHTML = `✓ SYNCED`;
        setTimeout(() => {
          btnEl.classList.remove('synced');
          btnEl.innerHTML = `<span class="sync-icon">🔄</span> SYNC`;
          btnEl.disabled = false;
        }, 1200);
      }
    } else {
      if (btnEl) {
        btnEl.classList.remove('loading');
        btnEl.innerHTML = `<span class="sync-icon">🔄</span> SYNC`;
        btnEl.disabled = false;
      }
    }
  } catch (err) {
    if (btnEl) {
      btnEl.classList.remove('loading');
      btnEl.innerHTML = `<span class="sync-icon">🔄</span> SYNC`;
      btnEl.disabled = false;
    }
  }
}

// Render/Update Live Symbol Cards & Chart.js Graphs smoothly
function renderSymbolCard(sym, isMarketOpen) {
  const container = document.getElementById('symbolsContainer');
  let card = document.getElementById(`card-${sym.name}`);

  const pdh = sym.prevDayHighStraddle || sym.prevCloseStraddle || sym.prevBarClose;
  const isBreakout = sym.breakout || (pdh && sym.straddlePrice > pdh);
  const pctMovePdh = (pdh && pdh > 0) ? (((sym.straddlePrice - pdh) / pdh) * 100).toFixed(2) : '0.00';
  const events = sym.crossoverEvents || [];
  const crossCount = events.length;
  const isLive = Boolean(sym.isLive);
  const historyData = sym.history || [];
  const isCommodity = sym.segment === 'MCX_COMM' || ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER'].includes(sym.name);
  const sessionLabel = isMarketOpen ? (isCommodity ? 'MCX STREAM' : 'LIVE STREAM') : 'SETTLED OVERVIEW';

  let sourceText = isCommodity ? `🛢️ MCX ${sessionLabel}` : `🟠 SIMULATED`;
  let sourceBg = 'rgba(255, 176, 0, 0.1)';
  let sourceColor = 'var(--bb-amber)';

  if (isLive || sym.dataSource === 'DHAN_LIVE') {
    sourceText = `🟢 DHAN ${sessionLabel}`;
    sourceBg = 'rgba(0, 230, 118, 0.15)';
    sourceColor = 'var(--bb-green)';
  } else if (sym.dataSource === 'MCX_ESTIMATED' || isCommodity) {
    sourceText = `🛢️ MCX ${sessionLabel}`;
    sourceBg = 'rgba(0, 229, 255, 0.12)';
    sourceColor = 'var(--bb-cyan)';
  } else if (sym.dataSource === 'SYNCING...') {
    sourceText = '🟠 SYNCING...';
    sourceBg = 'rgba(255, 176, 0, 0.15)';
    sourceColor = 'var(--bb-amber)';
  }

  // Calculate Peak Crossover percentage above PDH
  let maxPeakPct = 0;
  if (crossCount > 0) {
    const pcts = events.map(e => Number(e.peakPct) || (((Number(e.peakPrice) - pdh) / pdh) * 100));
    maxPeakPct = Math.max(...pcts);
    if (!isFinite(maxPeakPct) || maxPeakPct <= 0) {
      maxPeakPct = parseFloat(pctMovePdh) > 0 ? parseFloat(pctMovePdh) : 0;
    }
  }

  const crossBadgeText = crossCount > 0
    ? `🔥 ${crossCount} Cross${crossCount === 1 ? '' : 'es'} (+${maxPeakPct.toFixed(1)}% Peak)`
    : `⚪ 0 Crosses (${pctMovePdh >= 0 ? '+' : ''}${pctMovePdh}%)`;

  const chartCrossText = crossCount > 0
    ? `🔥 ${crossCount} Crossing${crossCount > 1 ? 's' : ''} (+${maxPeakPct.toFixed(1)}% Peak)`
    : `⚪ 0 Crossings (${pctMovePdh >= 0 ? '+' : ''}${pctMovePdh}%)`;

  const crossSubText = crossCount > 0
    ? `${crossCount} Cross (Peak +${maxPeakPct.toFixed(1)}%)`
    : `0 Cross (${pctMovePdh >= 0 ? '+' : ''}${pctMovePdh}%)`;

  const labels = historyData.map(h => h.time);
  const straddleValues = historyData.map(h => h.price);
  const pdhValues = labels.map(() => pdh);

  const crossClass = crossCount > 0 ? (crossCount >= 3 ? 'cross-multi' : (crossCount === 2 ? 'cross-2' : 'cross-1')) : 'cross-0';

  if (!card) {
    card = document.createElement('div');
    card.id = `card-${sym.name}`;
    card.className = 'bb-panel';
    card.innerHTML = `
      <div class="panel-header">
        <div class="panel-title" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
          <span>${sym.name} STRADDLE</span>
          <button class="btn-sync-card" id="syncbtn-${sym.name}" onclick="manualSyncSymbol('${sym.name}', this)" title="Force sync with Dhan API">
            <span class="sync-icon">🔄</span> SYNC
          </button>
          <button class="btn-preview-card" onclick="openPreviewModal('${sym.name}')" title="Open Full-View Chart & Crossover Analysis">
            <span class="preview-icon">🔍</span> PREVIEW
          </button>
          <span class="badge-breakout" id="source-${sym.name}" style="background: ${sourceBg}; color: ${sourceColor}; border-color: ${sourceColor}; font-size: 0.65rem;">
            ${sourceText}
          </span>
          <span class="badge-breakout" id="badge-${sym.name}" style="background: ${isBreakout ? 'var(--bb-green-glow)' : 'rgba(255, 176, 0, 0.1)'}; color: ${isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)'}; border-color: ${isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)'};">
            ${isBreakout ? `🚀 ABOVE PDH (+${pctMovePdh}%)` : (isMarketOpen ? '🟡 MONITORING' : '🌙 SETTLED')}
          </span>
          <span class="crossover-count-pill ${crossClass}" id="crossbadge-${sym.name}" style="cursor: pointer;" onclick="filterByCrossover(${crossCount || 1})" title="${crossCount > 0 ? `${crossCount} Crossovers above PDH today (Peak +${maxPeakPct.toFixed(1)}%)` : 'No crossovers yet'}">
            ${crossBadgeText}
          </span>
        </div>
        <span style="font-size: 0.8rem; color: var(--bb-text-muted);">ATM Strike: <b style="color: var(--bb-cyan);" id="strike-${sym.name}">${sym.atmStrike || '--'}</b></span>
      </div>

      <div class="grid-4" style="margin-bottom: 0.75rem;">
        <div class="stat-card ${isBreakout ? 'breakout' : ''}" id="statcard-${sym.name}">
          <div class="stat-label">Live Straddle</div>
          <div class="stat-val" id="price-${sym.name}" style="color: ${isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)'};">₹${sym.straddlePrice || '0.00'}</div>
          <div class="stat-sub" id="legs-${sym.name}">CE: ₹${sym.ceLtp || '--'} | PE: ₹${sym.peLtp || '--'}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Prev Day High (PDH)</div>
          <div class="stat-val" id="prevclose-${sym.name}">₹${pdh || '0.00'}</div>
          <div class="stat-sub" id="prevlegs-${sym.name}">Breakout Boundary</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Move vs PDH</div>
          <div class="stat-val" id="move-${sym.name}" style="color: ${pctMovePdh >= 0 ? 'var(--bb-green)' : 'var(--bb-red)'};">${pctMovePdh >= 0 ? '+' : ''}${pctMovePdh}%</div>
          <div class="stat-sub" id="crosscount-${sym.name}">${crossSubText}</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">Underlying Spot</div>
          <div class="stat-val" style="color: var(--bb-cyan);" id="spot-${sym.name}">₹${sym.spotPrice || '0.00'}</div>
          <div class="stat-sub">${isCommodity ? 'MCX Commodity' : 'Spot Price'}</div>
        </div>
      </div>

      <div class="chart-container" style="height: 190px;">
        <canvas id="chart-${sym.name}"></canvas>
      </div>

      <div class="chart-legend-bar">
        <div class="legend-item">
          <span class="legend-line straddle-line"></span>
          <span>Live Straddle: <b style="color: var(--bb-green);" id="chartlive-${sym.name}">₹${sym.straddlePrice}</b></span>
        </div>
        <div class="legend-item">
          <span class="legend-line pdh-line"></span>
          <span style="color: #FF6E40;">PDH Boundary: <b id="chartpdh-${sym.name}">₹${pdh}</b></span>
        </div>
        <div class="legend-item">
          <span style="color: var(--bb-cyan);" id="chartcrosstext-${sym.name}">${chartCrossText}</span>
        </div>
      </div>
    `;
    container.appendChild(card);

    // Initialize Chart.js Instance with Dual Datasets (Straddle Curve + Dashed PDH Boundary Line)
    if (typeof Chart !== 'undefined') {
      try {
        const canvas = document.getElementById(`chart-${sym.name}`);
        if (canvas) {
          const ctx = canvas.getContext('2d');
          charts[sym.name] = new Chart(ctx, {
            type: 'line',
            data: {
              labels: labels,
              datasets: [
                {
                  label: `${sym.name} Straddle Price (₹)`,
                  data: straddleValues,
                  borderColor: isLive ? '#00E676' : '#FFB000',
                  backgroundColor: isLive ? (isBreakout ? 'rgba(0, 230, 118, 0.22)' : 'rgba(0, 230, 118, 0.09)') : 'rgba(255, 176, 0, 0.08)',
                  borderWidth: 2.2,
                  fill: true,
                  tension: 0.25,
                  pointRadius: straddleValues.map(v => (pdh && v > pdh) ? 4.5 : (straddleValues.length > 25 ? 1.5 : 2.5)),
                  pointBackgroundColor: straddleValues.map(v => (pdh && v > pdh) ? '#00E676' : '#FFB000'),
                  pointBorderColor: straddleValues.map(v => (pdh && v > pdh) ? '#FFFFFF' : '#FFB000'),
                  pointHoverRadius: 6,
                  order: 1
                },
                {
                  label: `PDH Breakout Boundary (₹${pdh})`,
                  data: pdhValues,
                  borderColor: '#FF3D00',
                  borderDash: [6, 4],
                  borderWidth: 2,
                  pointRadius: 0,
                  fill: false,
                  tension: 0,
                  order: 2
                }
              ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              animation: false,
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    label: (ctx) => {
                      if (ctx.datasetIndex === 0) {
                        const isAbove = pdh && ctx.parsed.y > pdh;
                        return ` Straddle: ₹${ctx.parsed.y} ${isAbove ? '🟢 [ABOVE PDH]' : ''}`;
                      } else {
                        return ` PDH Boundary Level: ₹${pdh}`;
                      }
                    }
                  }
                }
              },
              scales: {
                x: { ticks: { color: '#64748B', font: { family: 'JetBrains Mono', size: 9 }, maxRotation: 45 }, grid: { color: '#1E2330' } },
                y: { ticks: { color: '#FFB000', font: { family: 'JetBrains Mono', size: 10 } }, grid: { color: '#1E2330' } }
              }
            }
          });
        }
      } catch (err) {
        console.warn('Chart init error for', sym.name, err);
      }
    }
  } else {
    // Smooth DOM Update
    const priceEl = document.getElementById(`price-${sym.name}`);
    if (priceEl) {
      priceEl.textContent = `₹${sym.straddlePrice}`;
      priceEl.style.color = isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)';
    }
    const prevCloseEl = document.getElementById(`prevclose-${sym.name}`);
    if (prevCloseEl) prevCloseEl.textContent = `₹${pdh}`;
    
    const chartLiveEl = document.getElementById(`chartlive-${sym.name}`);
    if (chartLiveEl) chartLiveEl.textContent = `₹${sym.straddlePrice}`;
    const chartPdhEl = document.getElementById(`chartpdh-${sym.name}`);
    if (chartPdhEl) chartPdhEl.textContent = `₹${pdh}`;
    const chartCrossEl = document.getElementById(`chartcrosstext-${sym.name}`);
    if (chartCrossEl) chartCrossEl.textContent = chartCrossText;

    const legsEl = document.getElementById(`legs-${sym.name}`);
    if (legsEl && sym.ceLtp != null && sym.peLtp != null) {
      legsEl.textContent = `CE: ₹${sym.ceLtp} | PE: ₹${sym.peLtp}`;
    }

    const moveEl = document.getElementById(`move-${sym.name}`);
    if (moveEl) {
      moveEl.textContent = `${pctMovePdh >= 0 ? '+' : ''}${pctMovePdh}%`;
      moveEl.style.color = pctMovePdh >= 0 ? 'var(--bb-green)' : 'var(--bb-red)';
    }

    const crossSub = document.getElementById(`crosscount-${sym.name}`);
    if (crossSub) {
      crossSub.textContent = crossSubText;
    }

    const crossBadge = document.getElementById(`crossbadge-${sym.name}`);
    if (crossBadge) {
      crossBadge.className = `crossover-count-pill ${crossClass}`;
      crossBadge.textContent = crossBadgeText;
      crossBadge.title = crossCount > 0 ? `${crossCount} Crossovers above PDH today (Peak +${maxPeakPct.toFixed(1)}%)` : 'No crossovers yet';
    }

    const spotEl = document.getElementById(`spot-${sym.name}`);
    if (spotEl) spotEl.textContent = `₹${sym.spotPrice}`;
    const strikeEl = document.getElementById(`strike-${sym.name}`);
    if (strikeEl) strikeEl.textContent = sym.atmStrike || '--';

    const sourceBadge = document.getElementById(`source-${sym.name}`);
    if (sourceBadge) {
      sourceBadge.textContent = sourceText;
      sourceBadge.style.background = sourceBg;
      sourceBadge.style.color = sourceColor;
      sourceBadge.style.borderColor = sourceColor;
    }

    const badge = document.getElementById(`badge-${sym.name}`);
    if (badge) {
      badge.textContent = isBreakout ? `🚀 ABOVE PDH (+${pctMovePdh}%)` : (isMarketOpen ? '🟡 MONITORING' : '🌙 SETTLED');
      badge.style.background = isBreakout ? 'var(--bb-green-glow)' : 'rgba(255, 176, 0, 0.1)';
      badge.style.color = isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)';
      badge.style.borderColor = isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)';
    }

    if (charts[sym.name] && typeof charts[sym.name].update === 'function') {
      try {
        charts[sym.name].data.labels = labels;
        charts[sym.name].data.datasets[0].data = straddleValues;
        charts[sym.name].data.datasets[0].borderColor = isLive ? '#00E676' : '#FFB000';
        charts[sym.name].data.datasets[0].backgroundColor = isLive ? (isBreakout ? 'rgba(0, 230, 118, 0.22)' : 'rgba(0, 230, 118, 0.09)') : 'rgba(255, 176, 0, 0.08)';
        charts[sym.name].data.datasets[0].pointRadius = straddleValues.map(v => (pdh && v > pdh) ? 4.5 : (straddleValues.length > 25 ? 1.5 : 2.5));
        charts[sym.name].data.datasets[0].pointBackgroundColor = straddleValues.map(v => (pdh && v > pdh) ? '#00E676' : '#FFB000');
        charts[sym.name].data.datasets[0].pointBorderColor = straddleValues.map(v => (pdh && v > pdh) ? '#FFFFFF' : '#FFB000');
        
        // Update PDH line dataset
        if (charts[sym.name].data.datasets[1]) {
          charts[sym.name].data.datasets[1].data = pdhValues;
          charts[sym.name].data.datasets[1].label = `PDH Breakout Boundary (₹${pdh})`;
        }

        charts[sym.name].options.scales.x.ticks.font.size = labels.length > 20 ? 8 : 10;
        charts[sym.name].update('none');
      } catch (err) {
        console.warn('Chart update error for', sym.name, err);
      }
    }
  }
}

// Fetch & Update Live Status from Server
async function fetchStatus() {
  if (sessionStorage.getItem('terminal_auth') !== 'true') return;
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
      if (state.sessionInfo && state.sessionInfo.label) {
        marketText.textContent = state.sessionInfo.label;
        marketDot.className = state.sessionInfo.badgeClass || (isMarketOpen ? 'dot' : 'dot closed');
      } else if (isMarketOpen) {
        marketDot.className = 'dot';
        marketText.textContent = '🟢 REGULAR F&O TRADING (09:15 AM – 03:40 PM IST — LIVE)';
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
    lastSymbolsMap = symbolsMap;
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
      });
    }

    // 4. Update Terminal Console Logs
    const consoleBox = document.getElementById('consoleLogs');
    const logs = state.logs || [];
    consoleBox.innerHTML = logs.map(l => `<div class="console-line">${l}</div>`).join('');

    // 5. Update Telegram Messages / Outbox Monitor & Metrics
    const rawMessages = state.telegramMessages || [];
    allTelegramMessages = rawMessages;
    
    // Update Metrics
    const totalMsgs = rawMessages.length;
    const deliveredMsgs = rawMessages.filter(m => m.deliveryState === 'delivered').length;
    const breakoutMsgs = rawMessages.filter(m => m.status === 'PDH BREAKOUT').length;
    const multiCrossMsgs = rawMessages.filter(m => Number(m.crossNum) > 1).length;

    const elTotal = document.getElementById('metricTotalMessages');
    if (elTotal) elTotal.textContent = totalMsgs;
    const elDeliv = document.getElementById('metricDeliveredMessages');
    if (elDeliv) elDeliv.textContent = `${deliveredMsgs} / ${totalMsgs}`;
    const elBrk = document.getElementById('metricBreakoutAlerts');
    if (elBrk) elBrk.textContent = breakoutMsgs;
    const elMulti = document.getElementById('metricMultiCrossEvents');
    if (elMulti) elMulti.textContent = multiCrossMsgs;
    const elBadge = document.getElementById('outboxBadgeCount');
    if (elBadge) elBadge.textContent = totalMsgs;

    // Render the table with filters & sort
    renderTelegramMessagesTable();

    // 6. Real-Time Breakout Radar & Alpha Leaderboard Updates
    renderRadarLeaderboard(symbolsMap);

    // 7. Real-Time Quant Strategy Charts & Barometer Suite
    renderActiveRuleTable(symbolsMap);

  } catch (err) {
    console.error('Fetch status error:', err);
  }
}

// Telegram Outbox State & Filter Variables
let allTelegramMessages = [];
let msgCrossoverFilter = 'ALL'; // 'ALL', '1', '2', '3+'
let msgSortField = 'timestamp';
let msgSortDir = 'desc';

function setCrossoverFilter(val) {
  msgCrossoverFilter = val;
  document.querySelectorAll('.filter-pill').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`crossPill${val.replace('+', '')}`);
  if (activeBtn) activeBtn.classList.add('active');
  
  const badge = document.getElementById('activeFilterBadge');
  if (badge) {
    if (val === 'ALL') badge.textContent = 'Showing All Crossovers';
    else if (val === '1') badge.textContent = 'Filtered by Cross #1 (1st Breakout)';
    else if (val === '2') badge.textContent = 'Filtered by Cross #2 (2nd Breakout)';
    else if (val === '3+') badge.textContent = 'Filtered by Cross #3+ (Multi-Cross)';
  }
  renderTelegramMessagesTable();
}

function filterByCrossover(crossNum) {
  switchTab('alerts');
  const crossStr = Number(crossNum) >= 3 ? '3+' : String(crossNum);
  setCrossoverFilter(crossStr);
}

function filterBySymbol(symName) {
  switchTab('alerts');
  const searchInput = document.getElementById('msgSearchInput');
  if (searchInput) {
    searchInput.value = symName;
  }
  renderTelegramMessagesTable();
}

function applyMessageFilters() {
  renderTelegramMessagesTable();
}

function sortMessages(field) {
  if (msgSortField === field) {
    msgSortDir = msgSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    msgSortField = field;
    msgSortDir = 'desc';
  }

  // Update header sort icons
  ['timestamp', 'symbol', 'atmStrike', 'straddlePrice', 'prevDayHighStraddle', 'crossNum', 'pctMove', 'spot', 'status'].forEach(f => {
    const el = document.getElementById(`sort-${f}`);
    if (el) {
      if (f === msgSortField) {
        el.textContent = msgSortDir === 'asc' ? '▲' : '▼';
        el.style.color = 'var(--bb-amber)';
      } else {
        el.textContent = '';
      }
    }
  });

  renderTelegramMessagesTable();
}

function renderTelegramMessagesTable() {
  const tbody = document.getElementById('messagesTableBody');
  if (!tbody) return;

  const searchVal = (document.getElementById('msgSearchInput')?.value || '').toUpperCase().trim();
  const deliveryVal = document.getElementById('msgDeliveryFilter')?.value || 'ALL';
  const typeVal = document.getElementById('msgTypeFilter')?.value || 'ALL';

  let filtered = [...allTelegramMessages];

  // 1. Symbol Search Filter
  if (searchVal) {
    filtered = filtered.filter(m => String(m.symbol).toUpperCase().includes(searchVal));
  }

  // 2. Delivery Status Filter
  if (deliveryVal !== 'ALL') {
    filtered = filtered.filter(m => m.deliveryState === deliveryVal);
  }

  // 3. Message Type Filter
  if (typeVal !== 'ALL') {
    filtered = filtered.filter(m => m.status === typeVal);
  }

  // 4. Crossover Filter
  if (msgCrossoverFilter === '1') {
    filtered = filtered.filter(m => Number(m.crossNum) === 1);
  } else if (msgCrossoverFilter === '2') {
    filtered = filtered.filter(m => Number(m.crossNum) === 2);
  } else if (msgCrossoverFilter === '3+') {
    filtered = filtered.filter(m => Number(m.crossNum) >= 3);
  }

  // 5. Sorting
  filtered.sort((a, b) => {
    let valA = a[msgSortField];
    let valB = b[msgSortField];

    if (msgSortField === 'crossNum') {
      valA = Number(valA) || 0;
      valB = Number(valB) || 0;
    } else if (msgSortField === 'pctMove') {
      valA = parseFloat(String(valA).replace(/[^0-9.-]/g, '')) || 0;
      valB = parseFloat(String(valB).replace(/[^0-9.-]/g, '')) || 0;
    } else if (msgSortField === 'straddlePrice' || msgSortField === 'prevDayHighStraddle' || msgSortField === 'spot' || msgSortField === 'atmStrike') {
      valA = parseFloat(String(valA).replace(/[^0-9.-]/g, '')) || 0;
      valB = parseFloat(String(valB).replace(/[^0-9.-]/g, '')) || 0;
    } else if (msgSortField === 'timestamp') {
      valA = a.rawTimestamp || 0;
      valB = b.rawTimestamp || 0;
    }

    if (valA < valB) return msgSortDir === 'asc' ? -1 : 1;
    if (valA > valB) return msgSortDir === 'asc' ? 1 : -1;
    return 0;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" style="text-align: center; color: var(--bb-text-muted); padding: 2.5rem;">
          No messages match active filters (Search: "${searchVal || 'None'}", Cross: "${msgCrossoverFilter}", Delivery: "${deliveryVal}").
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(m => {
    const isDelivered = m.deliveryState === 'delivered';
    const isSending = m.deliveryState === 'sending';
    const crossNum = Number(m.crossNum) || 1;
    const crossClass = crossNum === 1 ? 'crossover-1' : (crossNum === 2 ? 'crossover-2' : 'crossover-3');

    let tickBadgeHtml = '';
    if (isDelivered) {
      tickBadgeHtml = `<span class="tick-badge tick-delivered" title="Delivered to Telegram User (Chat ID: ${m.chatId})"><span class="tick-double-icon">✓✓</span> DELIVERED</span>`;
    } else if (isSending) {
      tickBadgeHtml = `<span class="tick-badge tick-sending" title="Sending to Telegram"><span style="font-weight:900">✓</span> SENDING...</span>`;
    } else {
      tickBadgeHtml = `<span class="tick-badge tick-failed" title="${m.error || 'Delivery Error'}">❌ FAILED</span>`;
    }

    return `
      <tr>
        <td>${tickBadgeHtml}</td>
        <td style="color: var(--bb-cyan); font-weight: 700; font-size: 0.82rem;">${m.timestamp}</td>
        <td style="font-weight: 800; color: var(--bb-amber); cursor: pointer;" onclick="filterBySymbol('${m.symbol}')" title="Click to filter by ${m.symbol}">
          ${m.symbol}
        </td>
        <td style="font-weight: 600;">${m.atmStrike}</td>
        <td style="color: var(--bb-green); font-weight: 800;">${m.straddlePrice}</td>
        <td style="color: var(--bb-text-main);">${m.prevDayHighStraddle}</td>
        <td>
          <span class="crossover-badge ${crossClass}" onclick="filterByCrossover(${crossNum})" title="Click to filter by Crossover #${crossNum}">
            #${crossNum} Cross ⚡
          </span>
        </td>
        <td style="color: var(--bb-green); font-weight: 800;">${m.pctMove}</td>
        <td style="color: var(--bb-cyan);">${m.spot}</td>
        <td><span class="badge-breakout" style="font-size: 0.7rem;">${m.status}</span></td>
        <td style="text-align: center;">
          <button class="btn btn-secondary" onclick="openMessageModal('${m.id}')" style="font-size: 0.72rem; padding: 0.25rem 0.55rem; color: var(--bb-cyan); border-color: var(--bb-cyan);">
            👁️ Preview
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// Modal Controllers
function openMessageModal(msgId) {
  const msg = allTelegramMessages.find(m => m.id === msgId);
  if (!msg) return;

  const modal = document.getElementById('telegramMsgModal');
  const title = document.getElementById('msgModalTitle');
  const badge = document.getElementById('msgModalDeliveryBadge');
  const chatId = document.getElementById('msgModalChatId');
  const bubble = document.getElementById('msgModalBubbleText');

  const sym = document.getElementById('msgModalSym');
  const strike = document.getElementById('msgModalStrike');
  const straddle = document.getElementById('msgModalStraddle');
  const pdh = document.getElementById('msgModalPdh');
  const cross = document.getElementById('msgModalCross');
  const move = document.getElementById('msgModalMove');

  if (title) title.textContent = `${msg.symbol} DISPATCH — ${msg.status}`;
  if (chatId) chatId.textContent = `Chat ID: ${msg.chatId}`;
  
  if (badge) {
    if (msg.deliveryState === 'delivered') {
      badge.className = 'tick-badge tick-delivered';
      badge.innerHTML = `<span class="tick-double-icon">✓✓</span> DELIVERED TO USER (${msg.deliveredAt || msg.timestamp})`;
    } else if (msg.deliveryState === 'sending') {
      badge.className = 'tick-badge tick-sending';
      badge.innerHTML = `<span style="font-weight:900">✓</span> SENDING / QUEUED`;
    } else {
      badge.className = 'tick-badge tick-failed';
      badge.innerHTML = `❌ DELIVERY FAILED: ${msg.error || 'Check Bot Token'}`;
    }
  }

  if (bubble) bubble.innerHTML = msg.text || 'No message content';
  if (sym) sym.textContent = msg.symbol;
  if (strike) strike.textContent = msg.atmStrike;
  if (straddle) straddle.textContent = msg.straddlePrice;
  if (pdh) pdh.textContent = msg.prevDayHighStraddle;
  if (cross) cross.textContent = `#${msg.crossNum || 1}`;
  if (move) move.textContent = msg.pctMove;

  if (modal) modal.classList.add('active');
}

function closeMsgModal() {
  const modal = document.getElementById('telegramMsgModal');
  if (modal) modal.classList.remove('active');
}

function openTestModal() {
  const modal = document.getElementById('testBreakoutModal');
  if (modal) modal.classList.add('active');
}

function closeTestModal() {
  const modal = document.getElementById('testBreakoutModal');
  if (modal) modal.classList.remove('active');
}

async function handleSendTestBreakout(e) {
  e.preventDefault();
  const sym = document.getElementById('testSymbol')?.value || 'RELIANCE';
  const crossNum = Number(document.getElementById('testCrossNum')?.value || 1);
  const straddlePrice = parseFloat(document.getElementById('testStraddlePrice')?.value || 64.50);
  const pdh = parseFloat(document.getElementById('testPdh')?.value || 59.00);

  closeTestModal();

  try {
    const res = await fetch('/api/send-test-breakout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: sym,
        crossNum: crossNum,
        straddlePrice: straddlePrice,
        prevDayHighStraddle: pdh
      })
    });
    const data = await res.json();
    if (data.status === 'success') {
      alert(`✅ Test alert sent for ${sym} (Cross #${crossNum})`);
      fetchStatus();
    } else {
      alert('⚠️ Alert response: ' + (data.message || 'Error'));
    }
  } catch (err) {
    alert('❌ Failed to send test alert: ' + err.message);
  }
}

// =========================================================================
// 🔍 FULL-VIEW CHART PREVIEW MODAL LOGIC
// =========================================================================
let modalChart = null;
let activeModalSymbol = null;

async function openPreviewModal(symbolName) {
  activeModalSymbol = symbolName;
  const modal = document.getElementById('previewChartModal');
  if (!modal) return;

  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();
    const sym = (data.state?.symbols || {})[symbolName];
    if (!sym) return;

    renderModalContent(sym, Boolean(data.state?.isMarketOpen));
    modal.classList.add('active');
  } catch (err) {
    console.error('Error opening preview modal:', err);
  }
}

function renderModalContent(sym, isMarketOpen) {
  const pdh = sym.prevDayHighStraddle || sym.prevCloseStraddle || sym.prevBarClose || 0;
  const isBreakout = sym.breakout || (pdh && sym.straddlePrice > pdh);
  const pctMovePdh = pdh > 0 ? (((sym.straddlePrice - pdh) / pdh) * 100).toFixed(2) : '0.00';
  const events = sym.crossoverEvents || [];
  const crossCount = events.length;
  const isLive = Boolean(sym.isLive);
  const historyData = sym.history || [];
  const isCommodity = sym.segment === 'MCX_COMM' || ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER'].includes(sym.name);
  const sessionLabel = isMarketOpen ? (isCommodity ? 'MCX STREAM' : 'LIVE STREAM') : 'SETTLED OVERVIEW';

  // Calculate Max Peak % gain
  let maxPeakPct = 0;
  let maxPeakPrice = sym.straddlePrice || 0;
  if (crossCount > 0) {
    const pcts = events.map(e => Number(e.peakPct) || (((Number(e.peakPrice) - pdh) / pdh) * 100));
    maxPeakPct = Math.max(...pcts);
    const peaks = events.map(e => Number(e.peakPrice) || 0);
    maxPeakPrice = Math.max(...peaks);
  }
  if (!isFinite(maxPeakPct) || maxPeakPct <= 0) {
    maxPeakPct = parseFloat(pctMovePdh) > 0 ? parseFloat(pctMovePdh) : 0;
  }

  // 1. Header Information
  document.getElementById('modalSymbolTitle').textContent = `${sym.name} STRADDLE OVERVIEW`;
  
  const srcBadge = document.getElementById('modalSourceBadge');
  if (srcBadge) {
    srcBadge.textContent = isLive ? `🟢 DHAN ${sessionLabel}` : (isCommodity ? `🛢️ MCX ${sessionLabel}` : '🟠 SIMULATED');
    srcBadge.style.color = isLive ? 'var(--bb-green)' : (isCommodity ? 'var(--bb-cyan)' : 'var(--bb-amber)');
    srcBadge.style.borderColor = isLive ? 'var(--bb-green)' : (isCommodity ? 'var(--bb-cyan)' : 'var(--bb-amber)');
  }

  const crossBadge = document.getElementById('modalCrossBadge');
  if (crossBadge) {
    const crossClass = crossCount > 0 ? (crossCount >= 3 ? 'cross-multi' : (crossCount === 2 ? 'cross-2' : 'cross-1')) : 'cross-0';
    crossBadge.className = `crossover-count-pill ${crossClass}`;
    crossBadge.textContent = crossCount > 0
      ? `🔥 ${crossCount} Cross${crossCount === 1 ? '' : 'es'} (+${maxPeakPct.toFixed(1)}% Peak)`
      : `⚪ 0 Crosses (${pctMovePdh >= 0 ? '+' : ''}${pctMovePdh}%)`;
  }

  // 2. Metric Strip
  document.getElementById('modalValStraddle').textContent = `₹${sym.straddlePrice || '0.00'}`;
  document.getElementById('modalValStraddle').style.color = isBreakout ? 'var(--bb-green)' : 'var(--bb-amber)';
  document.getElementById('modalValLegs').textContent = `CE: ₹${sym.ceLtp ?? '--'} | PE: ₹${sym.peLtp ?? '--'}`;
  document.getElementById('modalValPdh').textContent = `₹${pdh}`;
  document.getElementById('modalValPeakPct').textContent = `${maxPeakPct >= 0 ? '+' : ''}${maxPeakPct.toFixed(2)}%`;
  document.getElementById('modalValPeakPct').style.color = maxPeakPct > 0 ? 'var(--bb-green)' : 'var(--bb-text-muted)';
  document.getElementById('modalValPeakPrice').textContent = `Day Peak: ₹${maxPeakPrice}`;
  document.getElementById('modalValSpot').textContent = `₹${sym.spotPrice || '0.00'}`;
  document.getElementById('modalValAtm').textContent = `ATM Strike: ${sym.atmStrike || '--'} (${isCommodity ? 'MCX Commodity' : 'Equity / Index'})`;

  // 3. Chronological Crossover Table
  const tableBody = document.getElementById('modalCrossoverTableBody');
  const countLabel = document.getElementById('modalCrossoverEventCount');
  if (countLabel) countLabel.textContent = `${crossCount} Breakout Event${crossCount === 1 ? '' : 's'} Tracked Today`;

  if (tableBody) {
    if (events.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; color: var(--bb-text-muted); padding: 1.5rem;">
            ⚪ No Previous Day High (PDH) crossovers detected today for ${sym.name}. Straddle is operating within normal theta decay range (Live: ₹${sym.straddlePrice} vs PDH: ₹${pdh}).
          </td>
        </tr>
      `;
    } else {
      tableBody.innerHTML = events.map(evt => {
        const peakGain = pdh > 0 ? (((evt.peakPrice - pdh) / pdh) * 100).toFixed(2) : '0.00';
        return `
          <tr>
            <td>
              <span class="crossover-count-pill cross-1" style="font-size: 0.72rem;">
                Cross #${evt.crossNum}
              </span>
            </td>
            <td style="font-weight: 700; color: #FFF;">${evt.startTime || '--'}</td>
            <td style="color: var(--bb-amber);">₹${evt.startPrice || '--'}</td>
            <td>₹${pdh}</td>
            <td style="color: var(--bb-green); font-weight: 800;">₹${evt.peakPrice || '--'}</td>
            <td style="color: var(--bb-green); font-weight: 800;">+${peakGain}%</td>
            <td style="color: var(--bb-text-muted);">${evt.dipTime || (evt.active ? '🟢 Still Active (Above PDH)' : 'Settled')}</td>
            <td>
              <span class="badge-breakout" style="${evt.active ? 'background: var(--bb-green-glow); color: var(--bb-green); border-color: var(--bb-green);' : 'background: rgba(100,116,139,0.15); color: #94A3B8; border-color: #334155;'}">
                ${evt.active ? '🟢 ACTIVE ABOVE PDH' : '⚪ RETRACED'}
              </span>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // 4. Render Large High-Resolution Chart.js
  const canvas = document.getElementById('modalChartCanvas');
  if (!canvas) return;

  const labels = historyData.map(h => h.time);
  const straddleValues = historyData.map(h => h.price);
  const pdhValues = labels.map(() => pdh);

  if (modalChart) {
    modalChart.destroy();
  }

  const ctx = canvas.getContext('2d');
  modalChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: `${sym.name} Straddle Price (₹)`,
          data: straddleValues,
          borderColor: isLive ? '#00E676' : '#FFB000',
          backgroundColor: isLive ? 'rgba(0, 230, 118, 0.15)' : 'rgba(255, 176, 0, 0.08)',
          borderWidth: 2.5,
          fill: true,
          tension: 0.2,
          pointRadius: straddleValues.map(v => (pdh && v > pdh) ? 6 : (straddleValues.length > 25 ? 2.5 : 3.5)),
          pointBackgroundColor: straddleValues.map(v => (pdh && v > pdh) ? '#00E676' : '#FFB000'),
          pointBorderColor: straddleValues.map(v => (pdh && v > pdh) ? '#FFFFFF' : '#FFB000'),
          pointHoverRadius: 8,
          order: 1
        },
        {
          label: `PDH Breakout Boundary (₹${pdh})`,
          data: pdhValues,
          borderColor: '#FF3D00',
          borderDash: [8, 5],
          borderWidth: 2.2,
          pointRadius: 0,
          fill: false,
          tension: 0,
          order: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0E1117',
          borderColor: '#1E2330',
          borderWidth: 1,
          titleFont: { family: 'JetBrains Mono', size: 12 },
          bodyFont: { family: 'JetBrains Mono', size: 12 },
          callbacks: {
            label: (ctx) => {
              if (ctx.datasetIndex === 0) {
                const val = ctx.parsed.y;
                const isOver = pdh && val > pdh;
                const pct = pdh > 0 ? (((val - pdh) / pdh) * 100).toFixed(2) : 0;
                return ` Straddle: ₹${val} ${isOver ? `🟢 [ABOVE PDH +${pct}%]` : `⚪ [BELOW PDH ${pct}%]`}`;
              } else {
                return ` PDH Boundary Level: ₹${pdh}`;
              }
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#94A3B8', font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 45 },
          grid: { color: 'rgba(255, 255, 255, 0.05)' }
        },
        y: {
          ticks: { color: '#FFB000', font: { family: 'JetBrains Mono', size: 11 } },
          grid: { color: 'rgba(255, 255, 255, 0.05)' }
        }
      }
    }
  });
}

async function manualSyncModalSymbol(btnEl) {
  if (!activeModalSymbol) return;
  if (btnEl) {
    btnEl.classList.add('loading');
    btnEl.innerHTML = `<span class="sync-icon">🔄</span> SYNCING...`;
    btnEl.disabled = true;
  }
  try {
    const res = await fetch(`/api/sync-symbol?name=${encodeURIComponent(activeModalSymbol)}`);
    const data = await res.json();
    if (data.status === 'success' && data.symbol) {
      renderModalContent(data.symbol, true);
      if (btnEl) {
        btnEl.classList.remove('loading');
        btnEl.classList.add('synced');
        btnEl.innerHTML = `✓ SYNCED`;
        setTimeout(() => {
          btnEl.classList.remove('synced');
          btnEl.innerHTML = `<span class="sync-icon">🔄</span> SYNC`;
          btnEl.disabled = false;
        }, 1200);
      }
    }
  } catch (err) {
    if (btnEl) {
      btnEl.classList.remove('loading');
      btnEl.innerHTML = `<span class="sync-icon">🔄</span> SYNC`;
      btnEl.disabled = false;
    }
  }
}

async function sendStockReportFromModal(btnEl) {
  if (!activeModalSymbol) return;
  const originalHtml = btnEl ? btnEl.innerHTML : '';
  const statusMsgEl = document.getElementById('modalReportStatusMsg');

  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = `<span>⏳</span> DISPATCHING...`;
  }
  if (statusMsgEl) {
    statusMsgEl.style.display = 'inline-block';
    statusMsgEl.style.color = 'var(--bb-amber)';
    statusMsgEl.textContent = `⏳ Sending ${activeModalSymbol} report to Telegram...`;
  }

  try {
    const res = await fetch('/api/send-symbol-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: activeModalSymbol })
    });
    const data = await res.json();
    if (data.status === 'success') {
      if (btnEl) {
        btnEl.innerHTML = `<span>✓✓</span> SENT!`;
        btnEl.style.background = 'var(--bb-green)';
      }
      if (statusMsgEl) {
        statusMsgEl.style.color = 'var(--bb-green)';
        statusMsgEl.textContent = `✓ Report for ${activeModalSymbol} dispatched to Telegram!`;
      }
      setTimeout(() => {
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.innerHTML = originalHtml;
          btnEl.style.background = '';
        }
        if (statusMsgEl) {
          setTimeout(() => { statusMsgEl.style.display = 'none'; }, 2500);
        }
      }, 2500);
    } else {
      throw new Error(data.error || 'Failed to dispatch');
    }
  } catch (err) {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = `<span>❌</span> FAILED`;
      setTimeout(() => { btnEl.innerHTML = originalHtml; }, 2000);
    }
    if (statusMsgEl) {
      statusMsgEl.style.color = 'var(--bb-red)';
      statusMsgEl.textContent = `❌ Error: ${err.message}`;
    }
  }
}

function closePreviewModal() {
  const modal = document.getElementById('previewChartModal');
  if (modal) modal.classList.remove('active');
  if (modalChart) {
    modalChart.destroy();
    modalChart = null;
  }
  activeModalSymbol = null;
}

// =========================================================================
// 🚀 TAB 4: BREAKOUT RADAR & ALPHA LEADERBOARD ENGINE
// =========================================================================
let currentRadarSortMode = 'MULTI_CROSS'; // 'MULTI_CROSS', 'HIGHEST_GROWTH', 'ACTIVE_NOW', 'INDICES', 'COMMODITIES'
let radarSearchQuery = '';

function setRadarSortMode(mode) {
  currentRadarSortMode = mode;
  document.querySelectorAll('#tab-radar .filter-pill').forEach(btn => btn.classList.remove('active'));
  
  if (mode === 'MULTI_CROSS') document.getElementById('radarPillMultiCross')?.classList.add('active');
  if (mode === 'HIGHEST_GROWTH') document.getElementById('radarPillHighestGrowth')?.classList.add('active');
  if (mode === 'ACTIVE_NOW') document.getElementById('radarPillActiveNow')?.classList.add('active');
  if (mode === 'INDICES') document.getElementById('radarPillIndices')?.classList.add('active');
  if (mode === 'COMMODITIES') document.getElementById('radarPillCommodities')?.classList.add('active');

  renderRadarLeaderboard();
}

function filterRadarSymbols() {
  radarSearchQuery = (document.getElementById('radarSearchInput')?.value || '').trim().toUpperCase();
  renderRadarLeaderboard();
}

function renderRadarLeaderboard(providedSymbolsMap = null) {
  const container = document.getElementById('radarContainer');
  if (!container) return;

  const rawMap = providedSymbolsMap || lastSymbolsMap || {};
  lastSymbolsMap = rawMap;

  let symbols = Object.values(rawMap);
  if (symbols.length === 0) return;

  // Compute calculated values for each symbol
  const enriched = symbols.map(s => {
    const pdh = s.prevDayHighStraddle || s.prevCloseStraddle || s.prevBarClose || 0;
    const events = s.crossoverEvents || [];
    const crossCount = events.length;
    const isAbove = (s.straddlePrice > pdh && pdh > 0) || Boolean(s.breakout);
    const pctMovePdh = pdh > 0 ? parseFloat((((s.straddlePrice - pdh) / pdh) * 100).toFixed(2)) : 0;
    
    let maxPeakPct = 0;
    let maxPeakPrice = s.straddlePrice || 0;
    if (crossCount > 0) {
      const pcts = events.map(e => Number(e.peakPct) || (((Number(e.peakPrice) - pdh) / pdh) * 100));
      maxPeakPct = Math.max(...pcts);
      const peaks = events.map(e => Number(e.peakPrice) || 0);
      maxPeakPrice = Math.max(...peaks);
    }
    if (!isFinite(maxPeakPct) || maxPeakPct <= 0) {
      maxPeakPct = pctMovePdh > 0 ? pctMovePdh : 0;
    }

    return {
      ...s,
      pdh,
      crossCount,
      isAbove,
      pctMovePdh,
      maxPeakPct,
      maxPeakPrice,
      isCommodity: s.segment === 'MCX_COMM' || ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER'].includes(s.name),
      isIndex: s.segment === 'IDX_I' || ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(s.name)
    };
  });

  // 1. Update Header Summary Cards
  const totalCount = enriched.length;
  const activeCount = enriched.filter(e => e.isAbove).length;
  const multiCount = enriched.filter(e => e.crossCount >= 2).length;
  
  const sortedByPeak = [...enriched].sort((a, b) => b.maxPeakPct - a.maxPeakPct);
  const topGainer = sortedByPeak[0];

  const elTot = document.getElementById('radarStatTotal');
  if (elTot) elTot.textContent = totalCount;
  const elAct = document.getElementById('radarStatActive');
  if (elAct) elAct.textContent = activeCount;
  const elMul = document.getElementById('radarStatMulti');
  if (elMul) elMul.textContent = multiCount;
  
  const elTop = document.getElementById('radarStatTopGainer');
  const elTopSub = document.getElementById('radarStatTopGainerSub');
  if (elTop && topGainer) {
    elTop.textContent = topGainer.maxPeakPct > 0 ? `${topGainer.name} (+${topGainer.maxPeakPct.toFixed(1)}%)` : 'None Yet';
    if (elTopSub) elTopSub.textContent = topGainer.maxPeakPct > 0 ? `Live: ₹${topGainer.straddlePrice} | PDH: ₹${topGainer.pdh}` : 'Monitoring market breakouts';
  }

  const badgeCount = document.getElementById('radarBadgeCount');
  if (badgeCount) badgeCount.textContent = activeCount > 0 ? activeCount : multiCount;

  // 2. Filter list based on selected category & search
  let filtered = enriched;
  if (radarSearchQuery) {
    filtered = filtered.filter(s => s.name.includes(radarSearchQuery));
  }

  if (currentRadarSortMode === 'INDICES') {
    filtered = filtered.filter(s => s.isIndex);
  } else if (currentRadarSortMode === 'COMMODITIES') {
    filtered = filtered.filter(s => s.isCommodity);
  } else if (currentRadarSortMode === 'ACTIVE_NOW') {
    filtered = filtered.filter(s => s.isAbove);
  }

  // 3. AUTO-SORTING ENGINE
  if (currentRadarSortMode === 'MULTI_CROSS' || currentRadarSortMode === 'INDICES' || currentRadarSortMode === 'COMMODITIES') {
    // Multi-Crossover Champions first!
    filtered.sort((a, b) => {
      if (b.crossCount !== a.crossCount) return b.crossCount - a.crossCount;
      if (b.isAbove !== a.isAbove) return (b.isAbove ? 1 : 0) - (a.isAbove ? 1 : 0);
      return b.maxPeakPct - a.maxPeakPct;
    });
  } else if (currentRadarSortMode === 'HIGHEST_GROWTH' || currentRadarSortMode === 'ACTIVE_NOW') {
    // Highest Growth % after crossing boundary first!
    filtered.sort((a, b) => {
      if (b.maxPeakPct !== a.maxPeakPct) return b.maxPeakPct - a.maxPeakPct;
      return b.pctMovePdh - a.pctMovePdh;
    });
  }

  const displayList = filtered.slice(0, 30);

  if (displayList.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; color: var(--bb-text-muted); padding: 3rem; background: var(--bb-panel); border: 1px solid var(--bb-panel-border); border-radius: 4px;">
        No assets match your search/filter criteria.
      </div>
    `;
    return;
  }

  // Render Leaderboard Cards
  container.innerHTML = displayList.map((s, index) => {
    const rank = index + 1;
    const podiumClass = rank === 1 ? 'podium-1' : (rank === 2 ? 'podium-2' : (rank === 3 ? 'podium-3' : ''));
    const badgePodiumClass = rank === 1 ? 'podium-1' : (rank === 2 ? 'podium-2' : (rank === 3 ? 'podium-3' : 'podium-other'));
    const rankIcon = rank === 1 ? '🥇' : (rank === 2 ? '🥈' : (rank === 3 ? '🥉' : `#${rank}`));
    
    const segmentLabel = s.isCommodity ? 'MCX' : (s.isIndex ? 'INDEX' : 'NSE F&O');
    const segmentColor = s.isCommodity ? 'var(--bb-cyan)' : (s.isIndex ? '#D8B4FE' : 'var(--bb-amber)');

    const crossClass = s.crossCount > 0 ? (s.crossCount >= 3 ? 'cross-multi' : (s.crossCount === 2 ? 'cross-2' : 'cross-1')) : 'cross-0';

    // Progress percentage (bounded between 0% and 100% for progress visual)
    const progressWidth = Math.min(100, Math.max(8, s.maxPeakPct > 0 ? (s.maxPeakPct * 3) : 10));

    return `
      <div class="radar-card ${podiumClass}" id="radar-card-${s.name}">
        <div class="panel-header" style="border-bottom: 1px solid rgba(255, 255, 255, 0.08); padding-bottom: 0.75rem; margin-bottom: 0.85rem;">
          
          <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
            <span class="rank-badge ${badgePodiumClass}">
              ${rankIcon} RANK ${rank}
            </span>
            <div class="symbol-avatar">
              <span>${s.name}</span>
              <span class="segment-tag" style="color: ${segmentColor}; border-color: ${segmentColor};">${segmentLabel}</span>
            </div>
            <span class="badge-breakout" style="background: ${s.isAbove ? 'var(--bb-green-glow)' : 'rgba(255, 176, 0, 0.1)'}; color: ${s.isAbove ? 'var(--bb-green)' : 'var(--bb-amber)'}; border-color: ${s.isAbove ? 'var(--bb-green)' : 'var(--bb-amber)'}; font-size: 0.68rem;">
              ${s.isAbove ? `🚀 ABOVE PDH (+${s.pctMovePdh}%)` : (s.crossCount > 0 ? '⚪ RETRACED' : '🌙 NORMAL')}
            </span>
          </div>

          <div style="display: flex; align-items: center; gap: 0.4rem;">
            <button class="btn-preview-card" onclick="openPreviewModal('${s.name}')" title="Full-View Chart Preview & Event History">
              <span class="preview-icon">🔍</span> PREVIEW
            </button>
            <button class="btn-sync-card" onclick="manualSyncSymbol('${s.name}', this)" title="Force sync Dhan data">
              <span class="sync-icon">🔄</span> SYNC
            </button>
          </div>

        </div>

        <!-- Metric Grid -->
        <div class="grid-4" style="margin-bottom: 0.75rem;">
          <div class="stat-card ${s.isAbove ? 'breakout' : ''}">
            <div class="stat-label">Live Straddle</div>
            <div class="stat-val" style="color: ${s.isAbove ? 'var(--bb-green)' : 'var(--bb-amber)'}; font-size: 1.3rem;">₹${s.straddlePrice}</div>
            <div class="stat-sub">CE: ₹${s.ceLtp ?? '--'} | PE: ₹${s.peLtp ?? '--'}</div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Prev Day High (PDH)</div>
            <div class="stat-val" style="font-size: 1.3rem;">₹${s.pdh}</div>
            <div class="stat-sub">Breakout Level</div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Total Crossovers</div>
            <div class="stat-val" style="font-size: 1.3rem;">
              <span class="crossover-count-pill ${crossClass}">
                🔥 ${s.crossCount} Hit${s.crossCount === 1 ? '' : 's'}
              </span>
            </div>
            <div class="stat-sub">${s.crossCount >= 2 ? 'Multi-Cross Leader' : (s.crossCount === 1 ? 'Initial Breakout' : 'No Crosses Yet')}</div>
          </div>

          <div class="stat-card">
            <div class="stat-label">Max Peak Gain %</div>
            <div class="stat-val" style="color: ${s.maxPeakPct > 0 ? 'var(--bb-green)' : 'var(--bb-text-muted)'}; font-size: 1.3rem;">
              ${s.maxPeakPct > 0 ? `+${s.maxPeakPct.toFixed(1)}%` : '0.00%'}
            </div>
            <div class="stat-sub">Day Peak: ₹${s.maxPeakPrice}</div>
          </div>
        </div>

        <!-- Growth Progress Meter -->
        <div class="growth-progress-container">
          <div class="growth-progress-labels">
            <span>PDH Boundary: <b>₹${s.pdh}</b></span>
            <span style="color: ${s.maxPeakPct > 0 ? 'var(--bb-green)' : 'var(--bb-text-muted)'}; font-weight: 700;">
              ${s.maxPeakPct > 0 ? `🚀 Peak Gain: +${s.maxPeakPct.toFixed(1)}% above PDH` : 'Operating below breakout level'}
            </span>
          </div>
          <div class="growth-progress-track">
            <div class="growth-progress-fill ${s.maxPeakPct > 0 ? 'positive' : 'negative'}" style="width: ${progressWidth}%;"></div>
          </div>
        </div>

      </div>
    `;
  }).join('');
}

// Global Keyboard Shortcuts (Escape to close modals, F1-F5 to switch workspace tabs)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePreviewModal();
    closeMsgModal();
    closeTestModal();
    closeCrossoverSummaryModal();
  } else if (e.key === 'F1') {
    e.preventDefault();
    switchTab('dashboard');
  } else if (e.key === 'F2') {
    e.preventDefault();
    switchTab('alerts');
  } else if (e.key === 'F3') {
    e.preventDefault();
    switchTab('settings');
  } else if (e.key === 'F4') {
    e.preventDefault();
    switchTab('radar');
  } else if (e.key === 'F5') {
    e.preventDefault();
    switchTab('charts');
  }
});

// =========================================================================
// 📊 TAB 5: QUANT STRATEGY CHARTS & MULTI-RULE ENGINE
// =========================================================================
let activeRuleChart = 'RULE_DIVERGING';
let activeQuantFilter = 'ALL';
let quantSearchQuery = '';
let quantBloombergChartInstance = null;

function setRuleChart(ruleName) {
  activeRuleChart = ruleName;
  document.querySelectorAll('#tab-charts .rule-tab-btn').forEach(btn => btn.classList.remove('active'));
  const btnMap = {
    'RULE_DIVERGING': 'btnRuleDiverging',
    'RULE_MULTI_CROSS': 'btnRuleMulti',
    'RULE_SKEW': 'btnRuleSkew',
    'RULE_STALKING': 'btnRuleStalking',
    'RULE_BLOOMBERG': 'btnRuleBloomberg',
    'RULE_BARBELL': 'btnRuleBarbell'
  };
  if (btnMap[ruleName]) document.getElementById(btnMap[ruleName])?.classList.add('active');

  const tableWrap = document.getElementById('quantTableHeaderWrap');
  const rowsWrap = document.getElementById('quantRowsContainer');
  const canvasWrap = document.getElementById('quantChartJsWrap');

  if (ruleName === 'RULE_BLOOMBERG') {
    if (tableWrap) tableWrap.style.display = 'none';
    if (rowsWrap) rowsWrap.style.display = 'none';
    if (canvasWrap) canvasWrap.style.display = 'block';
    renderQuantBloombergCanvas();
  } else {
    if (tableWrap) tableWrap.style.display = 'grid';
    if (rowsWrap) rowsWrap.style.display = 'flex';
    if (canvasWrap) canvasWrap.style.display = 'none';
    renderActiveRuleTable();
  }
  updateQuantRuleBanner();
}

function updateQuantRuleBanner() {
  const bText = document.getElementById('ruleBannerText');
  const lTitle = document.getElementById('qRuleLegendTitle');
  const lBody = document.getElementById('qRuleLegendBody');
  const centerTitle = document.getElementById('quantColCenterTitle');
  const rightTitle = document.getElementById('quantColRightTitle');

  if (activeRuleChart === 'RULE_DIVERGING') {
    if (bText) bText.innerHTML = '<b>Rule 1 — PDH Diverging Barometer:</b> Measures exact % distance above or below Previous Day High (PDH).';
    if (lTitle) lTitle.textContent = '💡 Rule 1: Breakout Divergence';
    if (lBody) lBody.innerHTML = '• <b>Green Bars:</b> Active breakouts expanding above PDH.<br>• <b>Red Bars:</b> Consolidating stocks below PDH.<br>• <b>Gold Pin:</b> Day\'s highest peak breakout milestone.';
    if (centerTitle) centerTitle.innerHTML = `
      <div class="axis-ticks-container">
        <span class="axis-tick">-15%</span><span class="axis-tick">-10%</span><span class="axis-tick">-5%</span>
        <span class="axis-tick" style="color: #FFF; font-weight: 900;">0.0% PDH</span>
        <span class="axis-tick">+5%</span><span class="axis-tick">+10%</span><span class="axis-tick">+15%</span>
      </div>`;
    if (rightTitle) rightTitle.textContent = 'MOVE VS PDH';
  } else if (activeRuleChart === 'RULE_MULTI_CROSS') {
    if (bText) bText.innerHTML = '<b>Rule 2 — Institutional Multi-Hit Squeeze:</b> Ranks assets by frequency of PDH re-tests & breakout velocity.';
    if (lTitle) lTitle.textContent = '💡 Rule 2: Multi-Cross Retests';
    if (lBody) lBody.innerHTML = '• <b>3+ Crosses (Power Trend):</b> Heavy institutional accumulation.<br>• <b>2 Crosses:</b> Confirmed breakout pullback & retest.<br>• <b>1 Cross:</b> First-mover initial breakout.';
    if (centerTitle) centerTitle.innerHTML = '<div style="text-align:center; font-size:0.7rem; color:var(--bb-text-muted);">CROSSOVER FREQUENCY & RESILIENCE SPECTRUM</div>';
    if (rightTitle) rightTitle.textContent = 'HITS & PEAK';
  } else if (activeRuleChart === 'RULE_SKEW') {
    if (bText) bText.innerHTML = '<b>Rule 3 — Call vs Put Skew Dominance:</b> Analyzes if Call buyers (CE) or Put buyers (PE) are driving the straddle explosion.';
    if (lTitle) lTitle.textContent = '💡 Rule 3: Skew Directionality';
    if (lBody) lBody.innerHTML = '• <b>CE > 60% (Green Dominance):</b> Massive Bullish Spot Rally.<br>• <b>PE > 60% (Red Dominance):</b> Spot Market Crash Panic.<br>• <b>45%–55%:</b> Pure Volatility / Gamma Expansion (Both legs inflating).';
    if (centerTitle) centerTitle.innerHTML = `
      <div style="display: flex; justify-content: space-between; font-size: 0.68rem; font-weight: 800;">
        <span style="color: var(--bb-green);">◀ CALL LEG (CE %)</span>
        <span style="color: var(--bb-text-muted);">ATM BALANCE (50/50)</span>
        <span style="color: #FF5252;">PUT LEG (PE %) ▶</span>
      </div>`;
    if (rightTitle) rightTitle.textContent = 'SKEW RATIO';
  } else if (activeRuleChart === 'RULE_STALKING') {
    if (bText) bText.innerHTML = '<b>Rule 4 — Near-Breakout Stalking Radar:</b> Stocks within 0.1% to 3.0% of PDH preparing for immediate breakout.';
    if (lTitle) lTitle.textContent = '💡 Rule 4: Pre-Breakout Stalking';
    if (lBody) lBody.innerHTML = '• Identifies coiled springs about to punch through PDH.<br>• Allows early positioning before Telegram alert fires.<br>• Sorted by closest proximity to trigger.';
    if (centerTitle) centerTitle.innerHTML = '<div style="text-align:center; font-size:0.7rem; color:var(--bb-amber);">DISTANCE TO PDH BREAKOUT (0% TO 3%)</div>';
    if (rightTitle) rightTitle.textContent = 'DISTANCE';
  } else if (activeRuleChart === 'RULE_BARBELL') {
    if (bText) bText.innerHTML = '<b>Rule 6 — Day Range & Peak Barbell (PortfolioCharts Style):</b> Shows session low, live straddle price, and peak crossover milestone.';
    if (lTitle) lTitle.textContent = '💡 Rule 6: Barbell Range';
    if (lBody) lBody.innerHTML = '• <b>Red Dot:</b> Session Low.<br>• <b>Green Pill:</b> Live Price.<br>• <b>Gold Dot:</b> Peak High Milestone above PDH.';
    if (centerTitle) centerTitle.innerHTML = '<div style="text-align:center; font-size:0.7rem; color:var(--bb-cyan);">SESSION LOW ──── LIVE STRADDLE ──── DAY PEAK</div>';
    if (rightTitle) rightTitle.textContent = 'RANGE SPREAD';
  }
}

function setQuantFilter(filterType) {
  activeQuantFilter = filterType;
  document.querySelectorAll('#tab-charts .filter-pill').forEach(p => p.classList.remove('active'));
  const map = { 'ALL': 'qfAll', 'BREAKOUTS': 'qfBreakouts', 'MULTI': 'qfMulti', 'INDICES': 'qfIndices', 'MCX': 'qfMCX' };
  if (map[filterType]) document.getElementById(map[filterType])?.classList.add('active');

  if (activeRuleChart === 'RULE_BLOOMBERG') renderQuantBloombergCanvas();
  else renderActiveRuleTable();
}

function onQuantSearchInput() {
  quantSearchQuery = (document.getElementById('quantSearchInput')?.value || '').trim().toUpperCase();
  if (activeRuleChart === 'RULE_BLOOMBERG') renderQuantBloombergCanvas();
  else renderActiveRuleTable();
}

function renderActiveRuleTable(providedSymbolsMap = null) {
  const container = document.getElementById('quantRowsContainer');
  const rawMap = providedSymbolsMap || lastSymbolsMap || {};
  const symbols = Object.values(rawMap);
  if (symbols.length === 0) return;

  const enriched = symbols.map(s => {
    const pdh = s.prevDayHighStraddle || s.prevCloseStraddle || s.prevBarClose || 0;
    const events = s.crossoverEvents || [];
    const crossCount = events.length;
    const isAbove = (s.straddlePrice > pdh && pdh > 0) || Boolean(s.breakout);
    const pctMove = pdh > 0 ? parseFloat((((s.straddlePrice - pdh) / pdh) * 100).toFixed(2)) : 0;
    const distToPdh = (pdh > 0 && s.straddlePrice <= pdh) ? parseFloat((((pdh - s.straddlePrice) / pdh) * 100).toFixed(2)) : 0;

    let maxPeakPct = 0;
    let maxPeakPrice = s.straddlePrice || 0;
    if (crossCount > 0) {
      const pcts = events.map(e => Number(e.peakPct) || (((Number(e.peakPrice) - pdh) / pdh) * 100));
      maxPeakPct = Math.max(...pcts);
      const peaks = events.map(e => Number(e.peakPrice) || 0);
      maxPeakPrice = Math.max(...peaks);
    }
    if (!isFinite(maxPeakPct) || maxPeakPct <= 0) {
      maxPeakPct = pctMove > 0 ? pctMove : 0;
    }

    const ce = Number(s.ceLtp) || 0;
    const pe = Number(s.peLtp) || 0;
    const totalLeg = (ce + pe) > 0 ? (ce + pe) : (s.straddlePrice || 1);
    const cePct = Math.round((ce / totalLeg) * 100) || 50;
    const pePct = 100 - cePct;

    return {
      ...s,
      pdh,
      crossCount,
      isAbove,
      pctMove,
      distToPdh,
      maxPeakPct,
      maxPeakPrice,
      cePct,
      pePct,
      isCommodity: s.segment === 'MCX_COMM' || ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER'].includes(s.name),
      isIndex: s.segment === 'IDX_I' || ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(s.name)
    };
  });

  // Update Sidebar
  const above = enriched.filter(e => e.isAbove);
  const below = enriched.filter(e => !e.isAbove);
  const multi = enriched.filter(e => e.crossCount >= 2);

  const elAbove = document.getElementById('qSideAboveCount');
  if (elAbove) elAbove.textContent = above.length;
  const elBelow = document.getElementById('qSideBelowCount');
  if (elBelow) elBelow.textContent = below.length;
  const elMulti = document.getElementById('qSideMultiCount');
  if (elMulti) elMulti.textContent = multi.length;

  const sortedByGain = [...enriched].sort((a, b) => b.pctMove - a.pctMove || b.maxPeakPct - a.maxPeakPct);
  const champ = sortedByGain[0];
  if (champ) {
    const elName = document.getElementById('qSideChampName');
    if (elName) elName.textContent = champ.name;
    const elPct = document.getElementById('qSideChampPct');
    if (elPct) elPct.textContent = `${champ.pctMove >= 0 ? '+' : ''}${champ.pctMove}%`;
    const elDet = document.getElementById('qSideChampDetail');
    if (elDet) elDet.textContent = `Live: ₹${champ.straddlePrice} • Day Peak: ₹${champ.maxPeakPrice}`;
  }

  const sortedByMulti = [...enriched].sort((a, b) => b.crossCount - a.crossCount || b.maxPeakPct - a.maxPeakPct);
  const multiLead = sortedByMulti[0];
  if (multiLead) {
    const elMName = document.getElementById('qSideMultiName');
    if (elMName) elMName.textContent = multiLead.name;
    const elMHits = document.getElementById('qSideMultiHits');
    if (elMHits) elMHits.textContent = `${multiLead.crossCount} Crossovers`;
    const elMDet = document.getElementById('qSideMultiDetail');
    if (elMDet) elMDet.textContent = `Peak Gain: +${multiLead.maxPeakPct.toFixed(1)}% above PDH`;
  }

  if (!container) return;

  // Filter
  let filtered = enriched;
  if (quantSearchQuery) filtered = filtered.filter(s => s.name.includes(quantSearchQuery));
  if (activeQuantFilter === 'BREAKOUTS') filtered = filtered.filter(s => s.isAbove);
  else if (activeQuantFilter === 'MULTI') filtered = filtered.filter(s => s.crossCount >= 2);
  else if (activeQuantFilter === 'INDICES') filtered = filtered.filter(s => s.isIndex);
  else if (activeQuantFilter === 'MCX') filtered = filtered.filter(s => s.isCommodity);

  // Sorting
  if (activeRuleChart === 'RULE_DIVERGING') {
    filtered.sort((a, b) => b.pctMove - a.pctMove || b.maxPeakPct - a.maxPeakPct);
  } else if (activeRuleChart === 'RULE_MULTI_CROSS') {
    filtered.sort((a, b) => b.crossCount - a.crossCount || b.maxPeakPct - a.maxPeakPct);
  } else if (activeRuleChart === 'RULE_SKEW') {
    filtered.sort((a, b) => Math.abs(b.cePct - 50) - Math.abs(a.cePct - 50));
  } else if (activeRuleChart === 'RULE_STALKING') {
    filtered = filtered.filter(s => !s.isAbove && s.distToPdh > 0 && s.distToPdh <= 3.5);
    filtered.sort((a, b) => a.distToPdh - b.distToPdh);
  } else if (activeRuleChart === 'RULE_BARBELL') {
    filtered.sort((a, b) => b.maxPeakPct - a.maxPeakPct);
  }

  const displayList = filtered.slice(0, 40);
  const maxVal = Math.max(15, ...displayList.map(s => Math.abs(s.pctMove)), ...displayList.map(s => s.maxPeakPct));

  if (displayList.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding: 3rem; color: var(--bb-text-muted);">No assets match this rule filter right now.</div>';
    return;
  }

  container.innerHTML = displayList.map((s, idx) => {
    const rank = idx + 1;
    const rankClass = rank === 1 ? 'rank-1' : (rank === 2 ? 'rank-2' : (rank === 3 ? 'rank-3' : ''));
    const isPos = s.pctMove >= 0;

    let centerHtml = '';
    let rightHtml = '';

    if (activeRuleChart === 'RULE_DIVERGING') {
      const barWidthPct = Math.min(48, (Math.abs(s.pctMove) / maxVal) * 48);
      const peakPosPct = 50 + Math.min(48, (s.maxPeakPct / maxVal) * 48);
      centerHtml = `
        <div class="diverging-track">
          <div class="zero-divider-line"></div>
          ${isPos ? `<div class="bar-gainer" style="width: ${barWidthPct}%;"></div>` : `<div class="bar-loser" style="width: ${barWidthPct}%;"></div>`}
          ${s.maxPeakPct > 0 ? `<div class="peak-spike-pin" style="left: ${peakPosPct}%;"></div>` : ''}
        </div>`;
      rightHtml = `
        <span class="mono" style="font-weight:800; font-size:0.92rem; color:${isPos ? 'var(--bb-green)' : '#FF5252'};">
          ${isPos ? '+' : ''}${s.pctMove}%
        </span>
        ${s.crossCount > 0 ? `<span class="crossover-pill-tag mono" style="font-size:0.65rem; color:var(--bb-amber);">🔥 ${s.crossCount} Hit${s.crossCount > 1 ? 's' : ''} (Pk +${s.maxPeakPct.toFixed(1)}%)</span>` : '<span style="font-size:0.65rem; color:var(--bb-text-muted);">Retraced</span>'}`;
    } else if (activeRuleChart === 'RULE_MULTI_CROSS') {
      const barWidth = Math.min(100, Math.max(10, s.crossCount * 25));
      centerHtml = `
        <div style="position:relative; height:20px; background:rgba(0,0,0,0.3); border-radius:4px; margin:0 0.5rem; overflow:hidden;">
          <div style="width:${barWidth}%; height:100%; background:linear-gradient(90deg, #FF6E40, #FFB300); border-radius:4px; display:flex; align-items:center; padding-left:8px; font-size:0.7rem; font-weight:800; color:#000;">
            ${s.crossCount} PDH Breakout Crosses
          </div>
        </div>`;
      rightHtml = `
        <span class="mono" style="font-weight:900; font-size:0.95rem; color:var(--bb-amber);">🔥 ${s.crossCount} Hits</span>
        <span class="mono" style="font-size:0.68rem; color:var(--bb-green);">Peak: +${s.maxPeakPct.toFixed(1)}%</span>`;
    } else if (activeRuleChart === 'RULE_SKEW') {
      centerHtml = `
        <div class="skew-track">
          <div class="skew-ce-bar" style="width: ${s.cePct}%;">CE ${s.cePct}%</div>
          <div class="skew-pe-bar" style="width: ${s.pePct}%;">PE ${s.pePct}%</div>
        </div>`;
      const bias = s.cePct > 55 ? 'BULL SKEW' : (s.pePct > 55 ? 'BEAR SKEW' : 'GAMMA EXP');
      const biasCol = s.cePct > 55 ? 'var(--bb-green)' : (s.pePct > 55 ? '#FF5252' : 'var(--bb-amber)');
      rightHtml = `
        <span class="mono" style="font-weight:800; font-size:0.85rem; color:${biasCol};">${bias}</span>
        <span class="mono" style="font-size:0.68rem; color:var(--bb-text-muted);">CE ₹${s.ceLtp} | PE ₹${s.peLtp}</span>`;
    } else if (activeRuleChart === 'RULE_STALKING') {
      const proximityWidth = Math.max(5, 100 - (s.distToPdh * 25));
      centerHtml = `
        <div style="position:relative; height:20px; background:rgba(0,0,0,0.3); border-radius:4px; margin:0 0.5rem; overflow:hidden;">
          <div style="width:${proximityWidth}%; height:100%; background:linear-gradient(90deg, #FFB300, #00E676); border-radius:4px; display:flex; align-items:center; padding-left:8px; font-size:0.7rem; font-weight:800; color:#000;">
            ${s.distToPdh}% to Trigger
          </div>
        </div>`;
      rightHtml = `
        <span class="mono" style="font-weight:900; font-size:0.92rem; color:var(--bb-amber);">- ${s.distToPdh}%</span>
        <span class="mono" style="font-size:0.68rem; color:var(--bb-text-muted);">Str: ₹${s.straddlePrice} / PDH: ₹${s.pdh}</span>`;
    } else if (activeRuleChart === 'RULE_BARBELL') {
      const livePct = 30 + Math.min(65, s.pctMove * 3);
      const peakPct = Math.min(95, livePct + (s.maxPeakPct * 2));
      centerHtml = `
        <div class="barbell-track">
          <div class="barbell-line"></div>
          <div class="barbell-spread-fill" style="left: 10%; width: ${peakPct - 10}%;"></div>
          <div class="barbell-dot-min" style="left: 10%;" title="Session Low"></div>
          <div class="barbell-badge-live mono" style="left: ${livePct}%;">₹${s.straddlePrice}</div>
          <div class="barbell-dot-max" style="left: ${peakPct}%;" title="Peak Spike: ₹${s.maxPeakPrice}"></div>
        </div>`;
      rightHtml = `
        <span class="mono" style="font-weight:800; font-size:0.88rem; color:var(--bb-green);">+${s.maxPeakPct.toFixed(1)}% Peak</span>
        <span class="mono" style="font-size:0.68rem; color:var(--bb-text-muted);">Live: ₹${s.straddlePrice}</span>`;
    }

    return `
      <div class="table-row-item ${rankClass}">
        <div class="mono" style="font-weight:800; font-size:0.8rem; color:var(--bb-text-muted);">#${rank}</div>

        <div style="display:flex; flex-direction:column;">
          <div style="font-size:0.88rem; font-weight:800; display:flex; align-items:center; gap:0.4rem;">
            <span>${s.name}</span>
            ${s.isIndex ? '<span class="tag-chip tag-idx">IDX</span>' : (s.isCommodity ? '<span class="tag-chip tag-mcx">MCX</span>' : '')}
          </div>
          <div class="mono" style="font-size:0.72rem; color:var(--bb-text-muted);">₹${s.straddlePrice} / ₹${s.pdh}</div>
        </div>

        ${centerHtml}

        <div style="text-align:right; display:flex; flex-direction:column; align-items:flex-end;">
          ${rightHtml}
        </div>

        <div style="text-align:center;">
          <button class="btn-preview-action" onclick="openPreviewModal('${s.name}')" title="Full-View Interactive Candlestick Chart & Event Log">
            <span>🔍</span> PREVIEW
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderQuantBloombergCanvas() {
  const ctx = document.getElementById('quantBloombergCanvas');
  if (!ctx) return;

  const rawMap = lastSymbolsMap || {};
  let list = Object.values(rawMap).map(s => {
    const pdh = s.prevDayHighStraddle || s.prevCloseStraddle || s.prevBarClose || 0;
    const events = s.crossoverEvents || [];
    const crossCount = events.length;
    const isAbove = (s.straddlePrice > pdh && pdh > 0) || Boolean(s.breakout);
    const pctMove = pdh > 0 ? parseFloat((((s.straddlePrice - pdh) / pdh) * 100).toFixed(2)) : 0;
    let maxPeakPct = 0;
    if (crossCount > 0) {
      const pcts = events.map(e => Number(e.peakPct) || (((Number(e.peakPrice) - pdh) / pdh) * 100));
      maxPeakPct = Math.max(...pcts);
    }
    if (!isFinite(maxPeakPct) || maxPeakPct <= 0) maxPeakPct = pctMove > 0 ? pctMove : 0;

    return {
      ...s,
      pdh,
      crossCount,
      isAbove,
      pctMove,
      maxPeakPct,
      isCommodity: s.segment === 'MCX_COMM' || ['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER', 'COPPER'].includes(s.name),
      isIndex: s.segment === 'IDX_I' || ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(s.name)
    };
  });

  if (quantSearchQuery) list = list.filter(s => s.name.includes(quantSearchQuery));
  if (activeQuantFilter === 'BREAKOUTS') list = list.filter(s => s.isAbove);
  else if (activeQuantFilter === 'MULTI') list = list.filter(s => s.crossCount >= 2);
  else if (activeQuantFilter === 'INDICES') list = list.filter(s => s.isIndex);
  else if (activeQuantFilter === 'MCX') list = list.filter(s => s.isCommodity);

  list.sort((a, b) => b.pctMove - a.pctMove);
  const topItems = list.slice(0, 22);

  const labels = topItems.map((s, i) => `${i + 1}. ${s.name}`);
  const dataPoints = topItems.map(s => s.pctMove);
  const peakPoints = topItems.map(s => s.maxPeakPct);
  const bgColors = dataPoints.map(v => v >= 0 ? '#00E676' : '#FF3D57');

  if (quantBloombergChartInstance) {
    quantBloombergChartInstance.data.labels = labels;
    quantBloombergChartInstance.data.datasets[0].data = dataPoints;
    quantBloombergChartInstance.data.datasets[0].backgroundColor = bgColors;
    quantBloombergChartInstance.data.datasets[1].data = peakPoints;
    quantBloombergChartInstance.update('none');
  } else {
    quantBloombergChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Live % Move from PDH',
            data: dataPoints,
            backgroundColor: bgColors,
            borderRadius: 4,
            barThickness: 16
          },
          {
            label: 'Intraday Peak Spike %',
            data: peakPoints,
            backgroundColor: '#FFD700',
            borderRadius: 4,
            barThickness: 6
          }
        ]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#FFF', font: { weight: 'bold' } } },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.raw >= 0 ? '+' : ''}${ctx.raw}%`
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255, 255, 255, 0.08)' },
            ticks: { color: '#94A3B8', callback: (v) => `${v}%` }
          },
          y: {
            grid: { display: false },
            ticks: { color: '#FFF', font: { weight: 'bold', size: 11 } }
          }
        }
      }
    });
  }
}

// Start Live Status Polling
setInterval(fetchStatus, 2000);


