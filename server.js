'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { URLSearchParams } = require('url');
const utils = require('./lib/status-utils');

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
const PUBLIC_DIR = __dirname;
const STORE_FILE = path.join(__dirname, 'status-store.json');

let statusStore = {};
try {
  if (fs.existsSync(STORE_FILE)) {
    statusStore = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) || {};
  }
} catch (_) {
  statusStore = {};
}

function saveStore() {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(statusStore, null, 2), 'utf8'); } catch (_) {}
}

function updateStore(key, value) {
  statusStore[key] = { ...value, updatedAt: Date.now() };
  saveStore();
}

// --- Persisted monitor state helpers (dedupe across restarts) ---
function getMonitorPersist(key) {
  try {
    const root = statusStore.__monitor || {};
    return root[key] || { state: 'unknown', startedAt: null, lastNotifiedStartAt: null, lastNotifiedResolveAt: null, updatedAt: 0 };
  } catch (_) {
    return { state: 'unknown', startedAt: null, lastNotifiedStartAt: null, lastNotifiedResolveAt: null, updatedAt: 0 };
  }
}

function setMonitorPersist(key, valuePatch) {
  try {
    if (!statusStore.__monitor) statusStore.__monitor = {};
    const current = getMonitorPersist(key);
    statusStore.__monitor[key] = { ...current, ...valuePatch, updatedAt: Date.now() };
    saveStore();
  } catch (_) {}
}

function send(res, status, body, headers = {}) {
  const defaultHeaders = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };
  res.writeHead(status, { ...defaultHeaders, ...headers });
  res.end(body);
}

function serveStatic(req, res) {
  let pathname = url.parse(req.url).pathname || '/';
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return send(res, 404, 'Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = (
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.ico': 'image/x-icon',
      }[ext] || 'application/octet-stream'
    );
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

function proxyFetch(req, res) {
  const parsed = url.parse(req.url, true);
  const target = parsed.query.url;
  if (!target) return send(res, 400, 'Missing url');

  let startUrl;
  try {
    startUrl = new URL(target);
  } catch (e) {
    // Allow relative URLs to be proxied to this same server
    try {
      if (typeof target === 'string' && target.startsWith('/')) {
        startUrl = new URL(`http://127.0.0.1:${PORT}${target}`);
      } else {
        return send(res, 400, 'Invalid url');
      }
    } catch (_) {
      return send(res, 400, 'Invalid url');
    }
  }

  const maxRedirects = 5;

  function doRequest(targetUrl, redirectCount) {
    const lib = targetUrl.protocol === 'http:' ? http : https;
    const options = {
      method: 'GET',
      headers: {
        'User-Agent': 'ServiceStatusDashboard/1.0',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Encoding': 'identity',
      },
    };

    const proxyReq = lib.request(targetUrl, options, (proxyRes) => {
      const status = proxyRes.statusCode || 0;
      const location = proxyRes.headers.location;

      if ([301, 302, 303, 307, 308].includes(status) && location && redirectCount < maxRedirects) {
        try {
          const nextUrl = new URL(location, targetUrl);
          return doRequest(nextUrl, redirectCount + 1);
        } catch (e) {
          console.error('Proxy redirect parse error:', e.message, 'from', targetUrl.href, 'to', location);
          return send(res, 502, `Proxy redirect error`);
        }
      }

      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        if (res.headersSent) return;
        const body = Buffer.concat(chunks);
        const headers = {
          'Content-Type': proxyRes.headers['content-type'] || 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        };
        if (proxyRes.headers['content-encoding']) {
          headers['Content-Encoding'] = proxyRes.headers['content-encoding'];
        }
        res.writeHead(status || 200, headers);
        res.end(body);
      });
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error fetching', targetUrl.href, err && err.code, err && err.message);
      if (!res.headersSent) {
        send(res, 502, `Proxy error: ${err.code || ''} ${err.message || ''}`.trim());
      }
    });
    proxyReq.end();
  }

  doRequest(startUrl, 0);
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname || '/';
  if (pathname === '/api/fetch') return proxyFetch(req, res);
  if (pathname === '/api/notify/slack') return notifySlack(req, res);
  if (pathname === '/api/notify/enabled') return slackEnabled(res);
  if (pathname === '/api/check-html') return checkHtmlStatus(req, res);
  if (pathname === '/api/state') return getState(res);
  if (pathname === '/api/webhooks/statuspage') return webhookStatuspage(req, res);
  if (pathname === '/api/webhooks/statusgator') return webhookStatusgator(req, res);
  if (pathname === '/api/firebase/status') return firebaseStatus(req, res);
  if (pathname === '/api/apple/status') return appleAppStoreStatus(req, res);
  if (pathname === '/api/facebook/status') return facebookStatus(req, res);
  if (pathname === '/api/google/play-status') return googlePlayStatus(req, res);
  if (pathname === '/api/google/cloud-status') return googleCloudStatus(req, res);
  if (pathname === '/api/mixpanel/status') return mixpanelStatus(req, res);
  if (pathname === '/api/slack/status') return slackStatus(req, res);
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// --- Background monitor for all services ---
const SERVICE_MONITORS = [
  { name: 'Google Play Store', type: 'local', url: `http://127.0.0.1:${PORT}/api/google/play-status`, statusUrl: 'https://status.play.google.com/' },
  { name: 'Google Play Services', type: 'local', url: `http://127.0.0.1:${PORT}/api/google/play-status`, statusUrl: 'https://status.play.google.com/' },
  { name: 'Apple App Store', type: 'local', url: `http://127.0.0.1:${PORT}/api/apple/status`, statusUrl: 'https://developer.apple.com/system-status/' },
  { name: 'Firebase', type: 'local', url: `http://127.0.0.1:${PORT}/api/firebase/status`, statusUrl: 'https://status.firebase.google.com/' },
  { name: 'Mixpanel', type: 'local', url: `http://127.0.0.1:${PORT}/api/mixpanel/status`, statusUrl: 'https://status.mixpanel.com/' },
  { name: 'Singular', type: 'statuspage', url: 'https://status.singular.net/api/v2/summary.json', statusUrl: 'https://status.singular.net/' },
  { name: 'Sentry', type: 'statuspage', url: 'https://status.sentry.io/api/v2/summary.json', statusUrl: 'https://status.sentry.io/' },
  { name: 'Facebook Audience Network', type: 'local', url: `http://127.0.0.1:${PORT}/api/facebook/status`, statusUrl: 'https://metastatus.com/' },
  { name: 'Google AdMob', type: 'local', url: `http://127.0.0.1:${PORT}/api/google/cloud-status`, statusUrl: 'https://status.cloud.google.com/' },
  { name: 'Realm Database', type: 'statuspage', url: 'https://status.mongodb.com/api/v2/summary.json', statusUrl: 'https://status.mongodb.com/' },
  { name: 'Slack', type: 'local', url: `http://127.0.0.1:${PORT}/api/slack/status`, statusUrl: 'https://status.slack.com/' },
  { name: 'Notion', type: 'statuspage', url: 'https://www.notion-status.com/api/v2/summary.json', statusUrl: 'https://www.notion-status.com/' },
  { name: 'Figma', type: 'statuspage', url: 'https://status.figma.com/api/v2/summary.json', statusUrl: 'https://status.figma.com/' },
  { name: 'Jira Software', type: 'statuspage', url: 'https://jira-software.status.atlassian.com/api/v2/summary.json', statusUrl: 'https://jira-software.status.atlassian.com/' },
];

