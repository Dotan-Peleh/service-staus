'use strict';

const http = require('http');
const https = require('https');

function sendJson(cb, status, obj) {
  cb(null, {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(obj),
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https;
    lib.get(url, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': '*/*' } }, (r) => {
      const b = [];
      r.on('data', c => b.push(c));
      r.on('end', () => resolve(Buffer.concat(b).toString('utf8')));
    }).on('error', reject);
  });
}

exports.handler = async (event, context, cb) => {
  try {
    const path = event.path.replace(/^\/.netlify\/functions\//, '/');
    if (path === '/api/apple/status') {
      // Apple System Status (JSON then JS fallback)
      let body = await fetchText('https://www.apple.com/support/systemstatus/data/system_status_en_US.json');
      let data;
      try { data = JSON.parse(body); } catch {
        body = await fetchText('https://www.apple.com/support/systemstatus/data/system_status_en_US.js');
        const start = body.indexOf('{'); const end = body.lastIndexOf('}');
        if (start >= 0 && end > start) data = JSON.parse(body.slice(start, end + 1));
      }
      if (!data || !Array.isArray(data.services)) return sendJson(cb, 502, { state: 'unknown' });
      const target = new Set(['app store','app store connect']);
      let hasIncident = false; let detail = '';
      for (const svc of data.services) {
        const name = String(svc.serviceName || '').toLowerCase();
        if (!target.has(name)) continue;
        const events = Array.isArray(svc.events) ? svc.events : [];
        const active = events.find(e => !e.endDate || (e.eventStatus && String(e.eventStatus).toLowerCase() !== 'resolved'));
        if (active) { hasIncident = true; detail = active.message || active.userFacingStatus || active.eventStatus || ''; break; }
      }
      return sendJson(cb, 200, hasIncident ? { state: 'incident', severity: 'minor', title: 'Apple App Store incident', detail } : { state: 'operational' });
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
      if (allOk) return sendJson(cb, 200, { state: 'operational' });
      if ((hasMajor||hasMinor) && hasInvestigating) return sendJson(cb, 200, { state: 'incident', severity: hasMajor?'critical':'minor', title: snippet || 'Detected incident' });
      if (hasMajor||hasMinor) return sendJson(cb, 200, { state: 'operational', lastIncident: { title: snippet, endedAt: null } });
      return sendJson(cb, 200, { state: 'operational' });
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
      if (allOk) return sendJson(cb, 200, { state: 'operational' });
      if ((hasMajor||hasMinor) && hasInvestigating) return sendJson(cb, 200, { state: 'incident', severity: hasMajor?'critical':'minor', title: snippet || 'Detected incident' });
      if (hasMajor||hasMinor) return sendJson(cb, 200, { state: 'operational', lastIncident: { title: snippet, endedAt: null } });
      return sendJson(cb, 200, { state: 'operational' });
    }

    if (path === '/api/facebook/status') {
      const body = await fetchText('https://metastatus.com/');
      const plain = body.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      const allOk = /all systems operational|no incidents reported|no known issues/i.test(plain) || /operational\s*$/.test(plain.toLowerCase());
      const hasInvestigating = /(investigating|identified|monitoring|ongoing|current incident)/i.test(plain);
      const hasCritical = /(major outage|critical outage|service (outage|down)|widespread disruption)/i.test(plain);
      const hasMinor = /(partial outage|degraded performance|degradation|disruption)/i.test(plain);
      const snippet = (()=>{ const s=plain.split(/(?<=[.!?])\s+/); const i=s.findIndex(t=>/outage|incident|degrad|disruption|unavail|resolved|restored|closed/i.test(t)); return i>=0?s[i].trim().slice(0,240):''; })();
      if (allOk) return sendJson(cb, 200, { state: 'operational' });
      if (hasInvestigating && (hasCritical || hasMinor)) return sendJson(cb, 200, { state: 'incident', severity: hasCritical?'critical':'minor', title: snippet || 'Detected incident' });
      if (hasCritical || hasMinor) return sendJson(cb, 200, { state: 'operational', lastIncident: { title: snippet, endedAt: null } });
      return sendJson(cb, 200, { state: 'operational' });
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
      return sendJson(cb, 200, active.length ? { state: 'incident', severity: active[0].severity, title: active[0].title } : { state: 'operational' });
    }

    // Proxy statuspage-like endpoints
    if (path.startsWith('/api/fetch')) {
      const target = new URL(event.rawQuery || '', 'http://localhost');
      const urlParam = target.searchParams.get('url');
      if (!urlParam) return sendJson(cb, 400, { error: 'Missing url' });
      const u = new URL(urlParam);
      const lib = u.protocol === 'http:' ? http : https;
      const resp = await new Promise((resolve) => {
        const req = lib.get(u, { headers: { 'User-Agent': 'ServiceStatusDashboard/1.0', 'Accept': 'application/json,text/plain,*/*' } }, (r) => {
          const b = []; r.on('data', c => b.push(c)); r.on('end', () => resolve({ statusCode: r.statusCode || 200, headers: r.headers, body: Buffer.concat(b).toString('utf8') }));
        });
        req.on('error', () => resolve({ statusCode: 502, headers: {}, body: 'Proxy error' }));
      });
      return cb(null, { statusCode: resp.statusCode, headers: { 'Content-Type': resp.headers['content-type'] || 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, body: resp.body });
    }

    // HTML heuristic checker for non-API status pages
    if (path.startsWith('/api/check-html')) {
      const target = new URL(event.rawQuery || '', 'http://localhost');
      const urlParam = target.searchParams.get('url');
      if (!urlParam) return sendJson(cb, 400, { error: 'Missing url' });
      const u = urlParam;
      try {
        const body = await fetchText(u);
        const plain = body.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
        const text = plain.toLowerCase();
        const hasAllOperational = /all systems operational|all services operational|all services (are|now) (available|online)|no incidents reported/i.test(plain) || /operational\s*$/.test(text);
        const hasMajor = /(major outage|critical outage|critical incident|severe outage|service (outage|down))/i.test(plain);
        const hasMinor = /(partial outage|degraded performance|degradation|incident|maintenance|scheduled maintenance)/i.test(plain);
        let result;
        if (hasMajor) result = { state: 'incident', severity: 'critical', title: 'Detected outage from status page', eta: null };
        else if (hasMinor) result = { state: 'incident', severity: 'minor', title: 'Detected degraded service from status page', eta: null };
        else if (hasAllOperational || /operational/.test(text)) result = { state: 'operational' };
        else result = { state: 'unknown' };
        return sendJson(cb, 200, result);
      } catch {
        return sendJson(cb, 502, { state: 'unknown' });
      }
    }

    return sendJson(cb, 404, { error: 'Not found' });
  } catch (e) {
    return sendJson(cb, 500, { error: 'Server error' });
  }
};


