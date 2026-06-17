#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_CLIPROXY_BASE_URL = "http://127.0.0.1:8317";
const DEFAULT_CODEX_AUTH_FILE = path.join(homedir(), ".codex", "auth.json");
const DEFAULT_PORT = 8765;
const CODEX_USAGE_URL = process.env.CODEX_USAGE_URL?.trim() || "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USER_AGENT = "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464";
const OPENAI_OAUTH_TOKEN_URL = process.env.CODEX_OAUTH_TOKEN_URL?.trim() || "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_REFRESH_SKEW_SECONDS = 300;
const SPARK_METERED_FEATURE = "codex_bengalfox";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cliproxyHeaders() {
  return { Authorization: `Bearer ${requiredEnv("CLIPROXY_MANAGEMENT_KEY")}` };
}

function optionalEnv(name) {
  return process.env[name]?.trim() || "";
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

function decodeJwtPayload(token) {
  const payload = String(token || "").split(".")[1];
  if (!payload) return {};

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function jwtExpiresSoon(token) {
  const expiresAt = Number(decodeJwtPayload(token).exp);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - TOKEN_REFRESH_SKEW_SECONDS <= Math.floor(Date.now() / 1000);
}

function authFilePath() {
  return optionalEnv("CODEX_AUTH_FILE") || DEFAULT_CODEX_AUTH_FILE;
}

function hasCliproxyManagement() {
  return Boolean(optionalEnv("CLIPROXY_MANAGEMENT_KEY"));
}

async function listCliproxyCodexAuthFiles() {
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
      source: "cliproxyapi",
    }))
    .filter((file) => file.authIndex && file.accountId);
}

async function refreshCodexTokens(auth, filePath) {
  const refreshToken = String(auth?.tokens?.refresh_token || "");
  if (!refreshToken) {
    throw new Error("Codex auth file has no refresh token. Run Codex login again.");
  }

  const body = new URLSearchParams({
    client_id: CODEX_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "openid profile email",
  });

  const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const tokenResponse = await readJson(response);

  if (!response.ok) {
    throw new Error(`Codex token refresh failed with HTTP ${response.status}: ${JSON.stringify(tokenResponse)}`);
  }

  const nextIdToken = String(tokenResponse?.id_token || "");
  const nextAccessToken = String(tokenResponse?.access_token || "");
  const nextRefreshToken = String(tokenResponse?.refresh_token || refreshToken);
  const idToken = decodeJwtPayload(nextIdToken);
  const nextAccountId = String(auth?.tokens?.account_id || idToken.chatgpt_account_id || "");

  if (!nextIdToken || !nextAccessToken || !nextRefreshToken || !nextAccountId) {
    throw new Error("Codex token refresh returned an incomplete token set. Run Codex login again.");
  }

  const nextAuth = {
    ...auth,
    email: auth.email || idToken.email,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...auth.tokens,
      id_token: nextIdToken,
      access_token: nextAccessToken,
      refresh_token: nextRefreshToken,
      account_id: nextAccountId,
    },
  };
  const tempPath = `${filePath}.${process.pid}.tmp`;

  await writeFile(tempPath, `${JSON.stringify(nextAuth, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
  return nextAuth;
}

async function listLocalCodexAuthFile() {
  const filePath = authFilePath();
  let auth;

  try {
    auth = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("Failed to read Codex auth file. Run Codex login or set CODEX_AUTH_FILE to a valid auth.json.");
  }

  const tokens = auth?.tokens || {};
  const idToken = decodeJwtPayload(tokens.id_token);
  const accessToken = String(tokens.access_token || "");
  const accountId = String(tokens.account_id || idToken.chatgpt_account_id || "");

  if (!accessToken || !accountId) {
    throw new Error(
      "Codex auth file does not contain ChatGPT access tokens. Run codex login and choose Sign in with ChatGPT, or set CODEX_AUTH_FILE to a valid auth.json.",
    );
  }

  if (jwtExpiresSoon(tokens.id_token)) {
    try {
      auth = await refreshCodexTokens(auth, filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not refresh Codex auth from ${filePath}. Run codex login and choose Sign in with ChatGPT, then restart the bridge. ${message}`,
      );
    }
  }

  const refreshedTokens = auth?.tokens || {};
  const refreshedIdToken = decodeJwtPayload(refreshedTokens.id_token);

  return [
    {
      email: String(auth.email || refreshedIdToken.email || "local-codex-account"),
      planType: String(refreshedIdToken.plan_type || "unknown"),
      accountId: String(refreshedTokens.account_id || accountId),
      accessToken: String(refreshedTokens.access_token || accessToken),
      status: "local-auth-file",
      statusMessage: "",
      nextRetryAfter: null,
      source: "codex-auth-file",
    },
  ];
}

