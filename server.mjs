#!/usr/bin/env node
import http from "node:http";

const DEFAULT_CLIPROXY_BASE_URL = "http://127.0.0.1:8317";
const DEFAULT_PORT = 8765;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USER_AGENT = "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cliproxyHeaders() {
  return { Authorization: `Bearer ${requiredEnv("CLIPROXY_MANAGEMENT_KEY")}` };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON response (${response.status}): ${text.slice(0, 240)}`);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readJson(response);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(body)}`);
  return body;
}

function cliproxyUrl(path) {
  const base = process.env.CLIPROXY_BASE_URL?.trim() || DEFAULT_CLIPROXY_BASE_URL;
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function listCodexAuthFiles() {
  const data = await fetchJson(cliproxyUrl("/v0/management/auth-files"), {
    headers: cliproxyHeaders(),
  });

  return (Array.isArray(data?.files) ? data.files : [])
    .filter((file) => file?.provider === "codex" && file?.disabled !== true)
    .map((file) => ({
      authIndex: String(file.auth_index || ""),
      email: String(file.email || file.account || file.label || "unknown"),
      planType: String(file.id_token?.plan_type || file.account_type || "unknown"),
      accountId: String(file.id_token?.chatgpt_account_id || ""),
      status: String(file.status || "unknown"),
      statusMessage: typeof file.status_message === "string" ? file.status_message : "",
      nextRetryAfter: typeof file.next_retry_after === "string" ? file.next_retry_after : null,
    }))
    .filter((file) => file.authIndex && file.accountId);
}

async function callCodexUsage(file) {
  const data = await fetchJson(cliproxyUrl("/v0/management/api-call"), {
    method: "POST",
    headers: {
      ...cliproxyHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_index: file.authIndex,
      method: "GET",
      url: CODEX_USAGE_URL,
      header: {
        Authorization: "Bearer $TOKEN$",
        "Chatgpt-Account-Id": file.accountId,
        "User-Agent": CODEX_USER_AGENT,
        Originator: "codex_cli_rs",
        Accept: "application/json",
      },
    }),
  });

  const body = typeof data?.body === "string" ? JSON.parse(data.body) : data?.body;
  if (data?.status_code < 200 || data?.status_code >= 300) {
    throw new Error(`Codex usage call returned ${data?.status_code}: ${JSON.stringify(body)}`);
  }
  return body;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function epochSecondsToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number * 1000).toISOString();
}

function parseStatusReset(statusMessage) {
  if (!statusMessage) return null;
  try {
    return epochSecondsToIso(JSON.parse(statusMessage)?.error?.resets_at);
  } catch {
    return null;
  }
}

function normalizeAccount(file, usage) {
  const rateLimit = usage?.rate_limit || {};
  const primary = rateLimit.primary_window || {};
  const secondary = rateLimit.secondary_window || {};
  const fiveHourUsed = clampPercent(primary.used_percent);
  const weeklyUsed = clampPercent(secondary.used_percent);

  return {
    email: String(usage?.email || file.email),
    planType: String(usage?.plan_type || file.planType),
    allowed: rateLimit.allowed === true && rateLimit.limit_reached !== true,
    limitReached: rateLimit.limit_reached === true,
    reachedType: usage?.rate_limit_reached_type?.type || null,
    nextRetryAfter: file.nextRetryAfter,
    statusResetAt: parseStatusReset(file.statusMessage),
    windows: {
      fiveHour: {
        usedPercent: fiveHourUsed,
        remainingPercent: 100 - fiveHourUsed,
        resetAt: epochSecondsToIso(primary.reset_at),
        windowSeconds: Number(primary.limit_window_seconds || 0),
      },
      weekly: {
        usedPercent: weeklyUsed,
        remainingPercent: 100 - weeklyUsed,
        resetAt: epochSecondsToIso(secondary.reset_at),
        windowSeconds: Number(secondary.limit_window_seconds || 0),
      },
    },
  };
}