const monitorLast = new Map(); // name -> { state, severity?, startedAt? }
const notifyLast = new Map(); // name -> last notified timestamp (ms)
const COOLDOWN_MINUTES = Number(process.env.NOTIFY_COOLDOWN_MINUTES || '180');

// Persisted incident state for local server run (in-memory only)
const persistedStateByKey = new Map(); // dedupeKey -> { state, startedAt }
const RESET_UNKNOWN_MINUTES = Number(process.env.RESET_UNKNOWN_MINUTES || '60');

function getDedupeKey(svc) {
  let base = (svc && svc.statusUrl) ? String(svc.statusUrl) : String(svc && svc.name || '');
  if (base.endsWith('/')) base = base.slice(0, -1);
  return base.toLowerCase();
}

function fetchJson(u) { return utils.fetchJson(u); }

function normalizeFromLocal(data) {
  if (data && typeof data.state === 'string') {
    return { state: data.state, severity: data.severity || 'minor', title: data.title || null, startedAt: data.startedAt || null };
  }
  return { state: 'unknown' };
}

function normalizeFromStatuspage(summary) {
  try {
    if (summary && (Array.isArray(summary.incidents) || Array.isArray(summary.scheduled_maintenances))) {
      const active = (summary.incidents || []).find(i => i.status !== 'resolved');
      if (active) {
        const impact = (active.impact || active.impact_override || 'minor').toLowerCase();
        const severity = (impact === 'critical' || impact === 'major') ? 'critical' : 'minor';
        const startedAt = active.started_at || active.created_at || null;
        const incidentId = active.id || active.shortlink || active.url || null;
        return { state: 'incident', severity, title: active.name || 'Service Incident', startedAt, incidentId };
      }
      return { state: 'operational' };
    }
  } catch (_) {}
  // Fallback to indicator if present
  try {
    if (summary && summary.status && typeof summary.status.indicator === 'string') {
      const ind = String(summary.status.indicator).toLowerCase();
      if (ind === 'none') return { state: 'operational' };
      if (ind === 'minor') return { state: 'incident', severity: 'minor', title: summary.status.description || 'Service Incident' };
      if (ind === 'major' || ind === 'critical') return { state: 'incident', severity: 'critical', title: summary.status.description || 'Service Incident' };
    }
  } catch (_) {}
  return { state: 'unknown' };
}

