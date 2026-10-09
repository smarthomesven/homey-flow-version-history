'use strict';

/**
 * Homey telemetry client (drop-in, CommonJS)
 *
 * Setup:
 *   1. npm install ws
 *   2. Put the shared app ID in env.json (or process.env):  { "TELEMETRY_APP_ID": "nl.dypodex.myapp" }
 *      (or pass { appId } to the constructor)
 *   3. In app.js:
 *
 *        const Telemetry = require('./lib/telemetry');
 *
 *        async onInit() {
 *          this.telemetry = new Telemetry(this);
 *          await this.telemetry.begin();
 *          this.telemetry.setFlag('has_paired_devices', this.homey.drivers.getDrivers() ? true : false);
 *        }
 *
 *        async onUninit() {
 *          this.telemetry.end();
 *        }
 *
 *        // anywhere:
 *        this.telemetry.error('Something broke', err);   // also calls this.error()
 *        this.telemetry.log('Device paired', { id });    // also calls this.log()
 *        this.telemetry.sendEvent('device_paired', { driver: 'foo' });
 *        this.telemetry.setFlag('version', '1.2.3');
 *
 * Privacy: no Homey identifiers are used. Each installation gets a random UUID that is
 * stored in the app's settings. (Uninstalling the app removes it, a reinstall gets a new one.)
 *
 * Notifications: the server can push messages to installations (by app ID and version).
 * They are shown with this.homey.notifications.createNotification({ excerpt }) and then
 * acknowledged, so each installation gets each notification once. Disable with
 * new Telemetry(this, { notifications: false }).
 *
 * Telemetry must never break the app: every public method swallows its own errors.
 */

const crypto = require('crypto');
const util = require('util');
const WebSocket = require('ws');

const DEFAULTS = {
  url: 'wss://homey.services.dypodex.nl/ws',
  appId: null,
  maxQueue: 200, // messages buffered while offline (oldest dropped first)
  reconnectMin: 2000, // ms
  reconnectMax: 5 * 60 * 1000, // ms
  idleTimeout: 75 * 1000, // reconnect if the server has been silent this long (server pings every 30s)
  maxMessagesPerMinute: 30, // client-side flood protection
  handshakeTimeout: 15 * 1000,
  notifications: true, // show notifications pushed from the server
  instanceSettingKey: 'telemetry_instance_id', // app setting holding this installation's UUID
  seenSettingKey: 'telemetry_seen_notifications', // app setting holding handled notification IDs
};

const MAX_MESSAGE_CHARS = 2000;
const MAX_STACK_CHARS = 8000;
const MAX_DATA_CHARS = 8000;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuidv4() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function readEnv(key) {
  try {
    // Homey exposes env.json through Homey.env
    // eslint-disable-next-line global-require
    const Homey = require('homey');
    if (Homey && Homey.env && Homey.env[key]) return Homey.env[key];
  } catch (_) { /* not running inside Homey */ }
  return process.env[key];
}

function clip(value, max) {
  const s = typeof value === 'string' ? value : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

// Make arbitrary values JSON-safe (Errors, BigInt, circular refs) and size-bounded
function clean(value) {
  if (value === undefined) return undefined;
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(value, (key, v) => {
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === 'bigint') return v.toString();
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return v;
    });
    if (json === undefined) return undefined;
    if (json.length > MAX_DATA_CHARS) return { _truncated: true, preview: json.slice(0, 1000) };
    return JSON.parse(json);
  } catch (_) {
    return undefined;
  }
}

