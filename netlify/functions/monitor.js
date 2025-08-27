'use strict';

const http = require('http');
const https = require('https');
const utils = require('../../lib/status-utils');
let netlifyBlobs = null;
try { netlifyBlobs = require('@netlify/blobs'); } catch (_) { netlifyBlobs = null; }

const COOLDOWN_MINUTES = Number(process.env.NOTIFY_COOLDOWN_MINUTES || '180'); // default 3h
const RESET_UNKNOWN_MINUTES = Number(process.env.RESET_UNKNOWN_MINUTES || '60'); // reset incident after 60m of non-incident/unknown

async function getLastNotifiedTs(key) {
  const now = Date.now();
  const k = `notify:${key}`;
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore('status-notify');
      const val = await store.get(k, { type: 'text' });
      const ts = val ? Number(val) : 0;
      return Number.isFinite(ts) ? ts : 0;
    }
  } catch (_) {}
  globalThis.__NOTIFY_LAST__ = globalThis.__NOTIFY_LAST__ || {};
  return globalThis.__NOTIFY_LAST__[k] || 0;
}

async function setLastNotifiedTs(key, ts) {
  const k = `notify:${key}`;
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore('status-notify');
      await store.set(k, String(ts));
      return;
    }
  } catch (_) {}
  globalThis.__NOTIFY_LAST__ = globalThis.__NOTIFY_LAST__ || {};
  globalThis.__NOTIFY_LAST__[k] = ts;
}

// Persisted incident state to ensure we alert only once per continuous incident
async function getPersistedState(key) {
  const k = `state:${key}`;
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore('status-notify');
      const val = await store.get(k, { type: 'text' });
      if (!val) return { state: 'unknown', startedAt: null, lastNonIncidentTs: 0 };
      try {
        const parsed = JSON.parse(val);
        return {
          state: parsed.state || 'unknown',
          startedAt: parsed.startedAt || null,
          lastNonIncidentTs: Number(parsed.lastNonIncidentTs || 0),
        };
      } catch (_) {
        return { state: 'unknown', startedAt: null, lastNonIncidentTs: 0 };
      }
    }
  } catch (_) {}
  globalThis.__NOTIFY_STATE__ = globalThis.__NOTIFY_STATE__ || {};
  return globalThis.__NOTIFY_STATE__[k] || { state: 'unknown', startedAt: null, lastNonIncidentTs: 0 };
}

async function setPersistedState(key, value) {
  const k = `state:${key}`;
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore('status-notify');
      await store.set(k, JSON.stringify(value));
      return;
    }
  } catch (_) {}
  globalThis.__NOTIFY_STATE__ = globalThis.__NOTIFY_STATE__ || {};
  globalThis.__NOTIFY_STATE__[k] = value;
}

function getDedupeKey(svc) {
  let base = (svc && svc.statusUrl) ? String(svc.statusUrl) : String(svc && svc.name || '');
  if (base.endsWith('/')) base = base.slice(0, -1);
  return base.toLowerCase();
}

function getJson(u) { return utils.fetchJson(u); }

function normalizeFromLocal(data) {
  if (data && typeof data.state === 'string') {
    return { state: data.state, severity: data.severity || 'minor', title: data.title || null, startedAt: data.startedAt || null };
  }
  return { state: 'unknown' };
}

function normalizeFromStatuspage(summary) { return utils.parseStatuspageSummary(summary); }

function notifySlackBackground(message) {
  const webhook = process.env.SLACK_WEBHOOK_URL || '';
  const token = process.env.SLACK_BOT_TOKEN || '';
  const channel = process.env.SLACK_CHANNEL || '';
  if (webhook) {
    return new Promise((resolve) => {
      const u = new URL(webhook);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ServiceStatusDashboard/1.0' } }, (r) => {
        r.on('data', ()=>{}); r.on('end', resolve);
      });
      req.on('error', resolve);
      req.end(JSON.stringify({ text: message }));
    });
  }
  if (token && channel) {
    return new Promise((resolve) => {
      const u = new URL('https://slack.com/api/chat.postMessage');
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': `Bearer ${token}`, 'User-Agent': 'ServiceStatusDashboard/1.0' } }, (r) => {
        r.on('data', ()=>{}); r.on('end', resolve);
      });
      req.on('error', resolve);
      req.end(JSON.stringify({ channel, text: message }));
    });
  }
  return Promise.resolve();
}