function notifySlackBackground(message) {
  const webhook = process.env.SLACK_WEBHOOK_URL || '';
  const token = process.env.SLACK_BOT_TOKEN || '';
  const channel = process.env.SLACK_CHANNEL || '';
  if (webhook) {
    return postJson(webhook, { text: message }, () => {});
  }
  if (token && channel) {
    const form = new URLSearchParams({ channel, text: message });
    return postForm('https://slack.com/api/chat.postMessage', form, token, () => {});
  }
}

async function pollAllServicesOnce() {
  for (const svc of SERVICE_MONITORS) {
    try {
      const raw = await fetchJson(svc.url);
      const current = svc.type === 'local' ? normalizeFromLocal(raw) : normalizeFromStatuspage(raw);
      const prev = monitorLast.get(svc.name) || { state: 'unknown', startedAt: null };

      let dedupeKey = getDedupeKey(svc);
      if (current && current.incidentId) {
        dedupeKey = `${dedupeKey}#${String(current.incidentId).trim()}`;
      }
      const persisted = getMonitorPersist(dedupeKey);

      // Incident handling with dedupe by startedAt
      if (current.state === 'incident') {
        const startedAt = current.startedAt || persisted.startedAt || new Date().toISOString();
        monitorLast.set(svc.name, { state: 'incident', severity: current.severity || 'minor', startedAt });

        // Notify only once per incident startAt
        if (persisted.lastNotifiedStartAt !== startedAt) {
          const started = new Date(startedAt).toLocaleString();
          const emoji = (current.severity === 'critical') ? ':red_circle:' : ':large_yellow_circle:';
          const title = current.title || 'Incident detected';
          const link = svc.statusUrl ? `\nStatus: ${svc.statusUrl}` : '';
          notifySlackBackground(`${emoji} ${svc.name}: ${title}\nStarted: ${started}${link}`);
          setMonitorPersist(dedupeKey, { state: 'incident', startedAt, lastNotifiedStartAt: startedAt, lastNotifiedResolveAt: null });
        } else {
          // Keep state up to date without notifying
          setMonitorPersist(dedupeKey, { state: 'incident', startedAt });
        }
        continue;
      }

      // Resolution handling: notify once when transitioning from incident
      if (current.state === 'operational') {
        if (persisted.state === 'incident' && persisted.startedAt && persisted.lastNotifiedResolveAt !== persisted.startedAt) {
          const ended = new Date().toLocaleString();
          const startedStr = new Date(persisted.startedAt).toLocaleString();
          const link = svc.statusUrl ? `\nStatus: ${svc.statusUrl}` : '';
          notifySlackBackground(`:white_check_mark: ${svc.name} back to normal\nStarted: ${startedStr}\nResolved: ${ended}${link}`);
          monitorLast.set(svc.name, { state: 'operational', startedAt: null });
          setMonitorPersist(dedupeKey, { state: 'operational', startedAt: null, lastNotifiedResolveAt: persisted.startedAt });
          continue;
        }
        // Keep state current without duplicate notifications
        if (prev.state !== 'operational') {
          monitorLast.set(svc.name, { state: 'operational', startedAt: null });
        }
        setMonitorPersist(dedupeKey, { state: 'operational' });
        continue;
      }

      // Unknown or other states: update cache only
      if (prev.state !== current.state) {
        monitorLast.set(svc.name, { state: current.state, startedAt: null });
      }
      setMonitorPersist(dedupeKey, { state: current.state });
    } catch (_) {
      // ignore errors per service to avoid blocking the loop
    }
  }
}

// Local background monitor is disabled by default to avoid duplicate Slack notifications
// Enable explicitly by running with ENABLE_LOCAL_MONITOR=1
if (process.env.ENABLE_LOCAL_MONITOR === '1') {
  pollAllServicesOnce();
  setInterval(pollAllServicesOnce, 5 * 60 * 1000);
}

function notifySlack(req, res) {
  if (req.method !== 'POST') return send(res, 405, 'Method Not Allowed');

  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || '';
  const slackBotToken = process.env.SLACK_BOT_TOKEN || '';
  const slackChannel = process.env.SLACK_CHANNEL || '';

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const payload = JSON.parse(body || '{}');
      const text = formatSlackMessage(payload);

      if (slackWebhookUrl) {
        return postJson(slackWebhookUrl, { text }, (ok, status, resp) => {
          if (!ok) return send(res, 502, `Slack webhook http error: ${status}`);
          // Incoming webhooks return 'ok' on success; some apps return 2xx with body
          const body = (resp || '').trim().toLowerCase();
          if (body && body !== 'ok') {
            return send(res, 502, `Slack webhook response: ${resp}`);
          }
          return send(res, 200, 'OK');
        });
      }

      if (slackBotToken && slackChannel) {
        const form = new URLSearchParams({ channel: slackChannel, text });
        return postForm('https://slack.com/api/chat.postMessage', form, slackBotToken, (ok, status, resp) => {
          if (!ok) return send(res, 502, `Slack API http error: ${status}`);
          try {
            const parsed = JSON.parse(resp || '{}');
            if (parsed && parsed.ok) return send(res, 200, 'OK');
            const err = parsed && parsed.error ? parsed.error : 'unknown_error';
            return send(res, 502, `Slack API error: ${err}`);
          } catch (_) {
            return send(res, 502, `Slack API parse error`);
          }
        });
      }

      // Not configured → no-op success to avoid client errors
      return send(res, 204, 'Slack disabled');
    } catch (e) {
      return send(res, 400, 'Bad Request');
    }
  });
}

