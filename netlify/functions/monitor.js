'use strict';

const http = require('http');
const https = require('https');
const utils = require('../../lib/status-utils');
let netlifyBlobs = null;
try { netlifyBlobs = require('@netlify/blobs'); } catch (_) { netlifyBlobs = null; }
let FirestoreMod = null;
try { FirestoreMod = require('@google-cloud/firestore'); } catch (_) { FirestoreMod = null; }

const COOLDOWN_MINUTES = Number(process.env.NOTIFY_COOLDOWN_MINUTES || '180'); // default 3h
const RESET_UNKNOWN_MINUTES = Number(process.env.RESET_UNKNOWN_MINUTES || '60'); // reset incident after 60m of non-incident/unknown

// --- KV persistence: prefers GCP Firestore → Netlify Blobs → in-memory ---
let __firestoreClient = null;
function getFirestoreClient() {
  if (__firestoreClient !== null) return __firestoreClient;
  try {
    if (!FirestoreMod) return (__firestoreClient = null);
    const { Firestore } = FirestoreMod;
    const projectId = process.env.GCP_PROJECT_ID || '';
    const saJsonRaw = process.env.GCP_SA_JSON || '';
    const saB64 = process.env.GCP_SA_JSON_BASE64 || '';
    let creds = null;
    if (saJsonRaw) {
      creds = JSON.parse(saJsonRaw);
    } else if (saB64) {
      const json = Buffer.from(saB64, 'base64').toString('utf8');
      creds = JSON.parse(json);
    }
    if (!projectId || !creds || !creds.client_email || !creds.private_key) {
      return (__firestoreClient = null);
    }
    // Normalize private key newlines
    const private_key = String(creds.private_key).replace(/\\n/g, '\n');
    __firestoreClient = new Firestore({ projectId, credentials: { client_email: creds.client_email, private_key } });
    return __firestoreClient;
  } catch (_) {
    return (__firestoreClient = null);
  }
}

// Firestore document IDs cannot contain '/'. Sanitize keys when using Firestore.
function fsSanitizeId(key) {
  try { return String(key).replace(/\//g, '_'); } catch (_) { return String(key || ''); }
}

async function kvGet(key) {
  // Firestore first
  try {
    const fs = getFirestoreClient();
    if (fs) {
      const ref = fs.collection('kv_status_notify').doc(fsSanitizeId(key));
      const snap = await ref.get();
      if (snap.exists) {
        const data = snap.data() || {};
        return typeof data.value === 'string' ? data.value : (data.value != null ? String(data.value) : null);
      }
      return null;
    }
  } catch (_) {}
  // Netlify Blobs
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
      const val = await store.get(key, { type: 'text' });
      return val || null;
    }
  } catch (_) {}
  // In-memory fallback
  globalThis.__KV_MEM__ = globalThis.__KV_MEM__ || {};
  return Object.prototype.hasOwnProperty.call(globalThis.__KV_MEM__, key) ? globalThis.__KV_MEM__[key] : null;
}

async function kvSet(key, value) {
  const v = String(value == null ? '' : value);
  // Firestore first
  try {
    const fs = getFirestoreClient();
    if (fs) {
      const ref = fs.collection('kv_status_notify').doc(fsSanitizeId(key));
      await ref.set({ value: v, updatedAt: Date.now() }, { merge: true });
      return;
    }
  } catch (_) {}
  // Netlify Blobs
  try {
    if (netlifyBlobs && typeof netlifyBlobs.getStore === 'function') {
      const store = netlifyBlobs.getStore && netlifyBlobs.getStore({ name: 'status-notify' });
      await store.set(key, v);
      return;
    }
  } catch (_) {}
  // In-memory fallback
  globalThis.__KV_MEM__ = globalThis.__KV_MEM__ || {};
  globalThis.__KV_MEM__[key] = v;
}

async function getLastNotifiedTs(key) {
  const k = `notify:${key}`;
  const val = await kvGet(k);
  const ts = val ? Number(val) : 0;
  return Number.isFinite(ts) ? ts : 0;
}