async function listCodexAuthFiles() {
  return hasCliproxyManagement() ? listCliproxyCodexAuthFiles() : listLocalCodexAuthFile();
}

async function callCodexUsageViaCliproxy(file) {
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

async function callCodexUsageDirect(file) {
  return fetchJson(CODEX_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${file.accessToken}`,
      "Chatgpt-Account-Id": file.accountId,
      "User-Agent": CODEX_USER_AGENT,
      Originator: "codex_cli_rs",
      Accept: "application/json",
    },
  });
}

async function callCodexUsage(file) {
  return file.source === "cliproxyapi" ? callCodexUsageViaCliproxy(file) : callCodexUsageDirect(file);
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

function normalizeWindow(rateLimit, windowKey) {
  const window = rateLimit?.[windowKey] || {};
  const usedPercent = clampPercent(window.used_percent);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt: epochSecondsToIso(window.reset_at),
    windowSeconds: Number(window.limit_window_seconds || 0),
  };
}

function isSparkLimit(limit) {
  const meteredFeature = String(limit?.metered_feature || "").toLowerCase();
  const limitName = String(limit?.limit_name || "").toLowerCase();
  return meteredFeature === SPARK_METERED_FEATURE || limitName.includes("spark");
}

function normalizeSparkLimit(usage) {
  const sparkLimit = (Array.isArray(usage?.additional_rate_limits) ? usage.additional_rate_limits : [])
    .find(isSparkLimit);
  const rateLimit = sparkLimit?.rate_limit;
  if (!rateLimit?.primary_window && !rateLimit?.secondary_window) return null;

  return {
    name: String(sparkLimit.limit_name || "GPT-5.3-Codex-Spark"),
    meteredFeature: String(sparkLimit.metered_feature || SPARK_METERED_FEATURE),
    allowed: rateLimit.allowed === true && rateLimit.limit_reached !== true,
    limitReached: rateLimit.limit_reached === true,
    windows: {
      fiveHour: normalizeWindow(rateLimit, "primary_window"),
      weekly: normalizeWindow(rateLimit, "secondary_window"),
    },
  };
}

function normalizeAccount(file, usage) {
  const rateLimit = usage?.rate_limit || {};

  return {
    email: String(usage?.email || file.email),
    planType: String(usage?.plan_type || file.planType),
    allowed: rateLimit.allowed === true && rateLimit.limit_reached !== true,
    limitReached: rateLimit.limit_reached === true,
    reachedType: usage?.rate_limit_reached_type?.type || null,
    nextRetryAfter: file.nextRetryAfter,
    statusResetAt: parseStatusReset(file.statusMessage),
    windows: {
      fiveHour: normalizeWindow(rateLimit, "primary_window"),
      weekly: normalizeWindow(rateLimit, "secondary_window"),
    },
    spark: normalizeSparkLimit(usage),
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

function summarizeAccounts(accounts, source) {
  const blockedAccounts = accounts.filter((account) => !account.allowed);
  const sparkAccounts = accounts
    .filter((account) => account.spark)
    .map((account) => ({
      ...account,
      allowed: account.spark.allowed,
      limitReached: account.spark.limitReached,
      windows: account.spark.windows,
    }));
  const spark = sparkAccounts.length > 0
    ? {
        accountCount: sparkAccounts.length,
        readyAccountCount: sparkAccounts.filter((account) => account.allowed).length,
        blockedAccountCount: sparkAccounts.filter((account) => !account.allowed).length,
        windows: {
          fiveHour: summarizeWindow(sparkAccounts, "fiveHour"),
          weekly: summarizeWindow(sparkAccounts, "weekly"),
        },
      }
    : null;

  return {
    generatedAt: new Date().toISOString(),
    source,
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
    spark,
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

  const source = hasCliproxyManagement()
    ? "cliproxyapi:/v0/management/api-call -> chatgpt.com/backend-api/wham/usage"
    : "codex-auth-file -> chatgpt.com/backend-api/wham/usage";

  return { ...summarizeAccounts(accounts, source), errorCount: errors.length, errors };
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
