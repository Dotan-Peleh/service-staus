'use strict';

const http = require('http');
const https = require('https');

function getJson(u) {
  return new Promise((resolve, reject) => {
    const lib = u.startsWith('http:') ? http : https;
    lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'application/json' } }, (r) => {
      const b = []; r.on('data', c => b.push(c)); r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b).toString('utf8'))); } catch(e){ reject(e); } });
    }).on('error', reject);
  });
}

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
        return { state: 'incident', severity, title: active.name || 'Service Incident', startedAt };
      }
      return { state: 'operational' };
    }
  } catch (_) {}
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
    { name: 'Google Play Store', type: 'local', url: `${base}/.netlify/functions/api/api/google/play-status`, statusUrl: 'https://status.play.google.com/' },
    { name: 'Google Play Services', type: 'local', url: `${base}/.netlify/functions/api/api/google/play-status`, statusUrl: 'https://status.play.google.com/' },
    { name: 'Apple App Store', type: 'local', url: `${base}/.netlify/functions/api/api/apple/status`, statusUrl: 'https://developer.apple.com/system-status/' },
    { name: 'Firebase', type: 'local', url: `${base}/.netlify/functions/api/api/firebase/status`, statusUrl: 'https://status.firebase.google.com/' },
    { name: 'Mixpanel', type: 'local', url: `${base}/.netlify/functions/api/api/mixpanel/status`, statusUrl: 'https://status.mixpanel.com/' },
    { name: 'Singular', type: 'statuspage', url: 'https://status.singular.net/api/v2/summary.json', statusUrl: 'https://status.singular.net/' },
    { name: 'Sentry', type: 'statuspage', url: 'https://status.sentry.io/api/v2/summary.json', statusUrl: 'https://status.sentry.io/' },
    { name: 'Unity LevelPlay', type: 'statuspage', url: 'https://unity.statuspage.io/api/v2/summary.json', statusUrl: 'https://status.unity.com/' },
    { name: 'Facebook Audience Network', type: 'local', url: `${base}/.netlify/functions/api/api/facebook/status`, statusUrl: 'https://metastatus.com/' },
    { name: 'Google AdMob', type: 'local', url: `${base}/.netlify/functions/api/api/google/cloud-status`, statusUrl: 'https://status.cloud.google.com/' },
    { name: 'Unity Ads', type: 'statuspage', url: 'https://unity.statuspage.io/api/v2/summary.json', statusUrl: 'https://status.unity.com/' },
    { name: 'Unity Cloud Services', type: 'statuspage', url: 'https://unity.statuspage.io/api/v2/summary.json', statusUrl: 'https://status.unity.com/' },
    { name: 'Realm Database', type: 'statuspage', url: 'https://status.mongodb.com/api/v2/summary.json', statusUrl: 'https://status.mongodb.com/' },
    { name: 'Slack', type: 'local', url: `${base}/.netlify/functions/api/api/slack/status`, statusUrl: 'https://status.slack.com/' },
    { name: 'Notion', type: 'statuspage', url: 'https://www.notion-status.com/api/v2/summary.json', statusUrl: 'https://www.notion-status.com/' },
    { name: 'Figma', type: 'statuspage', url: 'https://status.figma.com/api/v2/summary.json', statusUrl: 'https://status.figma.com/' },
    { name: 'Jira Software', type: 'statuspage', url: 'https://jira-software.status.atlassian.com/api/v2/summary.json', statusUrl: 'https://jira-software.status.atlassian.com/' },
  ];

  // Warm-instance ephemeral memory to reduce duplicates between runs in the same container
  globalThis.__MONITOR_LAST__ = globalThis.__MONITOR_LAST__ || {};
  const last = globalThis.__MONITOR_LAST__;

  for (const svc of services) {
    try {
      const raw = await getJson(svc.url);
      const current = svc.type === 'local' ? normalizeFromLocal(raw) : normalizeFromStatuspage(raw);
      const prev = last[svc.name] || { state: 'unknown', startedAt: null };

      if (current.state === 'incident' && prev.state !== 'incident') {
        const startedAt = current.startedAt || new Date().toISOString();
        last[svc.name] = { state: 'incident', severity: current.severity || 'minor', startedAt };
        const started = new Date(startedAt).toLocaleString();
        const emoji = (current.severity === 'critical') ? ':red_circle:' : ':large_yellow_circle:';
        const title = current.title || 'Incident detected';
        const link = svc.statusUrl ? `\nStatus: ${svc.statusUrl}` : '';
        await notifySlackBackground(`${emoji} ${svc.name}: ${title}\nStarted: ${started}${link}`);
        continue;
      }

      if (current.state === 'operational' && prev.state === 'incident') {
        const ended = new Date().toLocaleString();
        const started = prev.startedAt ? new Date(prev.startedAt).toLocaleString() : 'Unknown';
        const link = svc.statusUrl ? `\nStatus: ${svc.statusUrl}` : '';
        await notifySlackBackground(`:white_check_mark: ${svc.name} back to normal\nStarted: ${started}\nResolved: ${ended}${link}`);
        last[svc.name] = { state: 'operational', startedAt: null };
        continue;
      }

      if (prev.state !== current.state) {
        last[svc.name] = { state: current.state, startedAt: null };
      }
    } catch (_) {
      // ignore per-service errors
    }
  }

  return { statusCode: 200, body: 'ok' };
};

exports.config = { schedule: '*/5 * * * *' };


