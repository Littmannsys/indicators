'use strict';

/**
 * Deriv EMA Indicator — Node.js (server-side)
 * Requires: ws  →  npm install ws
 * Usage:    node ema2min.js
 */

const WebSocket = require('ws');

// ─── Telegram configuration ───────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = '8626868477:AAHyD9ajC4M_SYX4XbYcbAiV9nmtelVl6KA';
const TELEGRAM_CHAT_ID   = '6456659526';

// ─── Deriv WebSocket ──────────────────────────────────────────────────────────
const API_URL = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
let ws;

// ─── Indicator Configuration ──────────────────────────────────────────────────
const EMA_PERIODS        = [20]; // Tracks only the 20 EMA
const COOLDOWN_CANDLES   = 5;        // Closed candles to wait before re-alerting for touches
const NO_TOUCH_SECONDS   = 50 * 60;  // 50 minutes (in seconds) for the no-touch alert

// Emoji mapping to identify the EMA period
const EMA_EMOJIS = {
  20: '2️⃣0️⃣'
};

// ─── Symbols & timeframes ─────────────────────────────────────────────────────
const SYMBOLS    = ['R_10', 'R_25']; 
const TIMEFRAMES = ['5min'];

const timeframeMap = { '5min': 300 }; // 5 mins = 300 seconds

const displayNames = {
  'R_10':    'Volatility 10 Index',
  'R_25':    'Volatility 25 Index',
  '5min':    '5 minutes'
};

const MAX_HISTORICAL_CANDLES = 5000;

// ─── State ───────────────────────────────────────────────────────────────────
const historicalData       = {};
const currentCandles       = {};
const emaNotificationState = {};
const emaState             = {}; 

function initState() {
  SYMBOLS.forEach(sym => {
    historicalData[sym]       = {};
    currentCandles[sym]       = {};
    emaNotificationState[sym] = {};
    emaState[sym]             = {};

    TIMEFRAMES.forEach(tf => {
      historicalData[sym][tf]       = [];
      currentCandles[sym][tf]       = null;
      emaNotificationState[sym][tf] = {};

      EMA_PERIODS.forEach(period => {
        emaNotificationState[sym][tf][period] = { 
          lastAlertTimestamp: null, 
          lastTouchTimestamp: null,
          notifSent: false, 
          noTouchAlertSent: false 
        };
      });
    });

    EMA_PERIODS.forEach(period => {
      emaState[sym][period] = null;
    });
  });
}

initState();

// ─── Telegram ────────────────────────────────────────────────────────────────
async function sendTelegramNotification(message, dedupKey) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const url  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' });

  try {
    const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const data = await res.json();
    if (!data.ok) console.error('[Telegram] API error:', data);
    else          console.log(`[Telegram] Sent ✓ (${dedupKey})`);
  } catch (err) {
    console.error('[Telegram] Send failed:', err.message);
  }
}

