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
      const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
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
      const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
      await store.set(k, String(ts));
      return;
    }
  } catch (_) {}
  globalThis.__NOTIFY_LAST__ = globalThis.__NOTIFY_LAST__ || {};
  globalThis.__NOTIFY_LAST__[k] = ts;
}

// Persisted message signature per service to ensure idempotent posts
async function getLastSignature(key) {
  const k = `sig:${key}`;
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
      const val = await store.get(k, { type: 'text' });
      return val || '';
    }
  } catch (_) {}
  globalThis.__NOTIFY_SIG__ = globalThis.__NOTIFY_SIG__ || {};
  return globalThis.__NOTIFY_SIG__[k] || '';
}

async function setLastSignature(key, sig) {
  const k = `sig:${key}`;
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
      await store.set(k, String(sig || ''));
      return;
    }
  } catch (_) {}
  globalThis.__NOTIFY_SIG__ = globalThis.__NOTIFY_SIG__ || {};
  globalThis.__NOTIFY_SIG__[k] = String(sig || '');
}

// Persisted incident state to ensure we alert only once per continuous incident
async function getPersistedState(key) {
  const k = `state:${key}`;
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
      const val = await store.get(k, { type: 'text' });
      if (!val) return { state: 'unknown', startedAt: null, startKey: null, incidentId: null, lastNonIncidentTs: 0, lastNotifiedStartAt: null, lastNotifiedResolveAt: null, lastNotifiedStartKey: null, lastNotifiedResolveKey: null };
      try {
        const parsed = JSON.parse(val);
        return {
          state: parsed.state || 'unknown',
          startedAt: parsed.startedAt || null,
          startKey: parsed.startKey || null,
          incidentId: parsed.incidentId || null,
          lastNonIncidentTs: Number(parsed.lastNonIncidentTs || 0),
          lastNotifiedStartAt: parsed.lastNotifiedStartAt || null,
          lastNotifiedResolveAt: parsed.lastNotifiedResolveAt || null,
          lastNotifiedStartKey: parsed.lastNotifiedStartKey || null,
          lastNotifiedResolveKey: parsed.lastNotifiedResolveKey || null,
        };
      } catch (_) {
        return { state: 'unknown', startedAt: null, startKey: null, incidentId: null, lastNonIncidentTs: 0, lastNotifiedStartAt: null, lastNotifiedResolveAt: null, lastNotifiedStartKey: null, lastNotifiedResolveKey: null };
      }
    }
  } catch (_) {}
  globalThis.__NOTIFY_STATE__ = globalThis.__NOTIFY_STATE__ || {};
  return globalThis.__NOTIFY_STATE__[k] || { state: 'unknown', startedAt: null, startKey: null, incidentId: null, lastNonIncidentTs: 0, lastNotifiedStartAt: null, lastNotifiedResolveAt: null, lastNotifiedStartKey: null, lastNotifiedResolveKey: null };
}