class Telemetry {
  /**
   * @param {Homey.App} app  the app instance (`this` in app.js)
   * @param {object} [options]  see DEFAULTS
   */
  constructor(app, options = {}) {
    if (!app || !app.homey) throw new Error('Telemetry: pass your Homey.App instance, e.g. new Telemetry(this)');

    this.app = app;
    this.homey = app.homey;
    this.options = Object.assign({}, DEFAULTS, options);
    this.appId = this.homey.manifest.id || readEnv('TELEMETRY_APP_ID') || null;

    this.instanceId = null; // random UUID, persisted in the app settings
    this.flags = {};

    this._ws = null;
    this._queue = [];
    this._started = false;
    this._stopped = false;
    this._disabled = false;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._watchdog = null;
    this._notifying = new Set(); // notification IDs currently being shown

    // token bucket
    this._tokens = this.options.maxMessagesPerMinute;
    this._lastRefill = Date.now();
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  /** Start telemetry: resolve the instance ID, connect, auto-reconnect. Call from onInit(). */
  async begin() {
    try {
      if (this._started) return;
      if (!this.appId) {
        this.app.log('[telemetry] no app ID configured (TELEMETRY_APP_ID), telemetry disabled');
        this._disabled = true;
        this._queue = [];
        return;
      }
      this._started = true;
      this._stopped = false;
      this.instanceId = this._loadInstanceId();
      this._connect();
    } catch (err) {
      this.app.log('[telemetry] begin failed:', err && err.message);
    }
  }

  /** Stop telemetry and close the connection. Call from onUninit(). */
  end() {
    this._stopped = true;
    this._started = false;
    this._clearTimeout(this._reconnectTimer);
    this._clearTimeout(this._watchdog);
    this._reconnectTimer = this._watchdog = null;
    if (this._ws) {
      try { this._ws.close(1000, 'app stopping'); } catch (_) { /* ignore */ }
      this._ws = null;
    }
  }

  /** Works like this.error(), and also sends the error to the server. */
  error(...args) {
    try {
      this.app.error(...args);
    } catch (_) { /* ignore */ }

    try {
      const errObj = args.find((a) => a instanceof Error);
      const message = args
        .map((a) => {
          if (a instanceof Error) return a.message;
          if (typeof a === 'string') return a;
          return util.inspect(a, { depth: 2, breakLength: Infinity });
        })
        .join(' ');

      const context = {};
      if (errObj) {
        if (errObj.name && errObj.name !== 'Error') context.name = errObj.name;
        if (errObj.code !== undefined) context.code = errObj.code;
      }

      this._dispatch({
        t: 'error',
        message: clip(message || 'Unknown error', MAX_MESSAGE_CHARS),
        stack: errObj && errObj.stack ? clip(errObj.stack, MAX_STACK_CHARS) : undefined,
        context: Object.keys(context).length ? context : undefined,
      });
    } catch (_) { /* ignore */ }
  }

  /** Set any key/value flag (version, has_paired_devices, ...). Synced on every (re)connect. */
  setFlag(id, value) {
    try {
      if (typeof id !== 'string' || !/^[\w.:-]{1,64}$/.test(id)) {
        this.app.log('[telemetry] invalid flag id:', id);
        return;
      }
      const v = clean(value === undefined ? null : value);
      if (v === undefined) return;
      this.flags[id] = v;
      // Flags are also part of the hello message sent on connect, so no queueing needed
      if (this._isOpen()) this._rawSend({ t: 'flag', id, value: v, ts: Date.now() });
    } catch (_) { /* ignore */ }
  }

  /** Send a named event with optional data. */
  sendEvent(name, data) {
    try {
      if (typeof name !== 'string' || !name) return;
      this._dispatch({ t: 'event', name: clip(name, 100), data: clean(data) });
    } catch (_) { /* ignore */ }
  }

  /** Works like this.log(), and also sends the entry to the server. */
  log(message, data, level = 'info') {
    try {
      if (data === undefined) this.app.log(message);
      else this.app.log(message, data);
    } catch (_) { /* ignore */ }

    try {
      this._dispatch({
        t: 'log',
        level: LOG_LEVELS.includes(level) ? level : 'info',
        message: clip(typeof message === 'string' ? message : util.inspect(message, { depth: 2 }), MAX_MESSAGE_CHARS),
        data: clean(data),
      });
    } catch (_) { /* ignore */ }
  }

  get connected() {
    return this._isOpen();
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  // Random UUID, generated once and kept in the app settings
  _loadInstanceId() {
    const key = this.options.instanceSettingKey;
    try {
      const existing = this.homey.settings.get(key);
      if (typeof existing === 'string' && UUID_RE.test(existing)) return existing;
    } catch (_) { /* fall through and create one */ }

    const id = uuidv4();
    try {
      this.homey.settings.set(key, id);
    } catch (err) {
      this.app.log('[telemetry] could not persist instance ID:', err && err.message);
    }
    return id;
  }

  _connect() {
    if (this._stopped || this._ws || !this.instanceId) return;

    let ws;
    try {
      ws = new WebSocket(this.options.url, {
        headers: {
          'x-app-id': this.appId,
          'x-instance-id': this.instanceId,
        },
        handshakeTimeout: this.options.handshakeTimeout,
        maxPayload: 64 * 1024,
      });
    } catch (err) {
      this.app.log('[telemetry] connect failed:', err && err.message);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      if (this._ws !== ws) return;
      this._armWatchdog();
      this._rawSend(this._hello());
      this._flush();
    });

    ws.on('message', (data) => {
      if (this._ws !== ws) return;
      this._armWatchdog();
      try {
        const msg = JSON.parse(data.toString());
        if (!msg) return;
        if (msg.t === 'ready') this._attempt = 0; // registered, connection is healthy
        else if (msg.t === 'notification' && this.options.notifications) {
          this._onNotification(msg).catch((err) => {
            this.app.log('[telemetry] notification failed:', err && err.message);
          });
        }
      } catch (_) { /* ignore */ }
    });

    ws.on('ping', () => {
      if (this._ws === ws) this._armWatchdog();
    });

    // Never call this.error() in here: that would send errors about telemetry through telemetry
    ws.on('error', (err) => {
      this.app.log('[telemetry] socket error:', err && err.message);
    });

    ws.on('close', () => {
      if (this._ws === ws) {
        this._ws = null;
        this._clearTimeout(this._watchdog);
        this._watchdog = null;
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    const base = Math.min(this.options.reconnectMax, this.options.reconnectMin * 2 ** this._attempt);
    const delay = Math.round(base * (0.5 + Math.random() * 0.5)); // jitter
    this._attempt = Math.min(this._attempt + 1, 20);
    this._reconnectTimer = this._setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _armWatchdog() {
    this._clearTimeout(this._watchdog);
    this._watchdog = this._setTimeout(() => {
      // Server went silent: drop the socket, the close handler reconnects
      if (this._ws) {
        try { this._ws.terminate(); } catch (_) { /* ignore */ }
      }
    }, this.options.idleTimeout);
  }

  // Show a pushed notification once, then acknowledge it. Not acknowledging (e.g. when
  // createNotification fails) makes the server resend it on the next connect.
  async _onNotification(msg) {
    const id = Number(msg.id);
    const excerpt = typeof msg.excerpt === 'string' ? msg.excerpt.trim().slice(0, 500) : '';
    if (!Number.isSafeInteger(id) || id <= 0 || !excerpt) return;
    if (this._notifying.has(id)) return;
    this._notifying.add(id);

    try {
      const seen = this._seenNotifications();
      if (!seen.includes(id)) {
        await this.homey.notifications.createNotification({ excerpt });
        this._markSeen(id, seen);
      }
      if (this._isOpen()) this._rawSend({ t: 'ack', id, ts: Date.now() });
    } finally {
      this._notifying.delete(id);
    }
  }

  _seenNotifications() {
    try {
      const v = this.homey.settings.get(this.options.seenSettingKey);
      return Array.isArray(v) ? v.filter((n) => Number.isSafeInteger(n)) : [];
    } catch (_) {
      return [];
    }
  }

  _markSeen(id, seen) {
    try {
      this.homey.settings.set(this.options.seenSettingKey, seen.concat(id).slice(-50));
    } catch (_) { /* ignore */ }
  }

  _hello() {
    const hello = { t: 'hello', ts: Date.now(), flags: this.flags };
    try {
      hello.appVersion = this.homey.manifest && this.homey.manifest.version;
      hello.homeyVersion = this.homey.version;
      hello.platform = this.homey.platform;
    } catch (_) { /* ignore */ }
    return hello;
  }

  _isOpen() {
    return !!this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  _allow() {
    const now = Date.now();
    const cap = this.options.maxMessagesPerMinute;
    this._tokens = Math.min(cap, this._tokens + ((now - this._lastRefill) / 60000) * cap);
    this._lastRefill = now;
    if (this._tokens < 1) return false;
    this._tokens -= 1;
    return true;
  }

  // Send now when connected, otherwise buffer (bounded)
  _dispatch(msg) {
    if (this._stopped || this._disabled) return;
    if (!this._allow()) return;
    msg.ts = Date.now();
    if (this._isOpen()) {
      this._rawSend(msg);
    } else {
      this._queue.push(msg);
      if (this._queue.length > this.options.maxQueue) this._queue.shift();
    }
  }

  _flush() {
    const pending = this._queue;
    this._queue = [];
    for (const msg of pending) this._rawSend(msg);
  }

  _rawSend(msg) {
    try {
      this._ws.send(JSON.stringify(msg), () => {});
    } catch (_) { /* ignore */ }
  }

  // Use Homey's timers when available so they are cleaned up with the app
  _setTimeout(fn, ms) {
    return typeof this.homey.setTimeout === 'function' ? this.homey.setTimeout(fn, ms) : setTimeout(fn, ms);
  }

  _clearTimeout(handle) {
    if (!handle) return;
    if (typeof this.homey.clearTimeout === 'function') this.homey.clearTimeout(handle);
    else clearTimeout(handle);
  }
}

module.exports = Telemetry;