function slackEnabled(res) {
  const enabled = Boolean(process.env.SLACK_WEBHOOK_URL) || (Boolean(process.env.SLACK_BOT_TOKEN) && Boolean(process.env.SLACK_CHANNEL));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ enabled }));
}

function getState(res) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(statusStore));
}

function webhookStatuspage(req, res) {
  const parsed = url.parse(req.url, true);
  const key = parsed.query.key;
  if (!key) return send(res, 400, 'Missing key');
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch (_) {
      try { payload = Object.fromEntries(new URLSearchParams(raw)); } catch (_) {}
    }
    // Statuspage webhook: incident.impact and incident.status
    let result = { state: 'unknown', source: 'webhook-statuspage' };
    const inc = payload.incident || payload.data || {};
    if (inc && inc.status) {
      if (inc.status === 'resolved') {
        result = { state: 'operational', source: 'webhook-statuspage' };
      } else {
        const impact = (inc.impact || inc.impact_override || '').toLowerCase();
        const severity = (impact === 'critical' || impact === 'major') ? 'critical' : 'minor';
        result = { state: 'incident', severity, title: inc.name || 'Incident', source: 'webhook-statuspage' };
      }
    }
    updateStore(key, result);
    return send(res, 204, '');
  });
}

function webhookStatusgator(req, res) {
  const parsed = url.parse(req.url, true);
  const key = parsed.query.key;
  if (!key) return send(res, 400, 'Missing key');
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch (_) {}
    
    // Get previous state to detect transitions
    const previous = statusStore[key] || { state: 'unknown' };
    
    // Extract title from StatusGator's component_status_changes or fallback to title/summary
    let title = payload.title || payload.summary || 'Incident';
    if (Array.isArray(payload.component_status_changes) && payload.component_status_changes.length > 0) {
      const components = payload.component_status_changes
        .filter(c => c.current_status === 'down' || c.current_status === 'warn' || c.current_status === 'degraded')
        .map(c => c.name);
      if (components.length > 0) {
        title = components.join(', ');
      }
    }
    
    // StatusGator payloads vary; normalize common fields
    const status = (payload.status || payload.current_status || '').toLowerCase();
    let result = { state: 'unknown', source: 'webhook-statusgator' };
    
    if (['up','operational','ok'].includes(status)) {
      result = { state: 'operational', source: 'webhook-statusgator' };
      
      // Send resolution notification if transitioning from incident
      if (previous.state === 'incident' && previous.title) {
        const serviceName = key.includes('apple') ? 'Apple Developer Services' : 'Service';
        const ended = new Date().toLocaleString();
        const link = key ? `\nStatus: ${key}` : '';
        notifySlackBackground(`:white_check_mark: ${serviceName} back to normal — ${previous.title}\nResolved: ${ended}${link}`);
      }
    } else if (status) {
      const criticalWords = ['down','outage','major','critical'];
      const severity = criticalWords.some(w => status.includes(w)) ? 'critical' : 'minor';
      result = { state: 'incident', severity, title, source: 'webhook-statusgator' };
      
      // Send incident notification if this is a new incident or severity changed
      if (previous.state !== 'incident' || previous.title !== title || previous.severity !== severity) {
        const serviceName = key.includes('apple') ? 'Apple Developer Services' : 'Service';
        const emoji = severity === 'critical' ? ':red_circle:' : ':large_yellow_circle:';
        const started = new Date().toLocaleString();
        const link = key ? `\nStatus: ${key}` : '';
        const detail = payload.summary ? `\n${payload.summary}` : '';
        notifySlackBackground(`${emoji} ${serviceName}: ${title}\nStarted: ${started}${detail}${link}`);
      }
    }
    
    updateStore(key, result);
    return send(res, 204, '');
  });
}

