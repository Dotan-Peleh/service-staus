'use strict';

const http = require('http');
const https = require('https');
const utils = require('../../lib/status-utils');

function httpGetFollow(rawUrl, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    let currentUrl;
    try { currentUrl = new URL(rawUrl); } catch (e) { return reject(e); }
    const doGet = (u, redirectsLeft) => {
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': '*/*', 'Accept-Encoding': 'identity', ...headers } }, (r) => {
        const status = r.statusCode || 0;
        const loc = r.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && loc && redirectsLeft > 0) {
          try {
            const nextUrl = new URL(loc, u);
            r.resume();
            return doGet(nextUrl, redirectsLeft - 1);
          } catch (e) {
            r.resume();
            return reject(e);
          }
        }
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve({ statusCode: status, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
    };
    doGet(currentUrl, maxRedirects);
  });
}

function json(status, obj) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' },
    body: JSON.stringify(obj),
  };
}

async function fetchText(u) {
  const resp = await httpGetFollow(u, { 'Accept': '*/*' });
  return resp.body;
}

async function fetchJson(u) {
  const resp = await httpGetFollow(u, { 'Accept': 'application/json' });
  try { return JSON.parse(resp.body); } catch (e) { throw e; }
}

exports.handler = async (event, context) => {
  try {
    const path = event.path.replace(/^\/.netlify\/functions\//, '/');
    // CORS preflight for notify endpoints
    if (event.httpMethod === 'OPTIONS' && (path === '/api/notify/slack' || path === '/api/notify/enabled')) {
      return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }, body: '' };
    }
    if (path === '/api/apple/status' || path === '/api/apple/debug') {
      // Check both consumer AND developer status pages
      // Note: Developer page uses JS rendering, so detection is best-effort based on HTML text patterns
      let consumerIncident = null;
      let developerIncident = null;
      
      // Check consumer services (App Store, App Store Connect)
      try {
        let body = await fetchText('https://www.apple.com/support/systemstatus/data/system_status_en_US.json');
        let data;
        try { data = JSON.parse(body); } catch {
          body = await fetchText('https://www.apple.com/support/systemstatus/data/system_status_en_US.js');
          const start = body.indexOf('{'); const end = body.lastIndexOf('}');
          if (start >= 0 && end > start) data = JSON.parse(body.slice(start, end + 1));
        }
        if (data && Array.isArray(data.services)) {
          const target = new Set(['app store','app store connect']);
          const now = Date.now();
          for (const svc of data.services) {
            const name = String(svc.serviceName || '').toLowerCase();
            if (!target.has(name)) continue;
            const events = Array.isArray(svc.events) ? svc.events : [];
            const active = events.find((e) => {
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
        const plain = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
        const text = plain.toLowerCase();
        
        // Look for incident indicators
        const hasOutage = /outage|service\s+(down|unavailable|disruption)|critical\s+issue/i.test(plain);
        const hasIssue = /\bissue\b|degraded|partial|problem|experiencing\s+issues/i.test(plain);
        const hasIncidentKeyword = /incident|disruption|affected/i.test(plain);
        
        // Extract service name if mentioned with incident
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
              // Extract service name from the match
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
      
      // Determine final state
      const incident = developerIncident || consumerIncident;
      
      if (path === '/api/apple/debug') {
        return json(200, { 
          consumerIncident, 
          developerIncident, 
          finalIncident: incident,
          note: 'Developer page uses JS rendering - detection is best-effort'
        });
      }
      
      if (incident) {
        const title = incident.service ? `${incident.service}${incident.detail ? ': ' + incident.detail.slice(0, 100) : ''}` : 'Apple Services Incident';
        return json(200, { 
          state: 'incident', 
          severity: incident.severity || 'minor', 
          title,
          detail: incident.detail || undefined,
          startedAt: new Date().toISOString()
        });
      }
      
      return json(200, { state: 'operational' });
    }

    if (path === '/api/google/play-status') {
      const body = await fetchText('https://status.play.google.com/');
      const plain = body.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      const text = plain.toLowerCase();
      const hasMajor = /(major outage|critical|service (outage|down)|unavailable)/i.test(plain);
      const hasMinor = /(partial outage|degraded|degradation|incident|maintenance)/i.test(plain);
      const hasResolved = /(resolved|has been resolved|issue (?:is|was) resolved|restored|closed|ended)/i.test(plain);
      const hasInvestigating = /(investigating|identified|monitoring|ongoing|in progress|mitigating)/i.test(plain);
      const allOk = /all systems operational|no incidents reported|no known issues/i.test(plain) || /operational\s*$/.test(text);
      const snippet = (()=>{ const s=plain.split(/(?<=[.!?])\s+/); const i=s.findIndex(t=>/outage|incident|degrad|disruption|unavail|maintenance|resolved|restored/i.test(t)); return i>=0?s[i].trim().slice(0,240):''; })();
      if (allOk) return json(200, { state: 'operational' });
      if ((hasMajor||hasMinor) && hasInvestigating) return json(200, { state: 'incident', severity: hasMajor?'critical':'minor', title: snippet || 'Detected incident' });
      if (hasMajor||hasMinor) return json(200, { state: 'operational', lastIncident: { title: snippet, endedAt: null } });
      return json(200, { state: 'operational' });
    }

    if (path === '/api/google/cloud-status') {
      const body = await fetchText('https://status.cloud.google.com/');
      const plainAll = body.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      const sanitized = plainAll.replace(/See incidents that impact your workloads[\s\S]*?logs\./i,' ');
      const text = sanitized.toLowerCase();
      const hasMajor = /(major outage|critical|service (outage|down)|incident impacting multiple regions|service disruption)/i.test(sanitized);
      const hasMinor = /(partial outage|degraded|degradation|disruption)/i.test(sanitized);
      const hasResolved = /(resolved|has been resolved|issue (?:is|was) resolved|restored|closed|ended)/i.test(sanitized);
      const hasInvestigating = /(investigating|identified|monitoring|ongoing|in progress|mitigating|current incident)/i.test(sanitized);
      const allOk = /all services available|no incidents reported|no known issues|all systems operational/i.test(sanitized) || /operational\s*$/.test(text);
      const snippet = (()=>{ const s=sanitized.split(/(?<=[.!?])\s+/); const i=s.findIndex(t=>/outage|incident|degrad|disruption|unavail|maintenance|resolved|restored/i.test(t)); return i>=0?s[i].trim().slice(0,240):''; })();
      if (allOk) return json(200, { state: 'operational' });
      if ((hasMajor||hasMinor) && hasInvestigating) return json(200, { state: 'incident', severity: hasMajor?'critical':'minor', title: snippet || 'Detected incident' });
      if (hasMajor||hasMinor) return json(200, { state: 'operational', lastIncident: { title: snippet, endedAt: null } });
      return json(200, { state: 'operational' });
    }

    if (path === '/api/mixpanel/status') {
      // Mixpanel: use official Statuspage JSON only (no HTML fallback)
      try {
        // Use canonical domain directly
        const summary = await fetchJson('https://www.mixpanelstatus.com/api/v2/summary.json');
        if (summary) {
          if (Array.isArray(summary.incidents) && summary.incidents.length > 0) {
            const active = summary.incidents.find(i => i.status !== 'resolved');
            if (active) {
              const impact = (active.impact || active.impact_override || 'minor').toLowerCase();
              const severity = (impact === 'critical' || impact === 'major') ? 'critical' : 'minor';
              const startedAt = active.started_at || active.created_at || null;
              const incidentId = active.id || active.shortlink || active.url || null;
              return json(200, { state: 'incident', severity, title: active.name || 'Service Incident', startedAt, incidentId });
            }
          }
          if (Array.isArray(summary.scheduled_maintenances) && summary.scheduled_maintenances.length > 0) {
            const maint = summary.scheduled_maintenances.find(m => m.status && m.status !== 'completed');
            if (maint && (maint.status === 'in_progress' || maint.status === 'scheduled')) {
              const impact = (maint.impact || maint.impact_override || 'minor').toLowerCase();
              const severity = (impact === 'critical' || impact === 'major') ? 'critical' : 'minor';
              const eta = maint.scheduled_until || maint.scheduled_end || maint.scheduled_for || null;
              const startedAt = maint.scheduled_for || maint.created_at || null;
              const incidentId = maint.id || maint.shortlink || maint.url || null;
              return json(200, { state: 'incident', severity, title: maint.name || 'Scheduled maintenance', eta, startedAt, incidentId });
            }
          }
        }
      } catch (_) {}

      try {
        const status = await fetchJson('https://www.mixpanelstatus.com/api/v2/status.json');
        const indicator = status && status.status && String(status.status.indicator || '').toLowerCase();
        if (indicator === 'none') return json(200, { state: 'operational' });
        if (indicator === 'minor') return json(200, { state: 'incident', severity: 'minor', title: status.status.description || 'Service Incident' });
        if (indicator === 'major' || indicator === 'critical') return json(200, { state: 'incident', severity: 'critical', title: status.status.description || 'Service Incident' });
      } catch (_) {}

      // If APIs unreachable, return unknown (avoid HTML-based false positives)
      return json(200, { state: 'unknown' });
    }

    if (path === '/api/slack/status') {
      try {
        const data = await fetchJson('https://status.slack.com/api/v2.0.0/current');
        if (data && Array.isArray(data.active_incidents) && data.active_incidents.length > 0) {
          const inc = data.active_incidents[0];
          const title = inc.title || inc.name || 'Service Incident';
          const isCritical = (inc.type && String(inc.type).toLowerCase().includes('outage')) || /outage|down|unavailable/i.test(title);
          return json(200, { state: 'incident', severity: isCritical ? 'critical' : 'minor', title, eta: inc.date_end || inc.resolution_time || null });
        }
        if (data && Array.isArray(data.active_incidents) && data.active_incidents.length === 0) {
          return json(200, { state: 'operational' });
        }
        if (data && typeof data.status === 'string') {
          const s = data.status.toLowerCase();
          if (s === 'ok') return json(200, { state: 'operational' });
          if (s === 'active') return json(200, { state: 'incident', severity: 'minor', title: 'Active incident' });
        }
        // Fall through to HTML scrape if API returned unexpected payload
      } catch {
        // Ignore and try HTML scrape
      }

      try {
        const html = await fetchText('https://status.slack.com/');
        const plain = html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
        const text = plain.toLowerCase();
        const allOk = /all systems operational|all systems normal|no incidents reported|no known issues|slack is (operating|up and running) (normally|normal)?/i.test(plain) || /operational\s*$/.test(text);
        const hasCritical = /(major outage|critical outage|service (outage|down)|widespread disruption)/i.test(plain);
        const hasMinor = /(partial outage|degraded performance|degradation|incident|investigating|identified|monitoring)/i.test(plain);
        const snippet = (()=>{ const s=plain.split(/(?<=[.!?])\s+/); const i=s.findIndex(t=>/outage|incident|degrad|disruption|unavail|maintenance|investigating|identified|monitoring|resolved|restored/i.test(t)); return i>=0?s[i].trim().slice(0,240):''; })();
        if (allOk) return json(200, { state: 'operational' });
        if (hasCritical) return json(200, { state: 'incident', severity: 'critical', title: snippet || 'Detected outage from Slack Status' });
        if (hasMinor) return json(200, { state: 'incident', severity: 'minor', title: snippet || 'Detected degraded service from Slack Status' });
        // Inconclusive HTML → do NOT assume green
        return json(200, { state: 'unknown' });
      } catch {
        return json(200, { state: 'unknown' });
      }
    }

    // Normalize Statuspage-based services with optional last resolved incident
    if (path.startsWith('/api/statuspage')) {
      const params = event.queryStringParameters || {};
      let base = params.base;
      if (!base && event.rawQuery) {
        const m = event.rawQuery.match(/(?:^|&)base=([^&]+)/);
        if (m) base = decodeURIComponent(m[1]);
      }
      if (!base) return json(400, { error: 'Missing base' });
      try {
        const summaryUrl = new URL('/api/v2/summary.json', base).toString();
        const incidentsUrl = new URL('/api/v2/incidents.json', base).toString();

        const getJson = (u) => new Promise((resolve, reject) => {
          const lib = u.startsWith('http:') ? http : https;
          lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'application/json' } }, (r) => {
            const b = []; r.on('data', c => b.push(c)); r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b).toString('utf8'))); } catch(e){ reject(e); } });
          }).on('error', reject);
        });

        const summary = await getJson(summaryUrl);
        if (summary && Array.isArray(summary.incidents)) {
          const active = summary.incidents.find(i => i.status !== 'resolved');
          if (active) {
            const impact = (active.impact || active.impact_override || 'minor').toLowerCase();
            const severity = (impact === 'critical' || impact === 'major') ? 'critical' : 'minor';
            const startedAt = active.started_at || active.created_at || null;
            return json(200, { state: 'incident', severity, title: active.name || 'Service Incident', eta: null, detail: null, startedAt });
          }
        }
        // No active incidents: fetch last resolved
        let lastIncident = null;
        try {
          const incidents = await getJson(incidentsUrl);
          if (Array.isArray(incidents)) {
            const resolved = incidents.find(i => i.status === 'resolved');
            if (resolved) lastIncident = { title: resolved.name || 'Resolved incident', endedAt: resolved.resolved_at || resolved.updated_at || null };
          }
        } catch (_) {}
        return json(200, lastIncident ? { state: 'operational', lastIncident } : { state: 'operational' });
      } catch {
        return json(502, { state: 'unknown' });
      }
    }

    // Slack diagnostics to understand unknown cases
    if (path === '/api/slack/debug') {
      try {
        const currentUrl = 'https://status.slack.com/api/v2.0.0/current';
        const currentResp = await httpGetFollow(currentUrl, { 'Accept': 'application/json' });
        let parsed = null; let parseError = null;
        try { parsed = JSON.parse(currentResp.body); } catch (e) { parseError = String(e && e.message || 'parse_error'); }

        const htmlUrl = 'https://status.slack.com/';
        const htmlResp = await httpGetFollow(htmlUrl, { 'Accept': 'text/html' });
        const plain = htmlResp.body.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
        const allOk = /all systems operational|all systems normal|no incidents reported|no known issues|slack is (operating|up and running) (normally|normal)?/i.test(plain);
        const hasCritical = /(major outage|critical outage|service (outage|down)|widespread disruption)/i.test(plain);
        const hasMinor = /(partial outage|degraded performance|degradation|incident|maintenance|investigating|identified|monitoring)/i.test(plain);

        return json(200, { current: { statusCode: currentResp.statusCode, bodySample: currentResp.body.slice(0,400), parsed, parseError }, html: { statusCode: htmlResp.statusCode, bodySample: plain.slice(0,400), allOk, hasCritical, hasMinor } });
      } catch {
        return json(502, { error: 'diag_error' });
      }
    }

    if (path === '/api/facebook/status') {
      const body = await fetchText('https://metastatus.com/');
      const plain = body.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      const allOk = /all systems operational|no incidents reported|no known issues/i.test(plain) || /operational\s*$/.test(plain.toLowerCase());
      const hasInvestigating = /(investigating|identified|monitoring|ongoing|current incident)/i.test(plain);
      const hasCritical = /(major outage|critical outage|service (outage|down)|widespread disruption)/i.test(plain);
      const hasMinor = /(partial outage|degraded performance|degradation|disruption)/i.test(plain);
      const snippet = (()=>{ const s=plain.split(/(?<=[.!?])\s+/); const i=s.findIndex(t=>/outage|incident|degrad|disruption|unavail|resolved|restored|closed/i.test(t)); return i>=0?s[i].trim().slice(0,240):''; })();
      if (allOk) return json(200, { state: 'operational' });
      if (hasInvestigating && (hasCritical || hasMinor)) return json(200, { state: 'incident', severity: hasCritical?'critical':'minor', title: snippet || 'Detected incident' });
      if (hasCritical || hasMinor) return json(200, { state: 'operational', lastIncident: { title: snippet, endedAt: null } });
      return json(200, { state: 'operational' });
    }

    // Notifications: check if Slack notifications are enabled (via env)
    if (path === '/api/notify/enabled') {
      const enabled = Boolean(process.env.SLACK_WEBHOOK_URL) || (Boolean(process.env.SLACK_BOT_TOKEN) && Boolean(process.env.SLACK_CHANNEL));
      return json(200, { enabled });
    }

    // Notifications: send Slack message via webhook or bot token
    if (path === '/api/notify/slack' && event.httpMethod === 'POST') {
      try {
        const payload = event.body ? JSON.parse(event.body) : {};
        const text = (() => {
          const severityEmoji = payload.severity === 'critical' ? ':red_circle:' : ':large_yellow_circle:';
          const title = payload.title || 'Service Incident';
          const name = payload.service || 'Service';
          const eta = payload.eta ? `\nPlanned fix: ${new Date(payload.eta).toLocaleString()}` : '';
          const link = payload.statusUrl ? `\nStatus: ${payload.statusUrl}` : '';
          return `${severityEmoji} ${name}: ${title}${eta}${link}`;
        })();

        const webhook = process.env.SLACK_WEBHOOK_URL || '';
        const botToken = process.env.SLACK_BOT_TOKEN || '';
        const channel = process.env.SLACK_CHANNEL || '';

        // Prefer webhook if available
        if (webhook) {
          const u = new URL(webhook);
          const lib = u.protocol === 'http:' ? http : https;
          const resp = await new Promise((resolve) => {
            const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ServiceStatusDashboard/1.0' } }, (r) => {
              const b = []; r.on('data', c => b.push(c)); r.on('end', () => resolve({ statusCode: r.statusCode || 0, body: Buffer.concat(b).toString('utf8') }));
            });
            req.on('error', () => resolve({ statusCode: 0, body: '' }));
            req.end(JSON.stringify({ text }));
          });
          if (resp.statusCode >= 200 && resp.statusCode < 300) return json(200, { ok: true });
          return json(502, { ok: false, error: 'Webhook error' });
        }

        // Fallback: bot token + channel
        if (botToken && channel) {
          const u = new URL('https://slack.com/api/chat.postMessage');
          const lib = u.protocol === 'http:' ? http : https;
          const resp = await new Promise((resolve) => {
            const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': `Bearer ${botToken}`, 'User-Agent': 'ServiceStatusDashboard/1.0' } }, (r) => {
              const b = []; r.on('data', c => b.push(c)); r.on('end', () => resolve({ statusCode: r.statusCode || 0, body: Buffer.concat(b).toString('utf8') }));
            });
            req.on('error', () => resolve({ statusCode: 0, body: '' }));
            req.end(JSON.stringify({ channel, text }));
          });
          if (resp.statusCode >= 200 && resp.statusCode < 300) return json(200, { ok: true });
          return json(502, { ok: false, error: 'Slack API error' });
        }

        // Not configured; succeed no-op
        return json(204, {});
      } catch {
        return json(400, { ok: false, error: 'Bad Request' });
      }
    }

    if (path === '/api/firebase/status') {
      const getJson = (u) => new Promise((resolve, reject) => {
        const lib = u.startsWith('http:') ? http : https;
        lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'application/json' } }, (r) => {
          const b = []; r.on('data', c => b.push(c)); r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b).toString('utf8'))); } catch(e){ reject(e); } });
        }).on('error', reject);
      });
      const products = await getJson('https://status.firebase.google.com/products.json');
      const incidents = await getJson('https://status.firebase.google.com/incidents.json');
      const idByTitle = Object.fromEntries((products.products || []).map(p => [p.title.toLowerCase(), p.id]));
      const remoteConfigId = idByTitle['remote config'] || idByTitle['remoteconfig'] || '5AgCVXiY8zJMBbruVrm8';
      const authId = idByTitle['authentication'] || 'ty5dcfcAmf92kaN1vKuj';
      const crashId = idByTitle['crashlytics'] || 'BevPfAqaWeJzx9e2SWic';
      const selected = new Set([authId, remoteConfigId, crashId]);
      const active = [];
      for (const inc of incidents) {
        if (inc.end) continue;
        let pids = [];
        if (Array.isArray(inc.affected_products)) pids = inc.affected_products.map(p => p.id);
        if (Array.isArray(inc.products)) pids = pids.concat(inc.products);
        const related = pids.filter(pid => selected.has(pid));
        if (related.length) {
          const lastUpdate = Array.isArray(inc.updates) && inc.updates.length ? inc.updates[inc.updates.length-1] : null;
          const title = inc.external_desc || (lastUpdate && lastUpdate.text) || 'Active incident';
          const impact = (inc.status_impact || '').toLowerCase();
          const severity = /outage|high/.test(impact) ? 'critical' : 'minor';
          active.push({ title, severity });
        }
      }
      return json(200, active.length ? { state: 'incident', severity: active[0].severity, title: active[0].title } : { state: 'operational' });
    }

    // Proxy statuspage-like endpoints
    if (path.startsWith('/api/fetch')) {
      const params = event.queryStringParameters || {};
      let urlParam = params.url;
      if (!urlParam && event.rawQuery) {
        const m = event.rawQuery.match(/(?:^|&)url=([^&]+)/);
        if (m) urlParam = decodeURIComponent(m[1]);
      }
      if (!urlParam) return json(400, { error: 'Missing url' });

      let u;
      if (urlParam.startsWith('/')) {
        const host = (event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || 'localhost';
        const proto = (event.headers && (event.headers['x-forwarded-proto'] || event.headers['x-forwarded-protocol'])) || 'https';
        let rel = urlParam;
        if (rel.startsWith('/api/')) rel = '/.netlify/functions/api' + rel.substring(4);
        u = new URL(`${proto}://${host}${rel}`);
      } else {
        u = new URL(urlParam);
      }
      const lib = u.protocol === 'http:' ? http : https;
      const resp = await new Promise((resolve) => {
        const req = lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'application/json,text/plain,*/*' } }, (r) => {
          const b = []; r.on('data', c => b.push(c)); r.on('end', () => resolve({ statusCode: r.statusCode || 200, headers: r.headers, body: Buffer.concat(b).toString('utf8') }));
        });
        req.on('error', () => resolve({ statusCode: 502, headers: {}, body: 'Proxy error' }));
      });
      return { statusCode: resp.statusCode, headers: { 'Content-Type': resp.headers['content-type'] || 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, body: resp.body };
    }

    // HTML heuristic checker for non-API status pages (shared logic)
    if (path.startsWith('/api/check-html')) {
      const params = event.queryStringParameters || {};
      let urlParam = params.url;
      if (!urlParam && event.rawQuery) {
        const m = event.rawQuery.match(/(?:^|&)url=([^&]+)/);
        if (m) urlParam = decodeURIComponent(m[1]);
      }
      if (!urlParam) return json(400, { error: 'Missing url' });
      try {
        const result = await utils.analyzeHtmlFromUrl(urlParam);
        return json(200, result);
      } catch {
        return json(502, { state: 'unknown' });
      }
    }

    // Alias for monitor function so it can be invoked via /api/monitor
    if (path === '/api/monitor') {
      try {
        const base = (event.headers && (event.headers['x-forwarded-proto'] || event.headers['x-forwarded-protocol'] || 'https')) + '://' + ((event.headers && (event.headers['x-forwarded-host'] || event.headers.host)) || '');
        const u = new URL('/.netlify/functions/monitor', base);
        const lib = u.protocol === 'http:' ? http : https;
        const resp = await new Promise((resolve) => {
          const req = lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0' } }, (r) => {
            const b = []; r.on('data', c => b.push(c)); r.on('end', () => resolve({ statusCode: r.statusCode || 200, body: Buffer.concat(b).toString('utf8') }));
          });
          req.on('error', () => resolve({ statusCode: 502, body: 'error' }));
        });
        return { statusCode: resp.statusCode, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, body: resp.body || 'ok' };
      } catch {
        return json(502, { error: 'Monitor invoke error' });
      }
    }

    return json(404, { error: 'Not found' });
  } catch (e) {
    return json(500, { error: 'Server error' });
  }
};


