'use strict';

/**
 * Deriv EMA Indicator — Node.js (server-side)
 * Requires: ws  →  npm install ws
 * Usage:    node indicators.js
 */

const WebSocket = require('ws');

// ─── Telegram configuration ───────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = '8626868477:AAHyD9ajC4M_SYX4XbYcbAiV9nmtelVl6KA';
const TELEGRAM_CHAT_ID   = '6456659526';

// ─── Deriv WebSocket ──────────────────────────────────────────────────────────
const API_URL = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
let ws;

// ─── Symbols & timeframes ─────────────────────────────────────────────────────
const SYMBOLS    = ['R_10', 'R_25', 'stpRNG'];
const TIMEFRAMES = ['5min'];

const timeframeMap = {
  '5min': 300
};

const displayNames = {
  'R_10':   'Volatility 10 Index',
  'R_25':   'Volatility 25 Index',
  'stpRNG': 'Step Index 100 stpRNG',
  '5min':   '5 minutes'
};

const MAX_HISTORICAL_CANDLES = 5000;

// ─── State ────────────────────────────────────────────────────────────────────

const historicalData       = {};  // historicalData[sym][tf]       → candle[]
const currentCandles       = {};  // currentCandles[sym][tf]       → candle
const candleCount          = {};  // candleCount[sym][tf]          → number
const emaNotificationState = {};  // emaNotificationState[sym][tf][period] → {lastNotifCandle, notifSent}
const emaPriceSide         = {};  // emaPriceSide[sym][tf][period] → 'above'|'below'|null
const emaState             = {};  // emaState[sym][period]         → number (last CLOSED bar EMA)

SYMBOLS.forEach(sym => {
  historicalData[sym]       = {};
  currentCandles[sym]       = {};
  candleCount[sym]          = {};
  emaNotificationState[sym] = {};
  emaPriceSide[sym]         = {};
  emaState[sym]             = {};

  TIMEFRAMES.forEach(tf => {
    historicalData[sym][tf] = [];
    currentCandles[sym][tf] = null;
    candleCount[sym][tf]    = 0;

    emaNotificationState[sym][tf] = {};
    emaPriceSide[sym][tf]         = {};

    [20, 50].forEach(period => {
      emaNotificationState[sym][tf][period] = { lastNotifCandle: null, notifSent: false };
      emaPriceSide[sym][tf][period]         = null;
    });
  });

  [20, 50].forEach(period => {
    emaState[sym][period] = null;
  });
});

// ─── Telegram ─────────────────────────────────────────────────────────────────

// Dedup keyed on symbol:timeframe:period — stable across ticks
const alertSentAt = new Map();

// Dedup processed ticks — key: `${symbol}:${epoch}` prevents same tick firing twice
const processedTicks = new Map();

async function sendTelegramNotification(message, dedupKey) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[Telegram] Credentials not configured');
    return;
  }

  const now      = Date.now();
  const lastSent = alertSentAt.get(dedupKey) || 0;
  if (now - lastSent < 10_000) {
    console.warn(`[Telegram] Duplicate blocked: ${dedupKey}`);
    return;
  }
  alertSentAt.set(dedupKey, now);

  const url  = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id:    TELEGRAM_CHAT_ID,
    text:       message,
    parse_mode: 'Markdown'
  });

  try {
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const data = await res.json();
    if (!data.ok) console.error('[Telegram] API error:', data);
    else          console.log(`[Telegram] Sent ✓ (${dedupKey})`);
  } catch (err) {
    console.error('[Telegram] Send failed:', err.message);
  }
}

// ─── EMA helpers ──────────────────────────────────────────────────────────────