async function firebaseStatus(req, res) {
  // Query Firebase products and incidents, then return a concise status for selected products
  try {
    const getJson = (u) => new Promise((resolve, reject) => {
      const lib = u.startsWith('http:') ? http : https;
      lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'application/json' } }, (r) => {
        const b = [];
        r.on('data', c => b.push(c));
        r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b).toString('utf8'))); } catch (e) { reject(e); } });
      }).on('error', reject);
    });

    const products = await getJson('https://status.firebase.google.com/products.json');
    const incidents = await getJson('https://status.firebase.google.com/incidents.json');

    const idByTitle = Object.fromEntries((products.products || []).map(p => [p.title.toLowerCase(), p.id]));
    // Fix Remote Config id if different
    const remoteConfigId = idByTitle['remote config'] || idByTitle['remoteconfig'] || '5AgCVXiY8zJMBbruVrm8';
    const authId = idByTitle['authentication'] || 'ty5dcfcAmf92kaN1vKuj';
    const crashId = idByTitle['crashlytics'] || 'BevPfAqaWeJzx9e2SWic';
    const selected = new Set([authId, remoteConfigId, crashId]);

    const active = [];
    for (const inc of incidents) {
      if (inc.end) continue; // only active
      // Some records use affected_products: [{id,title}], some use products: [id]
      let pids = [];
      if (Array.isArray(inc.affected_products)) pids = inc.affected_products.map(p => p.id);
      if (Array.isArray(inc.products)) pids = pids.concat(inc.products);
      const related = pids.filter(pid => selected.has(pid));
      if (related.length) {
        const lastUpdate = Array.isArray(inc.updates) && inc.updates.length > 0 ? inc.updates[inc.updates.length - 1] : null;
        const title = inc.external_desc || (lastUpdate && lastUpdate.text) || 'Active incident';
        const impact = (inc.status_impact || '').toLowerCase();
        const severity = /outage|high/.test(impact) ? 'critical' : 'minor';
        active.push({ title, products: related, severity });
      }
    }

    const result = active.length ? { state: 'incident', severity: active[0].severity, title: active[0].title } : { state: 'operational' };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
  } catch (e) {
    send(res, 502, 'Firebase status fetch error');
  }
}

async function appleAppStoreStatus(req, res) {
  try {
    // Check both consumer AND developer status pages
    const fetchText = (u) => new Promise((resolve, reject) => {
      const lib = u.startsWith('http:') ? http : https;
      lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'text/html,*/*' } }, (r) => {
        const b = [];
        r.on('data', c => b.push(c));
        r.on('end', () => resolve(Buffer.concat(b).toString('utf8')));
      }).on('error', reject);
    });

    let consumerIncident = null;
    let developerIncident = null;
    
    // Check consumer services
    try {
      let body = await fetchText('https://www.apple.com/support/systemstatus/data/system_status_en_US.json');
      let data;
      try {
        data = JSON.parse(body);
      } catch (_) {
        body = await fetchText('https://www.apple.com/support/systemstatus/data/system_status_en_US.js');
        const start = body.indexOf('{');
        const end = body.lastIndexOf('}');
        if (start >= 0 && end > start) data = JSON.parse(body.slice(start, end + 1));
      }
      if (data && Array.isArray(data.services)) {
        const target = new Set(['app store', 'app store connect']);
        const now = Date.now();
        for (const svc of data.services) {
          const name = String(svc.serviceName || '').toLowerCase();
          if (!target.has(name)) continue;
          const events = Array.isArray(svc.events) ? svc.events : [];
          const active = events.find(e => {
            const status = String(e.eventStatus || '').toLowerCase();
            const msg = String(e.message || e.userFacingStatus || '').toLowerCase();
            const startMs = e.startDate ? Date.parse(e.startDate) : NaN;
            const started = Number.isFinite(startMs) ? (startMs <= now + 60 * 1000) : true;
            const hasEnded = Boolean(e.endDate);
            const isResolvedLike = /resolved|completed|restored|normal/.test(status) || /resolved|completed|restored|normal/.test(msg);
            if (!started || isResolvedLike || hasEnded) return false;
            return true;
          });
          if (active) {
            consumerIncident = { service: svc.serviceName, detail: active.message || active.userFacingStatus || active.eventStatus || '' };
            break;
          }
        }
      }
    } catch (_) {}
    
    // Check developer services (best-effort HTML pattern matching)
    try {
      const html = await fetchText('https://developer.apple.com/system-status/');
      const plain = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      const hasOutage = /outage|service\s+(down|unavailable|disruption)|critical\s+issue/i.test(plain);
      const hasIssue = /\bissue\b|degraded|partial|problem|experiencing\s+issues/i.test(plain);
      const hasIncidentKeyword = /incident|disruption|affected/i.test(plain);
      
      const extractService = () => {
        const patterns = [
          /app\s+store\s*-\s*in-app\s+purchase[s]?[^a-z]*(?:outage|issue|down|unavailable|degraded|incident)/i,
          /in-app\s+purchase[s]?[^a-z]*(?:outage|issue|down|unavailable|degraded|incident)/i,
          /app\s+store\s+connect[^a-z]*(?:outage|issue|down|unavailable|degraded|incident)/i,
          /apns[^a-z]*(?:outage|issue|down|unavailable|degraded|incident)/i,
        ];
        for (const pattern of patterns) {
          const match = plain.match(pattern);
          if (match) {
            const serviceMatch = match[0].match(/^[^:]+/i);
            return serviceMatch ? serviceMatch[0].trim() : null;
          }
        }
        return null;
      };
      
      const serviceName = extractService();
      
      if ((hasOutage || (hasIssue && hasIncidentKeyword)) && serviceName) {
        developerIncident = {
          service: serviceName,
          severity: hasOutage ? 'critical' : 'minor',
          detail: plain.split(/[.!?]/).find(s => new RegExp(serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(s))?.trim().slice(0, 200) || ''
        };
      }
    } catch (_) {}
    
    const incident = developerIncident || consumerIncident;
    
    let result;
    if (incident) {
      const title = incident.service ? `${incident.service}${incident.detail ? ': ' + incident.detail.slice(0, 100) : ''}` : 'Apple Services Incident';
      result = { 
        state: 'incident', 
        severity: incident.severity || 'minor', 
        title,
        detail: incident.detail || undefined,
        startedAt: new Date().toISOString()
      };
    } else {
      result = { state: 'operational' };
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
  } catch (e) {
    send(res, 502, 'Apple status fetch error');
  }
}