async function setLastNotifiedTs(key, ts) {
  const k = `notify:${key}`;
  await kvSet(k, String(ts));
}

// Persisted message signature per service to ensure idempotent posts
async function getLastSignature(key) {
  const k = `sig:${key}`;
  const val = await kvGet(k);
  return val || '';
}

async function setLastSignature(key, sig) {
  const k = `sig:${key}`;
  await kvSet(k, String(sig || ''));
}

// Persisted incident state to ensure we alert only once per continuous incident
async function getPersistedState(key) {
  const k = `state:${key}`;
  try {
    const val = await kvGet(k);
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
        // Multi-incident support (Statuspage): arrays of notified keys and metadata maps
        notifiedStartKeys: Array.isArray(parsed.notifiedStartKeys) ? parsed.notifiedStartKeys : [],
        notifiedResolveKeys: Array.isArray(parsed.notifiedResolveKeys) ? parsed.notifiedResolveKeys : [],
        startKeyToStartedAt: (parsed.startKeyToStartedAt && typeof parsed.startKeyToStartedAt === 'object') ? parsed.startKeyToStartedAt : {},
        startKeyToTitle: (parsed.startKeyToTitle && typeof parsed.startKeyToTitle === 'object') ? parsed.startKeyToTitle : {},
      };
    } catch (_) {
      return { state: 'unknown', startedAt: null, startKey: null, incidentId: null, lastNonIncidentTs: 0, lastNotifiedStartAt: null, lastNotifiedResolveAt: null, lastNotifiedStartKey: null, lastNotifiedResolveKey: null, notifiedStartKeys: [], notifiedResolveKeys: [], startKeyToStartedAt: {}, startKeyToTitle: {} };
    }
  } catch (_) {}
  return { state: 'unknown', startedAt: null, startKey: null, incidentId: null, lastNonIncidentTs: 0, lastNotifiedStartAt: null, lastNotifiedResolveAt: null, lastNotifiedStartKey: null, lastNotifiedResolveKey: null, notifiedStartKeys: [], notifiedResolveKeys: [], startKeyToStartedAt: {}, startKeyToTitle: {} };
}