function isoBy(values, pick) {
  const times = values.filter(Boolean).map((value) => Date.parse(value)).filter(Number.isFinite);
  if (times.length === 0) return null;
  return new Date(pick(...times)).toISOString();
}

function summarizeWindow(accounts, windowKey) {
  // For the 5h window, exclude accounts with exhausted weekly quota (0% remaining).
  // These accounts cannot be used even if they have 5h quota available.
  const effectiveAccounts = windowKey === "fiveHour"
    ? accounts.filter((account) => account.windows.weekly?.remainingPercent > 0.01)
    : accounts;

  const windows = effectiveAccounts.map((account) => account.windows[windowKey]).filter(Boolean);
  const remainingUnits = windows.reduce((sum, window) => sum + window.remainingPercent, 0);
  const exhausted = effectiveAccounts.filter((account) => account.windows[windowKey]?.remainingPercent <= 0.01);

  return {
    accountCount: windows.length,
    usedPercent: windows.length ? windows.reduce((sum, window) => sum + window.usedPercent, 0) / windows.length : 0,
    remainingPercent: windows.length ? remainingUnits / windows.length : 0,
    capacityUnits: windows.length * 100,
    remainingUnits,
    exhaustedCount: exhausted.length,
    nextRefillAt: isoBy(exhausted.map((account) => account.windows[windowKey]?.resetAt), Math.min),
    allCurrentUsageClearsAt: isoBy(
      effectiveAccounts
        .filter((account) => account.windows[windowKey]?.usedPercent > 0.01)
        .map((account) => account.windows[windowKey]?.resetAt),
      Math.max,
    ),
  };
}

function summarizeAccounts(accounts) {
  const blockedAccounts = accounts.filter((account) => !account.allowed);
  return {
    generatedAt: new Date().toISOString(),
    source: "cliproxyapi:/v0/management/api-call -> chatgpt.com/backend-api/wham/usage",
    accountCount: accounts.length,
    readyAccountCount: accounts.filter((account) => account.allowed).length,
    blockedAccountCount: blockedAccounts.length,
    nextAccountReadyAt: isoBy(
      blockedAccounts.map((account) => (
        account.statusResetAt
        || account.nextRetryAfter
        || account.windows.weekly.resetAt
        || account.windows.fiveHour.resetAt
      )),
      Math.min,
    ),
    windows: {
      fiveHour: summarizeWindow(accounts, "fiveHour"),
      weekly: summarizeWindow(accounts, "weekly"),
    },
    accounts,
  };
}

export async function buildQuotaSnapshot() {
  const files = await listCodexAuthFiles();
  const results = await Promise.allSettled(files.map(async (file) => normalizeAccount(file, await callCodexUsage(file))));
  const accounts = [];
  const errors = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "fulfilled") {
      accounts.push(result.value);
    } else {
      errors.push({
        email: files[index]?.email || "unknown",
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  return { ...summarizeAccounts(accounts), errorCount: errors.length, errors };
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(body, null, 2));
}

function requestAuthorized(requestUrl) {
  const expected = process.env.CODEX_QUOTA_WIDGET_TOKEN?.trim();
  return !expected || requestUrl.searchParams.get("token") === expected;
}

export function createServer() {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    try {
      if (requestUrl.pathname === "/health") {
        sendJson(response, 200, { ok: true });
      } else if (requestUrl.pathname !== "/quota") {
        sendJson(response, 404, { error: "not found" });
      } else if (!requestAuthorized(requestUrl)) {
        sendJson(response, 401, { error: "invalid widget token" });
      } else {
        sendJson(response, 200, await buildQuotaSnapshot());
      }
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.CODEX_QUOTA_WIDGET_PORT || DEFAULT_PORT);
  const host = process.env.CODEX_QUOTA_WIDGET_HOST || "127.0.0.1";
  createServer().listen(port, host, () => {
    console.log(`codex-quota-widget listening on http://${host}:${port}/quota`);
  });
}
