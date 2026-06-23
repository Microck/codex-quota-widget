#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_CLIPROXY_BASE_URL = "http://127.0.0.1:8317";
const DEFAULT_CODEX_AUTH_FILE = path.join(homedir(), ".codex", "auth.json");
const DEFAULT_PORT = 8765;
const CODEX_USAGE_URL = process.env.CODEX_USAGE_URL?.trim() || "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL = process.env.CODEX_RESET_CREDITS_URL?.trim()
  || "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
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

async function callCodexResetCreditsViaCliproxy(file) {
  const data = await fetchJson(cliproxyUrl("/v0/management/api-call"), {
    method: "POST",
    headers: {
      ...cliproxyHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_index: file.authIndex,
      method: "GET",
      url: CODEX_RESET_CREDITS_URL,
      header: {
        Authorization: "Bearer $TOKEN$",
        "Chatgpt-Account-Id": file.accountId,
        "User-Agent": CODEX_USER_AGENT,
        Originator: "codex_cli_rs",
        "OAI-Product-Sku": "CODEX",
        Accept: "application/json",
      },
    }),
  });

  const body = typeof data?.body === "string" ? JSON.parse(data.body) : data?.body;
  if (data?.status_code < 200 || data?.status_code >= 300) {
    throw new Error(`Codex reset credits call returned ${data?.status_code}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function callCodexResetCreditsDirect(file) {
  return fetchJson(CODEX_RESET_CREDITS_URL, {
    headers: {
      Authorization: `Bearer ${file.accessToken}`,
      "Chatgpt-Account-Id": file.accountId,
      "User-Agent": CODEX_USER_AGENT,
      Originator: "codex_cli_rs",
      "OAI-Product-Sku": "CODEX",
      Accept: "application/json",
    },
  });
}

async function callCodexResetCredits(file) {
  return file.source === "cliproxyapi" ? callCodexResetCreditsViaCliproxy(file) : callCodexResetCreditsDirect(file);
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function epochToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const epochMilliseconds = number > 10_000_000_000 ? number : number * 1000;
  return new Date(epochMilliseconds).toISOString();
}

function secondsUntil(iso) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

function duration(seconds) {
  const number = Number(seconds);
  if (!Number.isFinite(number)) return "-";
  const clamped = Math.max(0, Math.floor(number));
  const days = Math.floor(clamped / 86_400);
  const hours = Math.floor((clamped % 86_400) / 3_600);
  const minutes = Math.floor((clamped % 3_600) / 60);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

function finiteNumberOrNaN(value) {
  if (value === undefined || value === null || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function isoDateString(value) {
  if (value === undefined || value === null || value === "") return null;
  if (Number.isFinite(Number(value))) return epochToIso(value);
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseStatusReset(statusMessage) {
  if (!statusMessage) return null;
  try {
    return epochToIso(JSON.parse(statusMessage)?.error?.resets_at);
  } catch {
    return null;
  }
}

function normalizeWindow(rateLimit, windowKey) {
  const window = rateLimit?.[windowKey] || {};
  const usedPercent = clampPercent(window.used_percent);
  const resetAt = epochToIso(window.reset_at);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt,
    resetAfterSeconds: Number.isFinite(Number(window.reset_after_seconds))
      ? Math.max(0, Number(window.reset_after_seconds))
      : secondsUntil(resetAt),
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

export function makeResetExpiryUrgency({ expiresAt, isAvailable, now = Date.now() }) {
  if (!isAvailable) {
    return { level: "inactive", badge: "Used", hint: null };
  }

  if (!expiresAt) {
    return { level: "unknown", badge: "Available", hint: "Expiry unknown" };
  }

  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) {
    return { level: "unknown", badge: "Available", hint: "Expiry unknown" };
  }

  const seconds = (timestamp - now) / 1000;
  if (seconds <= 0) {
    return { level: "expired", badge: "Expired", hint: "This reset is past its expiry time" };
  }
  if (seconds <= 86_400) {
    return { level: "urgent", badge: "Ends today", hint: "Use it soon or let it go" };
  }
  if (seconds <= 3 * 86_400) {
    return { level: "soon", badge: "Expires soon", hint: "Worth keeping top of mind" };
  }
  if (seconds <= 7 * 86_400) {
    return { level: "approaching", badge: "This week", hint: "Expiry is getting closer" };
  }

  return { level: "normal", badge: "Available", hint: null };
}

function normalizeResetCredit(credit, index) {
  const id = optionalString(credit?.id);
  if (!id) return null;

  const status = optionalString(credit?.status) || "unknown";
  const expiresAt = isoDateString(credit?.expires_at ?? credit?.expiresAt);
  const isAvailable = status.toLowerCase() === "available";

  return {
    id,
    resetType: optionalString(credit?.reset_type ?? credit?.resetType) || "unknown",
    status,
    isAvailable,
    grantedAt: isoDateString(credit?.granted_at ?? credit?.grantedAt),
    expiresAt,
    redeemStartedAt: isoDateString(credit?.redeem_started_at ?? credit?.redeemStartedAt),
    redeemedAt: isoDateString(credit?.redeemed_at ?? credit?.redeemedAt),
    title: optionalString(credit?.title),
    description: optionalString(credit?.description),
    urgency: makeResetExpiryUrgency({ expiresAt, isAvailable }),
    sortIndex: index,
  };
}

function normalizeResetCredits(response) {
  const credits = (Array.isArray(response?.credits) ? response.credits : [])
    .map(normalizeResetCredit)
    .filter(Boolean)
    .sort((left, right) => {
      const leftTime = Date.parse(left.expiresAt || "");
      const rightTime = Date.parse(right.expiresAt || "");
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
      if (Number.isFinite(leftTime)) return -1;
      if (Number.isFinite(rightTime)) return 1;
      return left.sortIndex - right.sortIndex;
    })
    .map(({ sortIndex, ...credit }) => credit);
  const availableCredits = credits.filter((credit) => credit.isAvailable);
  const serverAvailableCount = Number(response?.available_count ?? response?.availableCount);
  const availableCount = Number.isFinite(serverAvailableCount) ? serverAvailableCount : availableCredits.length;

  return {
    availableCount,
    creditCount: credits.length,
    urgentCount: availableCredits.filter((credit) => credit.urgency.level === "urgent").length,
    expiringSoonCount: availableCredits
      .filter((credit) => ["urgent", "soon", "approaching"].includes(credit.urgency.level))
      .length,
    nextExpiryAt: isoBy(availableCredits.map((credit) => credit.expiresAt), Math.min),
    credits,
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

export function makeUsageNudge({ fiveHour, weekly, resetCount, resetUrgencies = [] }) {
  const resetCountNumber = finiteNumberOrNaN(resetCount);

  if (resetCountNumber > 0 && resetUrgencies.some((urgency) => urgency.level === "urgent")) {
    return {
      tier: "expiringReset",
      title: "Use it or lose it",
      message: "A banked reset expires today. If there is useful work queued, spend that reset before it disappears.",
      detail: "Reset ends today",
    };
  }

  const weeklyRemaining = Number(weekly?.remainingPercent);
  if (!Number.isFinite(weeklyRemaining)) {
    return {
      tier: "unavailable",
      title: "Waiting on the meters",
      message: "Reset stash loaded. Codex usage windows are still warming up.",
      detail: "Try again soon",
    };
  }

  if (!Number.isFinite(resetCountNumber)) {
    return {
      tier: "unavailable",
      title: "Reset credits unavailable",
      message: "Quota meters loaded, but Codex did not return reset-credit data. Check the bridge error before spending a reset.",
      detail: "Reset status unknown",
    };
  }

  const fiveHourRemaining = Number(fiveHour?.remainingPercent);
  const fiveHourReset = finiteNumberOrNaN(fiveHour?.resetAfterSeconds);
  const weeklyResetSeconds = finiteNumberOrNaN(weekly?.resetAfterSeconds);

  if (resetCountNumber === 0) {
    return {
      tier: "noResets",
      title: "No reset parachute",
      message: "Watch the meters. There is no banked reset for a big sprint.",
      detail: `${Math.round(weeklyRemaining)}% weekly left`,
    };
  }

  if (
    Number.isFinite(fiveHourRemaining)
    && Number.isFinite(fiveHourReset)
    && fiveHourRemaining <= 12
    && weeklyRemaining >= 25
    && fiveHourReset <= 90 * 60
  ) {
    return {
      tier: "waitFiveHour",
      title: "Let the 5h tank refill",
      message: "Weekly room is still decent. Let the short window catch up before spending a reset.",
      detail: `5h resets in ${duration(fiveHourReset)}`,
    };
  }

  if (
    Number.isFinite(fiveHourRemaining)
    && Number.isFinite(fiveHourReset)
    && fiveHourRemaining <= 12
    && weeklyRemaining >= 50
    && fiveHourReset > 90 * 60
    && fiveHourReset <= 3 * 3_600
  ) {
    return {
      tier: "deadline",
      title: "Deadline call",
      message: "Weekly runway looks great. If this is deadline work, spend a reset. Otherwise let the 5h clock do its thing.",
      detail: `5h resets in ${duration(fiveHourReset)}`,
    };
  }

  if (
    Number.isFinite(fiveHourRemaining)
    && Number.isFinite(fiveHourReset)
    && fiveHourRemaining <= 12
    && weeklyRemaining >= 50
    && fiveHourReset > 3 * 3_600
  ) {
    return {
      tier: "deadline",
      title: "Deadline override",
      message: "The short window is hours away. Big deadline? Use a reset. Otherwise coast until the 5h refill.",
      detail: `5h resets in ${duration(fiveHourReset)}`,
    };
  }

  if (!Number.isFinite(weeklyResetSeconds)) {
    return {
      tier: "steady",
      title: "Reset timing unclear",
      message: "Usage meters loaded, but Codex did not return a weekly reset timer. Spend a reset only if work is blocked.",
      detail: `${Math.round(weeklyRemaining)}% weekly left`,
    };
  }

  const weeklyDays = weeklyResetSeconds / 86_400;

  if (resetCountNumber >= 2 && weeklyRemaining <= 15 && weeklyDays >= 4) {
    return {
      tier: "spend",
      title: "Go burn some tokens",
      message: `You have ${resetCountNumber} resets banked, weekly room is thin, and refresh is days away. Push the run, then spend a reset if Codex blocks real work.`,
      detail: `${Math.round(weeklyRemaining)}% weekly left`,
    };
  }

  if (resetCountNumber >= 1 && weeklyRemaining <= 20 && weeklyDays >= 2) {
    return {
      tier: "useIfBlocked",
      title: "Green light, with brakes",
      message: "If real work hits the wall, spending a reset makes sense. Do not use it just to tidy up the meter.",
      detail: `${duration(weeklyResetSeconds)} to weekly reset`,
    };
  }

  if (weeklyRemaining >= 35 && weeklyDays <= 3) {
    return {
      tier: "hold",
      title: "Hold that reset",
      message: "Plenty of weekly runway and the next refresh is close. Let the reset stay banked.",
      detail: `${Math.round(weeklyRemaining)}% weekly left`,
    };
  }

  if (weeklyRemaining >= 25 && weeklyDays <= 2) {
    return {
      tier: "hold",
      title: "Pocket the reset",
      message: "Capacity is not tight enough this close to weekly refresh. Keep the reset in your back pocket.",
      detail: `${duration(weeklyResetSeconds)} away`,
    };
  }

  return {
    tier: "steady",
    title: "Cruise mode",
    message: "Keep working. Re-check before a big run.",
    detail: `${Math.round(weeklyRemaining)}% weekly left`,
  };
}

function summarizeResetCredits(accounts) {
  const resetCreditSets = accounts.map((account) => account.resetCredits).filter(Boolean);
  const credits = resetCreditSets.flatMap((resetCredits) => resetCredits.credits);
  const availableCredits = credits.filter((credit) => credit.isAvailable);
  const errors = accounts
    .filter((account) => account.resetCreditsError)
    .map((account) => ({ email: account.email, message: account.resetCreditsError }));
  const availableCount = resetCreditSets.length > 0
    ? resetCreditSets.reduce((sum, resetCredits) => sum + resetCredits.availableCount, 0)
    : null;

  return {
    availableCount,
    creditCount: resetCreditSets.reduce((sum, resetCredits) => sum + resetCredits.creditCount, 0),
    urgentCount: availableCredits.filter((credit) => credit.urgency.level === "urgent").length,
    expiringSoonCount: availableCredits
      .filter((credit) => ["urgent", "soon", "approaching"].includes(credit.urgency.level))
      .length,
    nextExpiryAt: isoBy(availableCredits.map((credit) => credit.expiresAt), Math.min),
    errors,
    credits,
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
  const windows = {
    fiveHour: summarizeWindow(accounts, "fiveHour"),
    weekly: summarizeWindow(accounts, "weekly"),
  };
  const resetCredits = summarizeResetCredits(accounts);
  const nudge = makeUsageNudge({
    fiveHour: {
      ...windows.fiveHour,
      resetAfterSeconds: secondsUntil(windows.fiveHour.allCurrentUsageClearsAt || windows.fiveHour.nextRefillAt),
    },
    weekly: {
      ...windows.weekly,
      resetAfterSeconds: secondsUntil(windows.weekly.allCurrentUsageClearsAt || windows.weekly.nextRefillAt),
    },
    resetCount: resetCredits.availableCount,
    resetUrgencies: resetCredits.credits.map((credit) => credit.urgency),
  });

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
    windows,
    spark,
    resetCredits,
    nudge,
    accounts,
  };
}

async function buildAccountSnapshot(file) {
  const account = normalizeAccount(file, await callCodexUsage(file));

  try {
    account.resetCredits = normalizeResetCredits(await callCodexResetCredits(file));
  } catch (error) {
    account.resetCredits = null;
    account.resetCreditsError = error instanceof Error ? error.message : String(error);
  }

  return account;
}

export async function buildQuotaSnapshot() {
  const files = await listCodexAuthFiles();
  const results = await Promise.allSettled(files.map(buildAccountSnapshot));
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
    ? "cliproxyapi:/v0/management/api-call -> chatgpt.com/backend-api/wham/{usage,rate-limit-reset-credits}"
    : "codex-auth-file -> chatgpt.com/backend-api/wham/{usage,rate-limit-reset-credits}";

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
