#!/usr/bin/env node
// Runs every check in config/services.json, records the results in docs/data/status.json
// (read by the status page) and emails an alert when a service goes down or recovers.
//
// Run by .github/workflows/status.yml every 5 minutes. Locally: `npm run check`
// (without SMTP env vars, the email check reports "unknown" and alerts are only logged).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'services.json');
const DATA_PATH = path.join(ROOT, 'docs', 'data', 'status.json');

const HISTORY_DAYS = 90;
const MAX_INCIDENTS = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
// Slower than this counts as "degraded" (shown in yellow, no email).
const DEFAULT_SLOW_MS = 5_000;
// A failing check is retried before it counts, so one network blip on the GitHub runner
// doesn't email anyone.
const RETRIES = 2;
const RETRY_DELAY_MS = 10_000;
const MAX_MESSAGE_LENGTH = 200;
const USER_AGENT = 'HestyStatus/1.0';

const SEVERITY = { up: 0, unknown: 0, degraded: 1, down: 2 };
const isProblem = (status) => status === 'down' || status === 'degraded';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Atlassian Statuspage component statuses → ours.
const COMPONENT_STATUS = {
  operational: 'up',
  degraded_performance: 'degraded',
  partial_outage: 'degraded',
  under_maintenance: 'degraded',
  major_outage: 'down',
};
const COMPONENT_LABEL = {
  degraded_performance: 'degraded performance',
  partial_outage: 'partial outage',
  under_maintenance: 'under maintenance',
  major_outage: 'major outage',
};
const INDICATOR_STATUS = { none: 'up', minor: 'degraded', maintenance: 'degraded', major: 'down', critical: 'down' };

const describeError = (error, timeoutMs) => {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `No response after ${Math.round(timeoutMs / 1000)}s`;
  }
  const code = error?.cause?.code ?? error?.code;
  return code ? `${code}: ${error.cause?.message ?? error.message}` : (error?.message ?? String(error));
};

const truncate = (text) =>
  text && text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;

const timed = async (fn) => {
  const started = Date.now();
  const value = await fn();
  return { value, latencyMs: Date.now() - started };
};

// --- checks: each returns { status: 'up'|'degraded'|'down'|'unknown', latencyMs?, message? }