async function setPersistedState(key, value) {
  const k = `state:${key}`;
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
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

exports.handler = async (event) => {
  // Optional test trigger: /.netlify/functions/monitor?test=1
  try {
    const qs = (event && event.queryStringParameters) || {};
    if (qs && (qs.test === '1' || qs.test === 'true')) {
      await notifySlackBackground(':mega: Monitor test ping — Netlify function is able to post to Slack');
      return { statusCode: 200, body: 'test-ok' };
    }
    if (qs && (qs.debug === '1' || qs.debug === 'true')) {
      const base = process.env.URL || 'https://3rd-party-services.netlify.app';
      const services = [
        { name: 'Google Play Store', type: 'local', url: `${base}/.netlify/functions/api/google/play-status`, statusUrl: 'https://status.play.google.com/' },
        { name: 'Google Play Services', type: 'local', url: `${base}/.netlify/functions/api/google/play-status`, statusUrl: 'https://status.play.google.com/' },
        { name: 'Apple App Store', type: 'local', url: `${base}/.netlify/functions/api/apple/status`, statusUrl: 'https://developer.apple.com/system-status/' },
        { name: 'Firebase', type: 'local', url: `${base}/.netlify/functions/api/firebase/status`, statusUrl: 'https://status.firebase.google.com/' },
        { name: 'Mixpanel', type: 'local', url: `${base}/.netlify/functions/api/mixpanel/status`, statusUrl: 'https://status.mixpanel.com/' },
        { name: 'Singular', type: 'statuspage', url: 'https://status.singular.net/api/v2/summary.json', statusUrl: 'https://status.singular.net/' },
        { name: 'Sentry', type: 'statuspage', url: 'https://status.sentry.io/api/v2/summary.json', statusUrl: 'https://status.sentry.io/' },
        { name: 'Facebook Audience Network', type: 'local', url: `${base}/.netlify/functions/api/facebook/status`, statusUrl: 'https://metastatus.com/' },
        { name: 'Google AdMob', type: 'local', url: `${base}/.netlify/functions/api/google/cloud-status`, statusUrl: 'https://status.cloud.google.com/' },
        { name: 'Realm Database', type: 'statuspage', url: 'https://status.mongodb.com/api/v2/summary.json', statusUrl: 'https://status.mongodb.com/' },
        { name: 'Slack', type: 'local', url: `${base}/.netlify/functions/api/slack/status`, statusUrl: 'https://status.slack.com/' },
        { name: 'Notion', type: 'statuspage', url: 'https://www.notion-status.com/api/v2/summary.json', statusUrl: 'https://www.notion-status.com/' },
        { name: 'Figma', type: 'statuspage', url: 'https://status.figma.com/api/v2/summary.json', statusUrl: 'https://status.figma.com/' },
        { name: 'Jira Software', type: 'statuspage', url: 'https://jira-software.status.atlassian.com/api/v2/summary.json', statusUrl: 'https://jira-software.status.atlassian.com/' },
      ];
      const results = [];
      for (const svc of services) {
        try {
          const raw = await getJson(svc.url);
          const current = svc.type === 'local' ? normalizeFromLocal(raw) : normalizeFromStatuspage(raw);
          const baseKey = getDedupeKey(svc);
          const persisted = await getPersistedState(baseKey);
          results.push({ name: svc.name, current, persisted, baseKey });
        } catch (e) {
          results.push({ name: svc.name, error: String(e && e.message || 'error') });
        }
      }
      return { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(results) };
    }
    if (qs && (qs.health === '1' || qs.health === 'true')) {
      try {
        if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
          const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
          const lastRunAt = await store.get('meta:lastRunAt', { type: 'text' });
          return { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ lastRunAt: lastRunAt ? Number(lastRunAt) : 0 }) };
        }
      } catch (_) {}
      const mem = (globalThis.__LAST_RUN_AT__ ? Number(globalThis.__LAST_RUN_AT__) : 0) || 0;
      return { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ lastRunAt: mem }) };
    }
  } catch (_) {}
  const base = process.env.URL || 'https://3rd-party-services.netlify.app';

  // Coalesce overlapping invocations: skip if a run occurred <60s ago
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
      const lastRun = store ? await store.get('meta:lastRunAt', { type: 'text' }) : null;
      const lastTs = lastRun ? Number(lastRun) : 0;
      if (Number.isFinite(lastTs) && (Date.now() - lastTs) < 60 * 1000) {
        return { statusCode: 200, body: 'ok-coalesced' };
      }
    }
  } catch (_) {}
  const services = [
    { name: 'Google Play Store', type: 'local', url: `${base}/.netlify/functions/api/google/play-status`, statusUrl: 'https://status.play.google.com/' },
    { name: 'Google Play Services', type: 'local', url: `${base}/.netlify/functions/api/google/play-status`, statusUrl: 'https://status.play.google.com/' },
    { name: 'Apple App Store', type: 'local', url: `${base}/.netlify/functions/api/apple/status`, statusUrl: 'https://developer.apple.com/system-status/' },
    { name: 'Firebase', type: 'local', url: `${base}/.netlify/functions/api/firebase/status`, statusUrl: 'https://status.firebase.google.com/' },
    { name: 'Mixpanel', type: 'local', url: `${base}/.netlify/functions/api/mixpanel/status`, statusUrl: 'https://status.mixpanel.com/' },
    { name: 'Singular', type: 'statuspage', url: 'https://status.singular.net/api/v2/summary.json', statusUrl: 'https://status.singular.net/' },
    { name: 'Sentry', type: 'statuspage', url: 'https://status.sentry.io/api/v2/summary.json', statusUrl: 'https://status.sentry.io/' },
    { name: 'Facebook Audience Network', type: 'local', url: `${base}/.netlify/functions/api/facebook/status`, statusUrl: 'https://metastatus.com/' },
    { name: 'Google AdMob', type: 'local', url: `${base}/.netlify/functions/api/google/cloud-status`, statusUrl: 'https://status.cloud.google.com/' },
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
      // Use a stable key per service; compute a stable incident key (incidentId or startedAt ms)
      const baseKey = getDedupeKey(svc);
      const currentIncidentId = current && current.incidentId ? String(current.incidentId).trim() : null;
      const currentStartedAtMs = current && current.startedAt ? Date.parse(current.startedAt) : null;
      const currentIncidentKey = currentIncidentId ? `id:${currentIncidentId}` : (Number.isFinite(currentStartedAtMs) ? `ts:${currentStartedAtMs}` : null);
      const prev = last[svc.name] || { state: 'unknown', startedAt: null };
      const persisted = await getPersistedState(baseKey);
      const nowTs = Date.now();

      // Entering or staying in incident: notify once per startedAt
      if (current.state === 'incident') {
        const startedAt = current.startedAt || persisted.startedAt || new Date().toISOString();
        last[svc.name] = { state: 'incident', severity: current.severity || 'minor', startedAt };
        const persistedStartKey = persisted.startKey || (persisted.startedAt ? `ts:${Date.parse(persisted.startedAt)}` : null) || (persisted.incidentId ? `id:${persisted.incidentId}` : null);
        const startKey = currentIncidentKey || (startedAt ? `ts:${Date.parse(startedAt)}` : null);
        const isNewIncident = Boolean(startKey && persistedStartKey && startKey !== persistedStartKey);
        if (isNewIncident || (startKey && persisted.lastNotifiedStartKey !== startKey)) {
          // Suppress duplicates within 120s across concurrent invocations
          const suppressWindowMs = 120 * 1000;
          const lastTs = await getLastNotifiedTs(`${baseKey}:start`);
          const sigKey = `${baseKey}:start`;
          const sigVal = `start:${startKey || startedAt}`;
          const lastSig = await getLastSignature(sigKey);
          if ((lastSig !== sigVal) && (!Number.isFinite(lastTs) || (Date.now() - lastTs) >= suppressWindowMs)) {
            // Pre-set lastTs to coalesce concurrent runs, then send
            await setLastNotifiedTs(`${baseKey}:start`, Date.now());
            await setLastSignature(sigKey, sigVal);
            const started = new Date(startedAt).toLocaleString();
            const emoji = (current.severity === 'critical') ? ':red_circle:' : ':large_yellow_circle:';
            const title = current.title || 'Incident detected';
            const link = svc.statusUrl ? `\nStatus: ${svc.statusUrl}` : '';
            await notifySlackBackground(`${emoji} ${svc.name}: ${title}\nStarted: ${started}${link}`);
            await setPersistedState(baseKey, { state: 'incident', startedAt, startKey: startKey || null, lastNotifiedStartAt: startedAt, lastNotifiedStartKey: startKey || null, lastNotifiedResolveAt: null, lastNotifiedResolveKey: null, lastNonIncidentTs: 0, incidentId: currentIncidentId || persisted.incidentId || null });
          }
        } else {
          await setPersistedState(baseKey, { state: 'incident', startedAt, startKey: currentIncidentKey || persisted.startKey || null, incidentId: currentIncidentId || persisted.incidentId || null });
        }
        continue;
      }

      // Returning to operational: notify once per incident
      if (current.state === 'operational') {
        const hasStarted = Boolean(persisted.startedAt || persisted.startKey);
        const startKey = persisted.startKey || (persisted.startedAt ? `ts:${Date.parse(persisted.startedAt)}` : null);
        const startWasNotified = Boolean(persisted.lastNotifiedStartKey && startKey && persisted.lastNotifiedStartKey === startKey);
        const resolveNotSent = !persisted.lastNotifiedResolveKey || (startKey && persisted.lastNotifiedResolveKey !== startKey);

        // If we previously sent a start for this incident and haven't sent resolve yet, send resolve now
        if (hasStarted && startWasNotified && resolveNotSent) {
          const suppressWindowMs = 120 * 1000;
          const lastTs = await getLastNotifiedTs(`${baseKey}:resolve`);
          const sigKey = `${baseKey}:resolve`;
          const sigVal = `resolve:${startKey || ''}`;
          const lastSig = await getLastSignature(sigKey);
          if ((lastSig !== sigVal) && (!Number.isFinite(lastTs) || (Date.now() - lastTs) >= suppressWindowMs)) {
            await setLastNotifiedTs(`${baseKey}:resolve`, Date.now());
            await setLastSignature(sigKey, sigVal);
            const ended = new Date().toLocaleString();
            const startedStr = new Date(persisted.startedAt || '').toLocaleString();
            const link = svc.statusUrl ? `\nStatus: ${svc.statusUrl}` : '';
            await notifySlackBackground(`:white_check_mark: ${svc.name} back to normal\nStarted: ${startedStr}\nResolved: ${ended}${link}`);
            last[svc.name] = { state: 'operational', startedAt: null };
            await setPersistedState(baseKey, { state: 'operational', startedAt: null, startKey: null, lastNotifiedResolveAt: persisted.startedAt || null, lastNotifiedResolveKey: startKey || null, lastNonIncidentTs: nowTs, incidentId: null });
          }
          return { statusCode: 200, body: 'ok' };
        }

        // If we never sent a start (no notification to pair), simply mark operational
        if (!startWasNotified) {
          if (prev.state !== 'operational') {
            last[svc.name] = { state: 'operational', startedAt: null };
          }
          await setPersistedState(baseKey, { state: 'operational', incidentId: null });
        }
        continue;
      }

      // Keep in-memory state in sync; also normalize persisted "unknown" → "operational"
      if (prev.state !== current.state) {
        last[svc.name] = { state: current.state, startedAt: null };
      }
      // Track last time we observed non-incident (operational/unknown)
      if (current.state !== 'incident') {
        const lastNonIncidentTs = nowTs;
        await setPersistedState(baseKey, {
          state: persisted.state,
          startedAt: persisted.startedAt || null,
          lastNonIncidentTs,
          incidentId: persisted.incidentId || null,
        });
      }
      // Grace reset: if we stayed away from incident for long, reset persisted state
      if (persisted.state === 'incident' && persisted.lastNonIncidentTs) {
        const elapsed = nowTs - Number(persisted.lastNonIncidentTs || 0);
        if (elapsed >= RESET_UNKNOWN_MINUTES * 60 * 1000) {
          await setPersistedState(baseKey, { state: 'operational', startedAt: null, lastNonIncidentTs: nowTs, incidentId: null });
        }
      }
    } catch (_) {
      // ignore per-service errors
    }
  }

  // Persist last successful run timestamp for health checks
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
      await store.set('meta:lastRunAt', String(Date.now()));
    }
  } catch (_) {}
  globalThis.__LAST_RUN_AT__ = Date.now();

  return { statusCode: 200, body: 'ok' };
};

// Netlify schedule disabled; using external scheduler (e.g., GCP Cloud Scheduler)
// exports.config = { schedule: '*/5 * * * *' };