async function facebookStatus(req, res) {
  try {
    const fetchText = (u) => new Promise((resolve, reject) => {
      const lib = u.startsWith('http:') ? http : https;
      lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'text/html,*/*' } }, (r) => {
        const b = [];
        r.on('data', c => b.push(c));
        r.on('end', () => resolve(Buffer.concat(b).toString('utf8')));
      }).on('error', reject);
    });

    const body = await fetchText('https://metastatus.com/');
    const plain = body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const text = plain.toLowerCase();
    const hasAllOperational = /all systems operational|no incidents reported|no known issues/i.test(plain) || /operational\s*$/.test(text);
    const hasInvestigating = /(investigating|identified|monitoring|ongoing|current incident)/i.test(plain);
    const hasResolved = /(resolved|has been resolved|issue (?:is|was) resolved|restored|closed|ended|back to normal)/i.test(plain);
    const hasCritical = /(major outage|critical outage|service (outage|down)|widespread disruption)/i.test(plain);
    const hasMinor = /(partial outage|degraded performance|degradation|disruption)/i.test(plain);

    const extractSnippet = () => {
      const sentences = plain.split(/(?<=[.!?])\s+/);
      const idx = sentences.findIndex(s => /outage|incident|degrad|disruption|unavail|resolved|restored|closed/i.test(s));
      return idx >= 0 ? sentences[idx].trim().slice(0, 240) : '';
    };

    let result;
    if (hasAllOperational) {
      result = { state: 'operational' };
    } else if (hasInvestigating && (hasCritical || hasMinor)) {
      result = { state: 'incident', severity: hasCritical ? 'critical' : 'minor', title: extractSnippet() || (hasCritical ? 'Detected outage from Meta Status' : 'Detected degraded service from Meta Status') };
    } else if ((hasCritical || hasMinor) && hasResolved) {
      result = { state: 'operational', lastIncident: { title: extractSnippet(), endedAt: null } };
    } else if (hasCritical || hasMinor) {
      result = { state: 'operational', lastIncident: { title: extractSnippet(), endedAt: null } };
    } else {
      result = { state: 'operational' };
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
  } catch (e) {
    send(res, 502, 'Facebook status fetch error');
  }
}

async function googlePlayStatus(req, res) {
  try {
    const fetchText = (u) => new Promise((resolve, reject) => {
      const lib = u.startsWith('http:') ? http : https;
      lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'text/html,*/*' } }, (r) => {
        const b = [];
        r.on('data', c => b.push(c));
        r.on('end', () => resolve(Buffer.concat(b).toString('utf8')));
      }).on('error', reject);
    });

    const body = await fetchText('https://status.play.google.com/');
    const plain = body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const text = plain.toLowerCase();
    const hasMajor = /(major outage|critical|service (outage|down)|unavailable)/i.test(plain);
    const hasMinor = /(partial outage|degraded|degradation|incident|maintenance)/i.test(plain);
    const hasResolved = /(resolved|has been resolved|issue (?:is|was) resolved|restored|closed|ended)/i.test(plain);
    const hasInvestigating = /(investigating|identified|monitoring|ongoing|in progress|mitigating)/i.test(plain);
    const hasAllOperational = /all systems operational|no incidents reported|no known issues/i.test(plain) || /operational\s*$/.test(text);

    const extractSnippet = () => {
      const sentences = plain.split(/(?<=[.!?])\s+/);
      const idx = sentences.findIndex(s => /outage|incident|degrad|disruption|unavail|maintenance|resolved|restored/i.test(s));
      return idx >= 0 ? sentences[idx].trim().slice(0, 240) : '';
    };

    let result;
    if (hasAllOperational) {
      result = { state: 'operational' };
    } else if ((hasMajor || hasMinor) && hasInvestigating) {
      result = { state: 'incident', severity: hasMajor ? 'critical' : 'minor', title: extractSnippet() || (hasMajor ? 'Detected outage from Google Play Status' : 'Detected degraded service from Google Play Status') };
    } else if ((hasMajor || hasMinor) && hasResolved) {
      result = { state: 'operational', lastIncident: { title: extractSnippet(), endedAt: null } };
    } else if (hasMajor || hasMinor) {
      // Default to operational with a lastIncident if no evidence of ongoing state
      result = { state: 'operational', lastIncident: { title: extractSnippet(), endedAt: null } };
    } else {
      result = { state: 'operational' };
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
  } catch (e) {
    send(res, 502, 'Google Play status fetch error');
  }
}

