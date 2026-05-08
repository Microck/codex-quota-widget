#!/usr/bin/env node
import http from "node:http";

const DEFAULT_CLIPROXY_BASE_URL = "http://[::1]:8317";
const DEFAULT_PORT = 8765;
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USER_AGENT = "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function cliproxyHeaders() {
  return {
    Authorization: `Bearer ${requiredEnv("CLIPROXY_MANAGEMENT_KEY")}`,
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Invalid JSON response (${response.status}): ${text.slice(0, 240)}`);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(body)}`);
  }
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

  const files = Array.isArray(data?.files) ? data.files : [];
  return files
    .filter((file) => file?.provider === "codex")
    .filter((file) => file?.disabled !== true)
    .map((file) => ({
      authIndex: String(file.auth_index || ""),
      email: String(file.email || file.account || file.label || "unknown"),
      planType: String(file.id_token?.plan_type || file.account_type || "unknown"),
      accountId: String(file.id_token?.chatgpt_account_id || ""),
      status: String(file.status || "unknown"),
      statusMessage: typeof file.status_message === "string" ? file.status_message : "",
      nextRetryAfter: typeof file.next_retry_after === "string" ? file.next_retry_after : null,
      unavailable: file.unavailable === true,
    }))
    .filter((file) => file.authIndex && file.accountId);
}

async function callCodexUsage(file) {
  const payload = {
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
  };

  const data = await fetchJson(cliproxyUrl("/v0/management/api-call"), {
    method: "POST",
    headers: {
      ...cliproxyHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  let body = data?.body;
  if (typeof body === "string") {
    body = JSON.parse(body);
  }
  if (data?.status_code < 200 || data?.status_code >= 300) {
    throw new Error(`Codex usage call returned ${data?.status_code}: ${JSON.stringify(body)}`);
  }
  return body;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(100, number));
}

function epochSecondsToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  return new Date(number * 1000).toISOString();
}

function parseStatusReset(statusMessage) {
  if (!statusMessage) {
    return null;
  }
  try {
    const parsed = JSON.parse(statusMessage);
    return epochSecondsToIso(parsed?.error?.resets_at);
  } catch {
    return null;
  }
}

function normalizeAccount(file, usage) {
  const rateLimit = usage?.rate_limit || {};
  const primary = rateLimit.primary_window || {};
  const secondary = rateLimit.secondary_window || {};
  const primaryUsed = clampPercent(primary.used_percent);
  const secondaryUsed = clampPercent(secondary.used_percent);
  const allowed = rateLimit.allowed === true && rateLimit.limit_reached !== true;

  return {
    email: String(usage?.email || file.email),
    planType: String(usage?.plan_type || file.planType),
    allowed,
    limitReached: rateLimit.limit_reached === true,
    reachedType: usage?.rate_limit_reached_type?.type || null,
    status: file.status,
    nextRetryAfter: file.nextRetryAfter,
    statusResetAt: parseStatusReset(file.statusMessage),
    windows: {
      fiveHour: {
        usedPercent: primaryUsed,
        remainingPercent: 100 - primaryUsed,
        resetAt: epochSecondsToIso(primary.reset_at),
        windowSeconds: Number(primary.limit_window_seconds || 0),
      },
      weekly: {
        usedPercent: secondaryUsed,
        remainingPercent: 100 - secondaryUsed,
        resetAt: epochSecondsToIso(secondary.reset_at),
        windowSeconds: Number(secondary.limit_window_seconds || 0),
      },
    },
  };
}

function earliestIso(values) {
  const times = values
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (times.length === 0) {
    return null;
  }
  return new Date(Math.min(...times)).toISOString();
}

function latestIso(values) {
  const times = values
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (times.length === 0) {
    return null;
  }
  return new Date(Math.max(...times)).toISOString();
}

function summarizeWindow(accounts, windowKey) {
  const windows = accounts.map((account) => account.windows[windowKey]).filter(Boolean);
  const count = windows.length;
  const usedTotal = windows.reduce((sum, window) => sum + window.usedPercent, 0);
  const remainingTotal = windows.reduce((sum, window) => sum + window.remainingPercent, 0);
  const exhausted = accounts.filter((account) => account.windows[windowKey]?.remainingPercent <= 0.01);

  return {
    accountCount: count,
    usedPercent: count ? usedTotal / count : 0,
    remainingPercent: count ? remainingTotal / count : 0,
    capacityUnits: count * 100,
    remainingUnits: remainingTotal,
    exhaustedCount: exhausted.length,
    nextRefillAt: earliestIso(exhausted.map((account) => account.windows[windowKey]?.resetAt)),
    allCurrentUsageClearsAt: latestIso(
      accounts
        .filter((account) => account.windows[windowKey]?.usedPercent > 0.01)
        .map((account) => account.windows[windowKey]?.resetAt),
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
    nextAccountReadyAt: earliestIso(
      blockedAccounts.map((account) => (
        account.statusResetAt
        || account.nextRetryAfter
        || account.windows.weekly.resetAt
        || account.windows.fiveHour.resetAt
      )),
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
  const results = await Promise.allSettled(files.map(async (file) => {
    const usage = await callCodexUsage(file);
    return normalizeAccount(file, usage);
  }));

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

  return {
    ...summarizeAccounts(accounts),
    errorCount: errors.length,
    errors,
  };
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
  if (!expected) {
    return true;
  }
  return requestUrl.searchParams.get("token") === expected;
}

export function createServer() {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    try {
      if (requestUrl.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (requestUrl.pathname !== "/quota") {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      if (!requestAuthorized(requestUrl)) {
        sendJson(response, 401, { error: "invalid widget token" });
        return;
      }
      sendJson(response, 200, await buildQuotaSnapshot());
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.CODEX_QUOTA_WIDGET_PORT || DEFAULT_PORT);
  const host = process.env.CODEX_QUOTA_WIDGET_HOST || "0.0.0.0";
  createServer().listen(port, host, () => {
    console.log(`codex-quota-widget listening on http://${host}:${port}/quota`);
  });
}