function initEMA(symbol, closedCandles, period) {
  const data = closedCandles
    .filter(c => isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (data.length < period) {
    emaState[symbol][period] = null;
    return;
  }

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

function getLiveEMA(symbol, period, currentPrice) {
  const stored = emaState[symbol][period];
  if (stored === null) return null;
  const k = 2 / (period + 1);
  return currentPrice * k + stored * (1 - k);
}

function getEMA(symbol, period) {
  return emaState[symbol][period];
}

// ─── EMA cross detection ──────────────────────────────────────────────────────

function checkEMATouches(symbol, timeframe, currentPrice) {
  const symbolName    = displayNames[symbol]    || symbol;
  const timeframeName = displayNames[timeframe] || timeframe;
  const currentCount  = candleCount[symbol][timeframe];

  [20, 50].forEach(period => {
    const ema = getEMA(symbol, period);
    if (ema === null) return;

    const state = emaNotificationState[symbol][timeframe][period];

    // 1. ALWAYS track the price side, even during cooldown
    const currentSide  = currentPrice >= ema ? 'above' : 'below';
    const previousSide = emaPriceSide[symbol][timeframe][period];
    
    emaPriceSide[symbol][timeframe][period] = currentSide;

    // 2. Unlock cooldown after 5 closed candles
    if (state.notifSent && currentCount - state.lastNotifCandle >= 5) {
      state.notifSent = false;
    }

    // 3. Check cooldown and crossover AFTER updating the side
    if (state.notifSent) return;
    if (previousSide === null) return;        
    if (previousSide === currentSide) return; // No cross occurred

    // Price has crossed the stable EMA line — fire exactly once
    const crossedUp = currentSide === 'above';
    const emoji     = crossedUp ? '📈' : '📉';
    const message   =
      `${emoji} *${period} EMA ${symbolName} on ${timeframeName}* : price Touch\n` +
      `EMA: ${ema.toFixed(4)} | Price: ${currentPrice.toFixed(4)}`;

    state.lastNotifCandle = currentCount;
    state.notifSent       = true;

    const dedupKey = `${symbol}:${timeframe}:${period}`;
    sendTelegramNotification(message, dedupKey);
    console.log(`[Alert] ${message.replace(/\*/g, '')}`);
  });
}

// ─── Candle management ────────────────────────────────────────────────────────

function getCandleTimeframe(timestamp, granularity) {
  return Math.floor(timestamp / granularity) * granularity;
}

function updateCurrentCandle(symbol, price, timestamp) {
  Object.keys(timeframeMap).forEach(timeframe => {
    const granularity = timeframeMap[timeframe];
    const candleTime  = getCandleTimeframe(timestamp, granularity);
    const currentCandle = currentCandles[symbol][timeframe];

    // FIX: Ignore older out-of-order ticks that would drag the candle backwards
    if (currentCandle && candleTime < currentCandle.timestamp) return;

    if (!currentCandle || currentCandle.timestamp !== candleTime) {
      // Previous candle just closed — archive it and advance EMA
      if (currentCandle) {
        historicalData[symbol][timeframe].push(currentCandle);

        if (historicalData[symbol][timeframe].length > MAX_HISTORICAL_CANDLES) {
          historicalData[symbol][timeframe].shift();
        }

        const closedClose = currentCandle.close;
        advanceEMA(symbol, 20, closedClose);
        advanceEMA(symbol, 50, closedClose);
        candleCount[symbol][timeframe]++;

        console.log(
          `\n[${symbol}/${timeframe}] Candle closed. ` +
          `EMA20: ${emaState[symbol][20] !== null ? emaState[symbol][20].toFixed(4) : 'N/A'} | ` +
          `EMA50: ${emaState[symbol][50] !== null ? emaState[symbol][50].toFixed(4) : 'N/A'}`
        );
      }

      // Open new forming candle
      currentCandles[symbol][timeframe] = {
        timestamp: candleTime,
        open:  price,
        high:  price,
        low:   price,
        close: price
      };
    } else {
      currentCandle.high  = Math.max(currentCandle.high, price);
      currentCandle.low   = Math.min(currentCandle.low,  price);
      currentCandle.close = price;
    }
  });
}

// ─── Indicator recalculation ──────────────────────────────────────────────────

function recalculateIndicators(symbol, timeframe, livePrice) {
  const historicalCandles = historicalData[symbol][timeframe];
  const currentCandle     = currentCandles[symbol][timeframe];

  if (!historicalCandles || historicalCandles.length === 0 || !currentCandle) return;

  const ema20Display = getEMA(symbol, 20);
  const ema50Display = getEMA(symbol, 50);

  const trend20  = ema20Display !== null ? (livePrice > ema20Display ? 'Uptrend' : 'Downtrend') : 'N/A';
  const trend50  = ema50Display !== null ? (livePrice > ema50Display ? 'Uptrend' : 'Downtrend') : 'N/A';
  const dist20   = ema20Display !== null ? (livePrice - ema20Display).toFixed(4) : 'N/A';
  const dist50   = ema50Display !== null ? (livePrice - ema50Display).toFixed(4) : 'N/A';

  process.stdout.write(
    `\r[${symbol}] Price: ${livePrice.toFixed(4)} | ` +
    `EMA20: ${ema20Display !== null ? ema20Display.toFixed(4) : 'N/A'} (${trend20} ${dist20}) | ` +
    `EMA50: ${ema50Display !== null ? ema50Display.toFixed(4) : 'N/A'} (${trend50} ${dist50})   `
  );

  checkEMATouches(symbol, timeframe, livePrice);
}

// ─── Historical candle processing ─────────────────────────────────────────────

function processCandles(symbol, timeframe, candles) {
  const data = candles
    .map(c => ({
      open:      parseFloat(c.open),
      high:      parseFloat(c.high),
      low:       parseFloat(c.low),
      close:     parseFloat(c.close),
      timestamp: c.epoch
    }))
    .filter(c => isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (data.length === 0) return;

  historicalData[symbol][timeframe] = data.slice(0, -1);

  const lastCandle = data[data.length - 1];
  currentCandles[symbol][timeframe] = {
    timestamp: lastCandle.timestamp,
    open:  lastCandle.open,
    high:  lastCandle.high,
    low:   lastCandle.low,
    close: lastCandle.close
  };

  initEMA(symbol, historicalData[symbol][timeframe], 20);
  initEMA(symbol, historicalData[symbol][timeframe], 50);

  ;[20, 50].forEach(period => {
    const ema = emaState[symbol][period];
    const lastClose = historicalData[symbol][timeframe].length > 0
      ? historicalData[symbol][timeframe][historicalData[symbol][timeframe].length - 1].close
      : null;
    if (ema !== null && lastClose !== null) {
      emaPriceSide[symbol][timeframe][period] = lastClose >= ema ? 'above' : 'below';
    } else {
      emaPriceSide[symbol][timeframe][period] = null;
    }
  });

  console.log(
    `[${symbol}/${timeframe}] Loaded ${data.length} candles. ` +
    `EMA20: ${emaState[symbol][20] !== null ? emaState[symbol][20].toFixed(4) : 'N/A'} | ` +
    `EMA50: ${emaState[symbol][50] !== null ? emaState[symbol][50].toFixed(4) : 'N/A'}`
  );
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function sendMessage(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function requestCandles(symbol, timeframe) {
  const granularity = timeframeMap[timeframe];
  sendMessage({
    ticks_history:     symbol,
    adjust_start_time: 1,
    count:             MAX_HISTORICAL_CANDLES,
    end:               'latest',
    style:             'candles',
    granularity
  });
}

function subscribeToTicks(symbol) {
  sendMessage({ ticks: symbol, subscribe: 1 });
}

function handleMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error('[WS] Invalid JSON received');
    return;
  }

  if (data.error) {
    console.error('[WS] Server error:', data.error.message);
    return;
  }

  if (data.candles) {
    const symbol      = data.echo_req.ticks_history;
    const granularity = data.echo_req.granularity;
    const timeframe   = Object.keys(timeframeMap).find(k => timeframeMap[k] === granularity);
    if (timeframe) processCandles(symbol, timeframe, data.candles);
  }

  if (data.tick) {
    const symbol    = data.tick.symbol;
    const price     = parseFloat(data.tick.quote);
    const timestamp = data.tick.epoch;

    const tickKey = `${symbol}:${timestamp}`;
    if (processedTicks.has(tickKey)) return;
    processedTicks.set(tickKey, Date.now());
    const cutoff = Date.now() - 60_000;
    processedTicks.forEach((t, k) => { if (t < cutoff) processedTicks.delete(k); });

    updateCurrentCandle(symbol, price, timestamp);

    Object.keys(timeframeMap).forEach(timeframe => {
      recalculateIndicators(symbol, timeframe, price);
    });
  }
}

function initializeWebSocket() {
  console.log('[WS] Connecting to Deriv…');
  ws = new WebSocket(API_URL);

  ws.on('open', () => {
    console.log('[WS] Connected');
    SYMBOLS.forEach(symbol => {
      TIMEFRAMES.forEach(timeframe => requestCandles(symbol, timeframe));
      subscribeToTicks(symbol);
    });
  });

  ws.on('message', handleMessage);

  ws.on('close', () => {
    console.log('\n[WS] Disconnected — reconnecting in 5 s…');
    setTimeout(initializeWebSocket, 5_000);
  });

  ws.on('error', err => {
    console.error('[WS] Error:', err.message);
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT',  () => { console.log('\n[App] Shutting down…'); ws && ws.close(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[App] Shutting down…'); ws && ws.close(); process.exit(0); });

// ─── Start ────────────────────────────────────────────────────────────────────

initializeWebSocket();