async function checkHttp(service) {
  const timeoutMs = service.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { value: res, latencyMs } = await timed(async () => {
    const response = await fetch(service.url, {
      method: service.method ?? 'GET',
      headers: { 'user-agent': USER_AGENT, ...service.headers },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, text: await response.text() };
  });
  const expected = service.expectStatus ? [service.expectStatus].flat() : null;
  const statusOk = expected ? expected.includes(res.status) : res.status >= 200 && res.status < 400;
  if (!statusOk) return { status: 'down', latencyMs, message: `HTTP ${res.status}` };
  if (service.contains && !res.text.includes(service.contains)) {
    return { status: 'down', latencyMs, message: 'Unexpected response content' };
  }
  if (latencyMs > (service.slowMs ?? DEFAULT_SLOW_MS)) {
    return { status: 'degraded', latencyMs, message: `Slow response (${latencyMs} ms)` };
  }
  return { status: 'up', latencyMs };
}

async function checkJsonRpc(service) {
  const timeoutMs = service.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { value: body, latencyMs } = await timed(async () => {
    const response = await fetch(service.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
  if (body.error || !body.result?.timestamp) {
    return { status: 'down', latencyMs, message: body.error?.message ?? 'No block returned' };
  }
  const ageSec = Math.round(Date.now() / 1000 - Number.parseInt(body.result.timestamp, 16));
  if (ageSec > (service.maxBlockAgeSec ?? 60)) {
    return { status: 'degraded', latencyMs, message: `Latest block is ${ageSec}s old` };
  }
  if (latencyMs > (service.slowMs ?? DEFAULT_SLOW_MS)) {
    return { status: 'degraded', latencyMs, message: `Slow response (${latencyMs} ms)` };
  }
  return { status: 'up', latencyMs };
}

// A provider's own Atlassian Statuspage, limited to the components Hesty uses.
async function checkStatuspage(service) {
  const timeoutMs = service.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let summary;
  try {
    const response = await fetch(`${service.page}/api/v2/summary.json`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    summary = await response.json();
  } catch (error) {
    // Their status page being unreachable doesn't mean their service is down.
    return { status: 'unknown', message: `Status page unreachable (${describeError(error, timeoutMs)})` };
  }

  if (!service.components?.length) {
    const status = INDICATOR_STATUS[summary.status?.indicator] ?? 'unknown';
    return { status, message: status === 'up' ? undefined : summary.status?.description };
  }

  const groups = new Map(summary.components.map((c) => [c.id, c.name]));
  const labelOf = (c) => (c.group_id ? `${groups.get(c.group_id)} > ${c.name}` : c.name);
  const selected = summary.components.filter((c) => service.components.includes(labelOf(c)));
  if (!selected.length) {
    return { status: 'unknown', message: 'Configured components not found on the status page' };
  }

  let status = 'up';
  const affected = [];
  for (const component of selected) {
    const mapped = COMPONENT_STATUS[component.status] ?? 'unknown';
    if (SEVERITY[mapped] > SEVERITY[status]) status = mapped;
    if (mapped !== 'up') affected.push(`${labelOf(component)}: ${COMPONENT_LABEL[component.status] ?? component.status}`);
  }
  if (status === 'up') return { status };

  const selectedIds = new Set(selected.map((c) => c.id));
  const incident = (summary.incidents ?? []).find((i) => (i.components ?? []).some((c) => selectedIds.has(c.id)));
  return { status, message: [incident?.name, affected.join('; ')].filter(Boolean).join(' · ') };
}

const smtpTransport = (prefix) => {
  const host = process.env[`${prefix}HOST`];
  if (!host) return null;
  const port = Number(process.env[`${prefix}PORT`] ?? 587);
  const user = process.env[`${prefix}USER`];
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass: process.env[`${prefix}PASS`] } : undefined,
    connectionTimeout: DEFAULT_TIMEOUT_MS,
    greetingTimeout: DEFAULT_TIMEOUT_MS,
    socketTimeout: DEFAULT_TIMEOUT_MS,
  });
};

async function checkSmtp() {
  const transport = smtpTransport('SMTP_');
  if (!transport) return { status: 'unknown', message: 'Not configured (SMTP_HOST secret missing)' };
  try {
    const { latencyMs } = await timed(() => transport.verify());
    return { status: 'up', latencyMs };
  } finally {
    transport.close();
  }
}

const CHECKS = { http: checkHttp, jsonrpc: checkJsonRpc, statuspage: checkStatuspage, smtp: checkSmtp };

async function runCheck(service) {
  const check = CHECKS[service.type];
  if (!check) return { status: 'unknown', message: `Unknown check type "${service.type}"` };
  let result;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    try {
      result = await check(service);
    } catch (error) {
      result = { status: 'down', message: describeError(error, service.timeoutMs ?? DEFAULT_TIMEOUT_MS) };
    }
    // Statuspage results are the provider's own verdict; retrying won't change them.
    if (result.status !== 'down' || service.type === 'statuspage') break;
  }
  return { ...result, message: truncate(result.message) };
}

// --- state

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};

const dayKey = (date) => date.toISOString().slice(0, 10);

function recordHistory(history, now, status) {
  const today = dayKey(now);
  const day = (history[today] ??= { checks: 0, down: 0, degraded: 0 });
  day.checks += 1;
  if (status === 'down') day.down += 1;
  if (status === 'degraded') day.degraded += 1;
  const oldest = dayKey(new Date(now.getTime() - (HISTORY_DAYS - 1) * 86_400_000));
  for (const key of Object.keys(history)) if (key < oldest) delete history[key];
  return history;
}