async function setPersistedState(key, value) {
  const k = `state:${key}`;
  await kvSet(k, JSON.stringify(value));
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
    const forceRun = !!(qs && (qs.force === '1' || qs.force === 'true'));
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
        const lastRunAtStr = await kvGet('meta:lastRunAt');
        const lastRunAt = lastRunAtStr ? Number(lastRunAtStr) : 0;
        return { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ lastRunAt: Number.isFinite(lastRunAt) ? lastRunAt : 0 }) };
      } catch (_) {}
      const mem = (globalThis.__LAST_RUN_AT__ ? Number(globalThis.__LAST_RUN_AT__) : 0) || 0;
      return { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ lastRunAt: mem }) };
    }
  } catch (_) {}
  const base = process.env.URL || 'https://3rd-party-services.netlify.app';

  // Coalesce overlapping invocations: skip if a run occurred <60s ago (unless force=1)
  try {
    if (!(event && event.queryStringParameters && (event.queryStringParameters.force === '1' || event.queryStringParameters.force === 'true'))) {
      const lastRun = await kvGet('meta:lastRunAt');
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
      // Special handling for Statuspage-backed services to support multiple concurrent incidents
      if (svc.type === 'statuspage') {
        const summary = raw || {};
        const incidents = Array.isArray(summary.incidents) ? summary.incidents : [];
        const active = incidents.filter((i) => i && String(i.status || '').toLowerCase() !== 'resolved');
        const baseKey = getDedupeKey(svc);
        const persisted = await getPersistedState(baseKey);
        const nowActiveKeys = new Set();
        const suppressWindowMs = 120 * 1000;

        // Send start notifications for any new active incidents
        for (const inc of active) {
          const incidentId = inc && inc.id ? String(inc.id) : null;
          const started = inc && (inc.started_at || inc.created_at || inc.startedAt);
          const startedMs = started ? Date.parse(started) : NaN;
          const startKey = Number.isFinite(startedMs) ? `ts:${startedMs}` : (incidentId ? `id:${incidentId}` : null);
          if (!startKey) continue;
          nowActiveKeys.add(startKey);
          const alreadyNotified = Array.isArray(persisted.notifiedStartKeys) && persisted.notifiedStartKeys.includes(startKey);
          if (!alreadyNotified) {
            const lastTs = await getLastNotifiedTs(`${baseKey}:start:${startKey}`);
            const sigKey = `${baseKey}:start:${startKey}`;
            const sigVal = `start:${startKey}`;
            const lastSig = await getLastSignature(sigKey);
            if ((lastSig !== sigVal) && (!Number.isFinite(lastTs) || (Date.now() - lastTs) >= suppressWindowMs)) {
              await setLastNotifiedTs(`${baseKey}:start:${startKey}`, Date.now());
              await setLastSignature(sigKey, sigVal);
              const emoji = String(inc.impact || '').toLowerCase() === 'critical' ? ':red_circle:' : ':large_yellow_circle:';
              const title = inc.name || inc.title || 'Incident detected';
              const startedStr = started ? new Date(started).toLocaleString() : new Date().toLocaleString();
              const link = svc.statusUrl ? `\nStatus: ${svc.statusUrl}` : '';
              await notifySlackBackground(`${emoji} ${svc.name}: ${title}\nStarted: ${startedStr}${link}`);
              const newNotified = (persisted.notifiedStartKeys || []).concat([startKey]);
              const startKeyToStartedAt = Object.assign({}, persisted.startKeyToStartedAt || {});
              const startKeyToTitle = Object.assign({}, persisted.startKeyToTitle || {});
              startKeyToStartedAt[startKey] = started || new Date().toISOString();
              startKeyToTitle[startKey] = title;
              await setPersistedState(baseKey, {
                state: 'incident',
                startedAt: started || null,
                startKey: startKey,
                lastNotifiedStartAt: started || null,
                lastNotifiedStartKey: startKey,
                lastNotifiedResolveAt: persisted.lastNotifiedResolveAt || null,
                lastNotifiedResolveKey: persisted.lastNotifiedResolveKey || null,
                lastNonIncidentTs: 0,
                incidentId: incidentId || null,
                notifiedStartKeys: newNotified,
                notifiedResolveKeys: Array.isArray(persisted.notifiedResolveKeys) ? persisted.notifiedResolveKeys : [],
                startKeyToStartedAt,
                startKeyToTitle,
              });
            }
          }
        }

        // Send resolve notifications for incidents that were active before but not anymore
        const previouslyNotified = Array.isArray(persisted.notifiedStartKeys) ? persisted.notifiedStartKeys : [];
        const alreadyResolved = new Set(Array.isArray(persisted.notifiedResolveKeys) ? persisted.notifiedResolveKeys : []);
        const stillActiveKeys = nowActiveKeys;
        for (const startKey of previouslyNotified) {
          if (stillActiveKeys.has(startKey) || alreadyResolved.has(startKey)) continue;
          const lastTs = await getLastNotifiedTs(`${baseKey}:resolve:${startKey}`);
          const sigKey = `${baseKey}:resolve:${startKey}`;
          const sigVal = `resolve:${startKey}`;
          const lastSig = await getLastSignature(sigKey);
          if ((lastSig !== sigVal) && (!Number.isFinite(lastTs) || (Date.now() - lastTs) >= suppressWindowMs)) {
            await setLastNotifiedTs(`${baseKey}:resolve:${startKey}`, Date.now());
            await setLastSignature(sigKey, sigVal);
            const startedIso = (persisted.startKeyToStartedAt || {})[startKey] || null;
            const startedStr = startedIso ? new Date(startedIso).toLocaleString() : '';
            const endedStr = new Date().toLocaleString();
            const title = (persisted.startKeyToTitle || {})[startKey] || 'Incident';
            const link = svc.statusUrl ? `\nStatus: ${svc.statusUrl}` : '';
            await notifySlackBackground(`:white_check_mark: ${svc.name} back to normal — ${title}\nStarted: ${startedStr}\nResolved: ${endedStr}${link}`);
            const newResolved = Array.from(alreadyResolved);
            newResolved.push(startKey);
            const stateNow = newResolved.length >= previouslyNotified.length ? 'operational' : 'incident';
            await setPersistedState(baseKey, {
              state: stateNow,
              startedAt: stateNow === 'operational' ? null : (persisted.startedAt || null),
              startKey: stateNow === 'operational' ? null : (persisted.startKey || null),
              lastNotifiedResolveAt: startedIso || null,
              lastNotifiedResolveKey: startKey,
              lastNonIncidentTs: stateNow === 'operational' ? Date.now() : (persisted.lastNonIncidentTs || 0),
              incidentId: null,
              notifiedStartKeys: previouslyNotified,
              notifiedResolveKeys: newResolved,
              startKeyToStartedAt: Object.assign({}, persisted.startKeyToStartedAt || {}),
              startKeyToTitle: Object.assign({}, persisted.startKeyToTitle || {}),
            });
          }
        }
        // Skip default single-incident logic for Statuspage services
        continue;
      }

      const current = svc.type === 'local' ? normalizeFromLocal(raw) : normalizeFromStatuspage(raw);
      // Use a stable key per service; compute a stable incident key (incidentId or startedAt ms)
      const baseKey = getDedupeKey(svc);
      const currentIncidentId = current && current.incidentId ? String(current.incidentId).trim() : null;
      const currentStartedAtMs = current && current.startedAt ? Date.parse(current.startedAt) : null;
      // Prefer startedAt-based key to tolerate upstream incidentId churn
      const currentIncidentKey = Number.isFinite(currentStartedAtMs) ? `ts:${currentStartedAtMs}` : (currentIncidentId ? `id:${currentIncidentId}` : null);
      const prev = last[svc.name] || { state: 'unknown', startedAt: null };
      const persisted = await getPersistedState(baseKey);
      const nowTs = Date.now();

      // Entering or staying in incident: notify once per startedAt
      if (current.state === 'incident') {
        const startedAt = current.startedAt || persisted.startedAt || new Date().toISOString();
        last[svc.name] = { state: 'incident', severity: current.severity || 'minor', startedAt };
        // Hard guard: if we're already in incident and start was notified, never resend start
        if (persisted.state === 'incident' && persisted.lastNotifiedStartKey) {
          await setPersistedState(baseKey, { state: 'incident', startedAt, startKey: persisted.startKey || currentIncidentKey || null, lastNotifiedStartAt: persisted.lastNotifiedStartAt || startedAt, lastNotifiedStartKey: persisted.lastNotifiedStartKey, incidentId: currentIncidentId || persisted.incidentId || null });
          continue;
        }
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
        // Consider it a previously observed incident even if timestamps are missing (edge cases)
        const hasStarted = Boolean(persisted.startedAt || persisted.startKey || persisted.state === 'incident');
        const startKey = persisted.startKey || (persisted.startedAt ? `ts:${Date.parse(persisted.startedAt)}` : null);
        const startWasNotified = Boolean(persisted.lastNotifiedStartKey && startKey && persisted.lastNotifiedStartKey === startKey);
        const resolveNotSent = !persisted.lastNotifiedResolveKey || (startKey && persisted.lastNotifiedResolveKey !== startKey);

        // If we observed an incident (even if start wasn't notified earlier) and haven't sent resolve yet, send resolve now
        if (hasStarted && resolveNotSent) {
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
            await setPersistedState(baseKey, {
              state: 'operational',
              startedAt: null,
              startKey: null,
              lastNotifiedResolveAt: persisted.startedAt || null,
              lastNotifiedResolveKey: startKey || persisted.lastNotifiedStartKey || 'resolved',
              lastNonIncidentTs: nowTs,
              incidentId: null,
            });
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
  try { await kvSet('meta:lastRunAt', String(Date.now())); } catch (_) {}
  globalThis.__LAST_RUN_AT__ = Date.now();

  return { statusCode: 200, body: 'ok' };
};

// Netlify schedule disabled; using external scheduler (e.g., GCP Cloud Scheduler)
// exports.config = { schedule: '*/5 * * * *' };