// ─── EMA helpers ─────────────────────────────────────────────────────────────
function initEMA(symbol, closedCandles, period) {
  const data = closedCandles
    .filter(c => isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (data.length < period) { emaState[symbol][period] = null; return; }

  let ema = 0;
  for (let i = 0; i < period; i++) ema += data[i].close;
  ema /= period;

  const k = 2 / (period + 1);
  for (let i = period; i < data.length; i++) {
    ema = data[i].close * k + ema * (1 - k);
  }
  emaState[symbol][period] = ema;
}

function advanceEMA(symbol, period, closedClose) {
  if (emaState[symbol][period] === null) return;
  const k = 2 / (period + 1);
  emaState[symbol][period] = closedClose * k + emaState[symbol][period] * (1 - k);
}

function getEMA(symbol, period) {
  return emaState[symbol][period];
}

// ─── EMA touch and timeout detection ─────────────────────────────────────────
function checkEMATouches(symbol, timeframe, closedCandle) {
  const symbolName  = displayNames[symbol] || symbol;
  const granularity = timeframeMap[timeframe];
  const currentTimestamp = closedCandle.timestamp;

  EMA_PERIODS.forEach(period => {
    const ema = getEMA(symbol, period); 
    if (ema === null) return;

    // Touch condition: The EMA value lies anywhere between or exactly on the Candle's High and Low
    const touched = closedCandle.low <= ema && closedCandle.high >= ema;

    const dedupKey = `${symbol}:${timeframe}:${period}`;
    const state    = emaNotificationState[symbol][timeframe][period];
    const emaEmoji = EMA_EMOJIS[period] || period;

    // 1. Process standard EMA Touch
    if (touched) {
      // Record the exact time of this touch and reset the 20-min alert flag
      state.lastTouchTimestamp = currentTimestamp;
      state.noTouchAlertSent   = false;

      // Evaluate Cooldown for Touch Alert
      const candlesPassed = state.lastAlertTimestamp === null 
        ? Infinity 
        : (currentTimestamp - state.lastAlertTimestamp) / granularity;

      const candlesClear = candlesPassed >= COOLDOWN_CANDLES;

      if (state.notifSent && candlesClear) {
        state.notifSent = false;
        console.log(`[Lock] Released ${dedupKey}`);
      }

      if (!state.notifSent) {
        state.lastAlertTimestamp = currentTimestamp;
        state.notifSent          = true;

        const message = `${symbolName} EMA${emaEmoji}: ${ema.toFixed(4)} | Price: ${closedCandle.close.toFixed(4)}`;
        console.log(`\n${message}`);
        sendTelegramNotification(message, dedupKey);
      }
    }

    // 2. Process 50-Minute No-Touch Condition
    if (state.lastTouchTimestamp !== null && !state.noTouchAlertSent) {
      const timeSinceLastTouch = currentTimestamp - state.lastTouchTimestamp;
      
      if (timeSinceLastTouch >= NO_TOUCH_SECONDS) {
        state.noTouchAlertSent = true; // Mark as sent so it doesn't spam
        
        const message = `⏳ ${symbolName} EMA${emaEmoji} has NOT been touched in the last 50 minutes.`;
        console.log(`\n${message}`);
        sendTelegramNotification(message, `${dedupKey}:no-touch`);
      }
    }
  });
}

// ─── Candle management ───────────────────────────────────────────────────────
function getCandleTimeframe(timestamp, granularity) {
  return Math.floor(timestamp / granularity) * granularity;
}

function updateCurrentCandle(symbol, price, timestamp) {
  Object.keys(timeframeMap).forEach(timeframe => {
    const granularity = timeframeMap[timeframe];
    const candleTime  = getCandleTimeframe(timestamp, granularity);

    if (!currentCandles[symbol][timeframe] ||
        currentCandles[symbol][timeframe].timestamp !== candleTime) {

      if (currentCandles[symbol][timeframe]) {
        const closedCandle = currentCandles[symbol][timeframe];
        historicalData[symbol][timeframe].push(closedCandle);
        if (historicalData[symbol][timeframe].length > MAX_HISTORICAL_CANDLES)
          historicalData[symbol][timeframe].shift();

        const closedClose = closedCandle.close;

        // Check for EMA touches & timeouts using the fully formed closed candle
        checkEMATouches(symbol, timeframe, closedCandle);

        EMA_PERIODS.forEach(period => {
          advanceEMA(symbol, period, closedClose);
        });
        console.log(`\n[${symbol}/${timeframe}] Candle closed @ ${closedClose}`);
      }

      currentCandles[symbol][timeframe] = {
        timestamp: candleTime, open: price, high: price, low: price, close: price
      };
    } else {
      const c = currentCandles[symbol][timeframe];
      c.high  = Math.max(c.high, price);
      c.low   = Math.min(c.low,  price);
      c.close = price;
    }
  });
}

// ─── Indicator recalculation ─────────────────────────────────────────────────
function recalculateIndicators(symbol, timeframe, livePrice) {
  if (!historicalData[symbol][timeframe].length || !currentCandles[symbol][timeframe]) return;

  let emaString = '';
  EMA_PERIODS.forEach(period => {
    const emaVal = getEMA(symbol, period);
    emaString += `EMA${period}:${emaVal !== null ? emaVal.toFixed(4) : 'N/A'} `;
  });

  process.stdout.write(
    `\r[${symbol}] Price:${livePrice.toFixed(4)} ${emaString}  `
  );
}

// ─── Historical candle processing ────────────────────────────────────────────
function processCandles(symbol, timeframe, candles) {
  const data = candles
    .map(c => ({ open: parseFloat(c.open), high: parseFloat(c.high),
                 low: parseFloat(c.low), close: parseFloat(c.close), timestamp: c.epoch }))
    .filter(c => isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!data.length) return;

  historicalData[symbol][timeframe] = data.slice(0, -1);

  const lastCandle = data[data.length - 1];
  currentCandles[symbol][timeframe] = {
    timestamp: lastCandle.timestamp,
    open: lastCandle.open, high: lastCandle.high,
    low: lastCandle.low,   close: lastCandle.close
  };

  EMA_PERIODS.forEach(period => {
    initEMA(symbol, historicalData[symbol][timeframe], period);
  });

  const emaLogDetails = EMA_PERIODS.map(p => `EMA${p}:${emaState[symbol][p]?.toFixed(4) ?? 'N/A'}`).join(' | ');
  console.log(
    `[${symbol}/${timeframe}] Loaded ${data.length} candles | ${emaLogDetails}`
  );
}

// ─── WebSocket ───────────────────────────────────────────────────────────────
function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function requestCandles(symbol, timeframe) {
  sendMessage({
    ticks_history: symbol, adjust_start_time: 1,
    count: MAX_HISTORICAL_CANDLES, end: 'latest',
    style: 'candles', granularity: timeframeMap[timeframe]
  });
}

// ─── WebSocket initialization & event handling ───────────────────────────────
function subscribeToTicks(symbol) {
  sendMessage({ ticks: symbol, subscribe: 1 });
}

const lastTickEpoch = {};

function handleMessage(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }

  if (data.error) { console.error('[WS] Error:', data.error.message); return; }

  if (data.candles) {
    const symbol    = data.echo_req.ticks_history;
    const tf        = Object.keys(timeframeMap).find(k => timeframeMap[k] === data.echo_req.granularity);
    if (tf) processCandles(symbol, tf, data.candles);
  }

  if (data.tick) {
    const { symbol, quote, epoch } = data.tick;
    const price = parseFloat(quote);

    if (lastTickEpoch[symbol] === epoch) return;
    lastTickEpoch[symbol] = epoch;

    updateCurrentCandle(symbol, price, epoch);
    Object.keys(timeframeMap).forEach(tf => recalculateIndicators(symbol, tf, price));
  }
}

function initializeWebSocket() {
  console.log('[WS] Connecting…');
  ws = new WebSocket(API_URL);

  ws.on('open', () => {
    console.log('[WS] Connected');
    SYMBOLS.forEach(sym => {
      TIMEFRAMES.forEach(tf => requestCandles(sym, tf));
      subscribeToTicks(sym);
    });
  });

  ws.on('message', handleMessage);

  ws.on('close', () => {
    console.log('\n[WS] Disconnected — reconnecting in 5s…');
    setTimeout(initializeWebSocket, 5_000);
  });

  ws.on('error', err => console.error('[WS] Error:', err.message));
}

process.on('SIGINT',  () => { ws?.close(); process.exit(0); });
process.on('SIGTERM', () => { ws?.close(); process.exit(0); });

initializeWebSocket();