async function googleCloudStatus(req, res) {
  try {
    const fetchText = (u) => new Promise((resolve, reject) => {
      const lib = u.startsWith('http:') ? http : https;
      lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'text/html,*/*' } }, (r) => {
        const b = [];
        r.on('data', c => b.push(c));
        r.on('end', () => resolve(Buffer.concat(b).toString('utf8')));
      }).on('error', reject);
    });

    const body = await fetchText('https://status.cloud.google.com/');
    const plain = body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const text = plain.toLowerCase();
    // Guard against generic marketing text wrongly triggering incidents
    const sanitized = plain.replace(/See incidents that impact your workloads[\s\S]*?projects,?\s+including[\s\S]*?logs\./i, ' ');
    const hasMajor = /(major outage|critical|service (outage|down)|incident impacting multiple regions|service disruption)/i.test(sanitized);
    const hasMinor = /(partial outage|degraded|degradation|disruption)/i.test(sanitized);
    const hasResolved = /(resolved|has been resolved|issue (?:is|was) resolved|restored|closed|ended)/i.test(sanitized);
    const hasInvestigating = /(investigating|identified|monitoring|ongoing|in progress|mitigating|current incident)/i.test(sanitized);
    const hasAllOperational = /all services available|no incidents reported|no known issues|all systems operational/i.test(sanitized) || /operational\s*$/.test(text);

    const extractSnippet = () => {
      const sentences = sanitized.split(/(?<=[.!?])\s+/);
      const idx = sentences.findIndex(s => /outage|incident|degrad|disruption|unavail|maintenance|resolved|restored/i.test(s));
      return idx >= 0 ? sentences[idx].trim().slice(0, 240) : '';
    };

    let result;
    if (hasAllOperational) {
      result = { state: 'operational' };
    } else if ((hasMajor || hasMinor) && hasInvestigating) {
      result = { state: 'incident', severity: hasMajor ? 'critical' : 'minor', title: extractSnippet() || (hasMajor ? 'Detected outage from Google Cloud Status' : 'Detected degraded service from Google Cloud Status') };
    } else if ((hasMajor || hasMinor) && hasResolved) {
      result = { state: 'operational', lastIncident: { title: extractSnippet(), endedAt: null } };
    } else if (hasMajor || hasMinor) {
      result = { state: 'operational', lastIncident: { title: extractSnippet(), endedAt: null } };
    } else {
      result = { state: 'operational' };
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
  } catch (e) {
    send(res, 502, 'Google Cloud status fetch error');
  }
}

async function mixpanelStatus(req, res) {
  try {
    const getJson = (u) => new Promise((resolve, reject) => {
      const lib = u.startsWith('http:') ? http : https;
      lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'application/json' } }, (r) => {
        const b = []; r.on('data', c => b.push(c)); r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b).toString('utf8'))); } catch(e){ reject(e); } });
      }).on('error', reject);
    });

    try {
      const summary = await getJson('https://status.mixpanel.com/api/v2/summary.json');
      if (summary) {
        if (Array.isArray(summary.incidents) && summary.incidents.length > 0) {
          const active = summary.incidents.find(i => i.status !== 'resolved');
          if (active) {
            const impact = (active.impact || active.impact_override || 'minor').toLowerCase();
            const severity = (impact === 'critical' || impact === 'major') ? 'critical' : 'minor';
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ state: 'incident', severity, title: active.name || 'Service Incident' }));
          }
        }
        if (Array.isArray(summary.scheduled_maintenances) && summary.scheduled_maintenances.length > 0) {
          const maint = summary.scheduled_maintenances.find(m => m.status !== 'completed');
          if (maint) {
            const impact = (maint.impact || maint.impact_override || 'minor').toLowerCase();
            const severity = (impact === 'critical' || impact === 'major') ? 'critical' : 'minor';
            const eta = maint.scheduled_until || maint.scheduled_end || maint.scheduled_for || null;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ state: 'incident', severity, title: maint.name || 'Scheduled maintenance', eta }));
          }
        }
      }
    } catch (_) {}

    try {
      const status = await getJson('https://status.mixpanel.com/api/v2/status.json');
      const indicator = status && status.status && String(status.status.indicator || '').toLowerCase();
      if (indicator === 'none') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ state: 'operational' }));
      }
      if (indicator === 'minor') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ state: 'incident', severity: 'minor', title: status.status.description || 'Service Incident' }));
      }
      if (indicator === 'major' || indicator === 'critical') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ state: 'incident', severity: 'critical', title: status.status.description || 'Service Incident' }));
      }
    } catch (_) {}

    const html = await new Promise((resolve, reject) => {
      https.get('https://status.mixpanel.com/', { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'text/html,*/*' } }, (r) => {
        const b = []; r.on('data', c => b.push(c)); r.on('end', () => resolve(Buffer.concat(b).toString('utf8')));
      }).on('error', reject);
    });
    const plain = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    const hasMajor = /(major outage|critical|service (outage|down))/i.test(plain);
    const hasMinor = /(partial outage|degraded|degradation|incident|maintenance)/i.test(plain);
    const result = hasMajor ? { state: 'incident', severity: 'critical', title: 'Detected incident' } : hasMinor ? { state: 'incident', severity: 'minor', title: 'Detected incident' } : { state: 'operational' };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(result));
  } catch (_) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ state: 'unknown' }));
  }
}