exports.handler = async () => {
  const base = process.env.URL || 'https://3rd-party-services.netlify.app';
  const services = [
    { name: 'Google Play Store', type: 'local', url: `${base}/.netlify/functions/api/google/play-status`, statusUrl: 'https://status.play.google.com/' },
    { name: 'Google Play Services', type: 'local', url: `${base}/.netlify/functions/api/google/play-status`, statusUrl: 'https://status.play.google.com/' },
    { name: 'Apple App Store', type: 'local', url: `${base}/.netlify/functions/api/apple/status`, statusUrl: 'https://developer.apple.com/system-status/' },
    { name: 'Firebase', type: 'local', url: `${base}/.netlify/functions/api/firebase/status`, statusUrl: 'https://status.firebase.google.com/' },
    { name: 'Mixpanel', type: 'local', url: `${base}/.netlify/functions/api/mixpanel/status`, statusUrl: 'https://status.mixpanel.com/' },
    { name: 'Singular', type: 'statuspage', url: 'https://status.singular.net/api/v2/summary.json', statusUrl: 'https://status.singular.net/' },
    { name: 'Sentry', type: 'statuspage', url: 'https://status.sentry.io/api/v2/summary.json', statusUrl: 'https://status.sentry.io/' },
    { name: 'Unity LevelPlay', type: 'local', url: `${base}/.netlify/functions/api/check-html?url=https://status.unity.com/`, statusUrl: 'https://status.unity.com/' },
    { name: 'Facebook Audience Network', type: 'local', url: `${base}/.netlify/functions/api/facebook/status`, statusUrl: 'https://metastatus.com/' },
    { name: 'Google AdMob', type: 'local', url: `${base}/.netlify/functions/api/google/cloud-status`, statusUrl: 'https://status.cloud.google.com/' },
    { name: 'Unity Ads', type: 'local', url: `${base}/.netlify/functions/api/check-html?url=https://status.unity.com/`, statusUrl: 'https://status.unity.com/' },
    { name: 'Unity Cloud Services', type: 'local', url: `${base}/.netlify/functions/api/check-html?url=https://status.unity.com/`, statusUrl: 'https://status.unity.com/' },
    { name: 'Realm Database', type: 'statuspage', url: 'https://status.mongodb.com/api/v2/summary.json', statusUrl: 'https://status.mongodb.com/' },
    { name: 'Slack', type: 'local', url: `${base}/.netlify/functions/api/slack/status`, statusUrl: 'https://status.slack.com/' },
    { name: 'Notion', type: 'statuspage', url: 'https://www.notion-status.com/api/v2/summary.json', statusUrl: 'https://www.notion-status.com/' },
    { name: 'Figma', type: 'statuspage', url: 'https://status.figma.com/api/v2/summary.json', statusUrl: 'https://status.figma.com/' },
    { name: 'Jira Software', type: 'statuspage', url: 'https://jira-software.status.atlassian.com/api/v2/summary.json', statusUrl: 'https://jira-software.status.atlassian.com/' },
  ];

  // Warm-instance ephemeral memory to reduce duplicates between runs in the same container
  globalThis.__MONITOR_LAST__ = globalThis.__MONITOR_LAST__ || {};
  const last = globalThis.__MONITOR_LAST__;

  const sentThisRun = new Set();
  for (const svc of services) {
    try {
      const raw = await getJson(svc.url);
      const current = svc.type === 'local' ? normalizeFromLocal(raw) : normalizeFromStatuspage(raw);
      const prev = last[svc.name] || { state: 'unknown', startedAt: null };
      const dedupeKey = getDedupeKey(svc);
      const persisted = await getPersistedState(dedupeKey);
      const nowTs = Date.now();

      // Entering incident (persisted state says we were not in incident)
      if (current.state === 'incident' && persisted.state !== 'incident') {
        const startedAt = current.startedAt || new Date().toISOString();
        last[svc.name] = { state: 'incident', severity: current.severity || 'minor', startedAt };
        if (!sentThisRun.has(dedupeKey)) {
          const started = new Date(startedAt).toLocaleString();
          const emoji = (current.severity === 'critical') ? ':red_circle:' : ':large_yellow_circle:';
          const title = current.title || 'Incident detected';
          const link = svc.statusUrl ? `\nStatus: ${svc.statusUrl}` : '';
          await notifySlackBackground(`${emoji} ${svc.name}: ${title}\nStarted: ${started}${link}`);
          sentThisRun.add(dedupeKey);
        }
        await setPersistedState(dedupeKey, { state: 'incident', startedAt, lastNonIncidentTs: 0 });
        continue;
      }

      // Returning to operational (persisted incident → operational)
      if (current.state === 'operational' && persisted.state === 'incident') {
        const ended = new Date().toLocaleString();
        const started = (persisted.startedAt ? new Date(persisted.startedAt) : (prev.startedAt ? new Date(prev.startedAt) : null));
        const startedStr = started ? started.toLocaleString() : 'Unknown';
        const link = svc.statusUrl ? `\nStatus: ${svc.statusUrl}` : '';
        await notifySlackBackground(`:white_check_mark: ${svc.name} back to normal\nStarted: ${startedStr}\nResolved: ${ended}${link}`);
        last[svc.name] = { state: 'operational', startedAt: null };
        await setPersistedState(dedupeKey, { state: 'operational', startedAt: null, lastNonIncidentTs: nowTs });
        continue;
      }

      // Keep in-memory state in sync; also normalize persisted "unknown" → "operational"
      if (prev.state !== current.state) {
        last[svc.name] = { state: current.state, startedAt: null };
      }
      // Track last time we observed non-incident (operational/unknown)
      if (current.state !== 'incident') {
        const lastNonIncidentTs = nowTs;
        await setPersistedState(dedupeKey, {
          state: persisted.state,
          startedAt: persisted.startedAt || null,
          lastNonIncidentTs,
        });
      }
      // Grace reset: if we stayed away from incident for long, reset persisted state
      if (persisted.state === 'incident' && persisted.lastNonIncidentTs) {
        const elapsed = nowTs - Number(persisted.lastNonIncidentTs || 0);
        if (elapsed >= RESET_UNKNOWN_MINUTES * 60 * 1000) {
          await setPersistedState(dedupeKey, { state: 'operational', startedAt: null, lastNonIncidentTs: nowTs });
        }
      }
    } catch (_) {
      // ignore per-service errors
    }
  }

  return { statusCode: 200, body: 'ok' };
};

exports.config = { schedule: '*/5 * * * *' };