const shouldAlert = (service, status) =>
  service.alert !== false && (status === 'down' || (status === 'degraded' && service.alertOnDegraded === true));

// --- alerts

const formatDuration = (ms) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
};

const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const statusPageUrl = () => {
  if (process.env.STATUS_PAGE_URL) return process.env.STATUS_PAGE_URL;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  return owner && repo ? `https://${owner.toLowerCase()}.github.io/${repo}/` : null;
};

function buildEmail(alerts, config) {
  const down = alerts.filter((a) => a.kind === 'down');
  const recovered = alerts.filter((a) => a.kind === 'recovered');
  const subject =
    alerts.length === 1
      ? down.length
        ? `🔴 ${alerts[0].name} is down`
        : `✅ ${alerts[0].name} is back up`
      : [down.length && `🔴 ${down.length} down`, recovered.length && `✅ ${recovered.length} recovered`]
          .filter(Boolean)
          .join(', ') + ` · ${config.title}`;

  const url = statusPageUrl();
  const row = (a) => {
    const color = a.kind === 'down' ? '#d64545' : '#1f9d6b';
    const label = a.kind === 'down' ? 'Down' : `Back up after ${formatDuration(a.durationMs)}`;
    return `<tr>
      <td style="padding:12px 16px;border-bottom:1px solid #e6eaea">
        <div style="font-weight:600;color:#10292a">${escapeHtml(a.name)} <span style="color:#6b7c7d;font-weight:400">· ${escapeHtml(a.group)}</span></div>
        <div style="color:${color};font-weight:600;margin-top:2px">${escapeHtml(label)}</div>
        ${a.message ? `<div style="color:#4a5b5c;margin-top:4px">${escapeHtml(a.message)}</div>` : ''}
        <div style="color:#8a9a9b;font-size:12px;margin-top:4px">Since ${escapeHtml(new Date(a.startedAt).toUTCString())}</div>
      </td></tr>`;
  };
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto">
    <div style="background:#0f3d3f;color:#00e0b0;padding:16px;font-size:18px;font-weight:700;border-radius:8px 8px 0 0">${escapeHtml(config.title)}</div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e6eaea;border-top:0">${alerts.map(row).join('')}</table>
    ${url ? `<p style="margin:16px 0"><a href="${escapeHtml(url)}" style="background:#197176;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Open status page</a></p>` : ''}
    <p style="color:#8a9a9b;font-size:12px">Sent by the Hesty status monitor. Checks run every ${config.intervalMinutes ?? 5} minutes.</p>
  </div>`;
  const text = alerts
    .map((a) =>
      [
        `${a.name} (${a.group}): ${a.kind === 'down' ? 'DOWN' : `back up after ${formatDuration(a.durationMs)}`}`,
        a.message,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n') + (url ? `\n\n${url}` : '');
  return { subject, html, text };
}

// true: sent (or nothing to send); false: sending failed; null: email not configured.
async function sendAlerts(alerts, config) {
  if (!alerts.length) return true;
  for (const a of alerts) console.log(`ALERT ${a.kind.toUpperCase()}: ${a.name}${a.message ? ` — ${a.message}` : ''}`);

  // ALERT_SMTP_* lets alerts go through a different provider than the Hesty SMTP server
  // being monitored, so "email is down" can still be reported. Falls back to SMTP_*.
  const transport = smtpTransport('ALERT_SMTP_') ?? smtpTransport('SMTP_');
  const to = process.env.ALERT_TO;
  if (!transport || !to) {
    console.warn('Alert email not configured (ALERT_TO / SMTP_HOST missing); skipping.');
    return null;
  }
  const from = process.env.ALERT_FROM ?? process.env.ALERT_SMTP_USER ?? process.env.SMTP_USER;
  try {
    await transport.sendMail({ from, to, ...buildEmail(alerts, config) });
    console.log(`Alert email sent to ${to.split(',').length} recipient(s).`);
    return true;
  } catch (error) {
    console.error(`Failed to send alert email: ${describeError(error, DEFAULT_TIMEOUT_MS)}`);
    return false;
  } finally {
    transport.close();
  }
}

// --- main

async function main() {
  const config = await readJson(CONFIG_PATH);
  const previous = await readJson(DATA_PATH, { services: {}, incidents: [] });
  const now = new Date();
  const nowIso = now.toISOString();

  const services = config.groups.flatMap((group) => group.services.map((s) => ({ ...s, group: group.name })));
  const ids = new Set();
  for (const s of services) {
    if (ids.has(s.id)) throw new Error(`Duplicate service id "${s.id}" in config`);
    ids.add(s.id);
  }

  const results = await Promise.all(services.map(runCheck));

  const incidents = previous.incidents ?? [];
  const alerts = [];
  const data = {
    title: config.title,
    site: config.site,
    generatedAt: nowIso,
    intervalMinutes: config.intervalMinutes ?? 5,
    historyDays: HISTORY_DAYS,
    groups: config.groups.map((g) => ({ name: g.name, services: g.services.map((s) => s.id) })),
    services: {},
    incidents,
  };

  services.forEach((service, index) => {
    const result = results[index];
    const before = previous.services?.[service.id];
    const changed = before?.status !== result.status;
    console.log(
      `${result.status.padEnd(8)} ${service.id}${result.latencyMs != null ? ` ${result.latencyMs}ms` : ''}${result.message ? ` — ${result.message}` : ''}`,
    );

    data.services[service.id] = {
      name: service.name,
      description: service.description,
      group: service.group,
      link: service.link ?? service.page ?? null,
      status: result.status,
      since: changed || !before?.since ? nowIso : before.since,
      checkedAt: nowIso,
      latencyMs: result.latencyMs ?? null,
      message: result.message ?? null,
      history: recordHistory(before?.history ?? {}, now, result.status),
    };

    const open = incidents.find((i) => i.serviceId === service.id && !i.resolvedAt);
    if (isProblem(result.status)) {
      const incident = open ?? {
        id: `${service.id}-${now.getTime()}`,
        serviceId: service.id,
        serviceName: service.name,
        status: result.status,
        message: result.message ?? null,
        startedAt: nowIso,
        resolvedAt: null,
        alerted: false,
      };
      if (!open) incidents.unshift(incident);
      if (SEVERITY[result.status] > SEVERITY[incident.status]) incident.status = result.status;
      if (result.message) incident.message = result.message;
      // Not yet alerted (or the email failed last time): alert now.
      if (!incident.alerted && shouldAlert(service, result.status)) {
        alerts.push({ kind: 'down', incident, name: service.name, group: service.group, message: result.message, startedAt: incident.startedAt });
      }
    } else if (result.status === 'up' && open) {
      open.resolvedAt = nowIso;
      if (open.alerted) {
        alerts.push({
          kind: 'recovered',
          incident: open,
          name: service.name,
          group: service.group,
          message: null,
          startedAt: open.startedAt,
          durationMs: now - new Date(open.startedAt),
        });
      }
    }
  });

  // Incidents for services no longer in the config can never resolve; close them.
  for (const incident of incidents) {
    if (!incident.resolvedAt && !ids.has(incident.serviceId)) incident.resolvedAt = nowIso;
  }

  const sent = await sendAlerts(alerts, config);
  if (sent) for (const a of alerts) if (a.kind === 'down') a.incident.alerted = true;

  const oldest = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();
  data.incidents = incidents.filter((i) => !i.resolvedAt || i.resolvedAt >= oldest).slice(0, MAX_INCIDENTS);

  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  await writeFile(DATA_PATH, `${JSON.stringify(data, null, 1)}\n`);

  // A failed alert email fails the workflow run, so GitHub's own "run failed" email is a
  // second warning channel (e.g. when the email provider itself is what's down).
  if (sent === false) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