async function slackStatus(req, res) {
  try {
    const getJson = (u) => new Promise((resolve, reject) => {
      const lib = u.startsWith('http:') ? http : https;
      lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'application/json; charset=utf-8', 'Accept-Encoding': 'identity' } }, (r) => {
        const b = []; r.on('data', c => b.push(c)); r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b).toString('utf8'))); } catch(e){ reject(e); } });
      }).on('error', reject);
    });

    try {
      const data = await getJson('https://status.slack.com/api/v2.0.0/current');
      if (data && Array.isArray(data.active_incidents) && data.active_incidents.length > 0) {
        const inc = data.active_incidents[0];
        const title = inc.title || inc.name || 'Service Incident';
        const isCritical = (inc.type && String(inc.type).toLowerCase().includes('outage')) || /outage|down|unavailable/i.test(title);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ state: 'incident', severity: isCritical ? 'critical' : 'minor', title, eta: inc.date_end || inc.resolution_time || null }));
      }
      if (data && Array.isArray(data.active_incidents) && data.active_incidents.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ state: 'operational' }));
      }
      if (data && typeof data.status === 'string') {
        const s = data.status.toLowerCase();
        if (s === 'ok') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ state: 'operational' }));
        }
        if (s === 'active') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ state: 'incident', severity: 'minor', title: 'Active incident' }));
        }
      }
    } catch (_) {}

    // HTML fallback, never assume green on inconclusive
    const html = await new Promise((resolve, reject) => {
      https.get('https://status.slack.com/', { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'text/html,*/*' } }, (r) => {
        const b = []; r.on('data', c => b.push(c)); r.on('end', () => resolve(Buffer.concat(b).toString('utf8')));
      }).on('error', reject);
    });
    const plain = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    const text = plain.toLowerCase();
    const allOk = /all systems operational|no incidents reported|no known issues/i.test(plain) || /operational\s*$/.test(text);
    const hasCritical = /(major outage|critical outage|service (outage|down)|widespread disruption)/i.test(plain);
    const hasMinor = /(partial outage|degraded performance|degradation|incident|maintenance|investigating|identified|monitoring)/i.test(plain);
    if (allOk) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ state: 'operational' }));
    }
    if (hasCritical) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ state: 'incident', severity: 'critical', title: 'Detected outage from Slack Status' }));
    }
    if (hasMinor) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ state: 'incident', severity: 'minor', title: 'Detected degraded service from Slack Status' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ state: 'unknown' }));
  } catch (_) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ state: 'unknown' }));
  }
}

function postJson(target, json, cb) {
  const u = new URL(target);
  const lib = u.protocol === 'http:' ? http : https;
  const req = lib.request(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'ServiceStatusDashboard/1.0' },
  }, (resp) => {
    const chunks = [];
    resp.on('data', (c) => chunks.push(c));
    resp.on('end', () => cb((resp.statusCode || 0) >= 200 && (resp.statusCode || 0) < 300, resp.statusCode, Buffer.concat(chunks).toString('utf8')));
  });
  req.on('error', () => cb(false, 0, ''));
  req.end(JSON.stringify(json));
}

function postForm(target, form, token, cb) {
  const u = new URL(target);
  const lib = u.protocol === 'http:' ? http : https;
  const req = lib.request(u, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'ServiceStatusDashboard/1.0',
    },
  }, (resp) => {
    const chunks = [];
    resp.on('data', (c) => chunks.push(c));
    resp.on('end', () => cb((resp.statusCode || 0) >= 200 && (resp.statusCode || 0) < 300, resp.statusCode, Buffer.concat(chunks).toString('utf8')));
  });
  req.on('error', () => cb(false, 0, ''));
  req.end(form.toString());
}

function formatSlackMessage(p) { return utils.formatSlackMessage(p); }

function checkHtmlStatus(req, res) {
  const parsed = url.parse(req.url, true);
  const target = parsed.query.url;
  if (!target) return send(res, 400, 'Missing url');
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return send(res, 400, 'Invalid url');
  }
  utils.analyzeHtmlFromUrl(targetUrl.href)
    .then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(result));
    })
    .catch((err) => {
      console.error('HTML check error', targetUrl.href, err && err.code, err && err.message);
      send(res, 502, 'Upstream error');
    });
}


