'use strict';

const http = require('http');
const https = require('https');

const USER_AGENT = 'ServiceStatusDashboard/1.0';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http:') ? http : https;
    lib.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': '*/*', 'Accept-Encoding': 'identity' } }, (r) => {
      const b = [];
      r.on('data', c => b.push(c));
      r.on('end', () => resolve(Buffer.concat(b).toString('utf8')));
    }).on('error', reject);
  });
}

function fetchJson(u) {
  return new Promise((resolve, reject) => {
    const lib = u.startsWith('http:') ? http : https;
    lib.get(u, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json', 'Accept-Encoding': 'identity' } }, (r) => {
      const b = []; r.on('data', c => b.push(c)); r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b).toString('utf8'))); } catch(e){ reject(e); } });
    }).on('error', reject);
  });
}

function parseStatuspageSummary(summary) {
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

function htmlToPlain(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function analyzePlainStatusText(plain) {
  const text = plain.toLowerCase();
  const hasAllOperational = /all systems operational|all services operational|all services (are|now) (available|online)|no incidents reported|no known issues/i.test(plain) || /operational\s*$/.test(text);
  const hasMajor = /(major outage|critical outage|critical incident|severe outage|service (outage|down))/i.test(plain);
  // Exclude generic maintenance terms to reduce false positives on green pages
  const hasMinor = /(partial outage|degraded performance|degradation|incident)/i.test(plain);
  // If the page explicitly states all systems operational, trust that over incidental words
  if (hasAllOperational) return { state: 'operational' };
  if (hasMajor) return { state: 'incident', severity: 'critical', title: 'Detected outage from status page', eta: null };
  if (hasMinor) return { state: 'incident', severity: 'minor', title: 'Detected degraded service from status page', eta: null };
  if (/operational/.test(text)) return { state: 'operational' };
  return { state: 'unknown' };
}

async function analyzeHtmlFromUrl(url) {
  const body = await fetchText(url);
  const plain = htmlToPlain(body);
  const result = analyzePlainStatusText(plain);
  if (result.state === 'incident') {
    const sentences = plain.split(/(?<=[.!?])\s+/).slice(0, 50);
    const idx = sentences.findIndex(s => /outage|disruption|degrad|incident|maintenance|unavail/i.test(s));
    if (idx >= 0) result.detail = sentences[idx].trim().slice(0, 240);
  }
  return result;
}

function formatSlackMessage(p) {
  const severityEmoji = p.severity === 'critical' ? ':red_circle:' : ':large_yellow_circle:';
  const title = p.title || 'Service Incident';
  const name = p.service || 'Service';
  const eta = p.eta ? `\nPlanned fix: ${new Date(p.eta).toLocaleString()}` : '';
  const link = p.statusUrl ? `\nStatus: ${p.statusUrl}` : '';
  return `${severityEmoji} ${name}: ${title}${eta}${link}`;
}

module.exports = {
  USER_AGENT,
  fetchText,
  fetchJson,
  parseStatuspageSummary,
  htmlToPlain,
  analyzePlainStatusText,
  analyzeHtmlFromUrl,
  formatSlackMessage,
};


