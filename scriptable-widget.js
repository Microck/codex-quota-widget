// Paste this into Scriptable and replace QUOTA_URL.
const QUOTA_URL = "http://YOUR_TAILSCALE_IP:8765/quota?token=YOUR_WIDGET_TOKEN";

const COLORS = {
  bg: new Color("#000000"),
  track: new Color("#253044"),
  text: new Color("#f8fafc"),
  muted: new Color("#94a3b8"),
  green: new Color("#22c55e"),
  yellow: new Color("#f59e0b"),
  red: new Color("#ef4444"),
};

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function percent(value) {
  return `${Math.round(number(value))}%`;
}

function colorFor(value) {
  const remaining = number(value);
  if (remaining <= 10) return COLORS.red;
  if (remaining <= 30) return COLORS.yellow;
  return COLORS.green;
}

function themeFor(value) {
  const remaining = number(value);
  if (remaining <= 10) {
    return {
      top: COLORS.bg,
      bottom: COLORS.bg,
      accent: COLORS.red,
    };
  }
  if (remaining <= 30) {
    return {
      top: COLORS.bg,
      bottom: COLORS.bg,
      accent: COLORS.yellow,
    };
  }
  return {
    top: COLORS.bg,
    bottom: COLORS.bg,
    accent: COLORS.green,
  };
}

function overallRemaining(data) {
  return Math.min(
    number(data.windows.fiveHour.remainingPercent),
    number(data.windows.weekly.remainingPercent),
  );
}

function applyTheme(widget, value) {
  const theme = themeFor(value);
  const gradient = new LinearGradient();
  gradient.colors = [theme.top, theme.bottom];
  gradient.locations = [0, 1];
  widget.backgroundGradient = gradient;
  return theme;
}

function timeUntil(iso) {
  if (!iso) return "ready";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 48) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

function addText(stack, text, options = {}) {
  const line = stack.addText(String(text));
  line.textColor = options.color || COLORS.text;
  line.font = options.font || Font.systemFont(options.size || 12);
  line.lineLimit = options.lineLimit || 1;
  line.minimumScaleFactor = options.minimumScaleFactor || 0.8;
  return line;
}

function addHeader(widget, data, theme, totalRemaining) {
  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  addText(row, "Codex", { size: 16, font: Font.boldSystemFont(16) });
  row.addSpacer();
  addText(row, `total ${percent(totalRemaining)}`, {
    size: 14,
    font: Font.boldSystemFont(14),
    color: theme.accent,
  });
}

function addMeter(widget, label, summary, width) {
  const remaining = clamp(number(summary.remainingPercent), 0, 100);
  const fillWidth = clamp(Math.round((remaining / 100) * width), 3, width);
  const color = colorFor(remaining);

  const top = widget.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  addText(top, label, { size: 12, color: COLORS.muted, font: Font.boldSystemFont(12) });
  top.addSpacer();
  addText(top, percent(remaining), { size: 18, color, font: Font.boldSystemFont(18) });

  widget.addSpacer(4);

  const track = widget.addStack();
  track.layoutHorizontally();
  track.size = new Size(width, 10);
  track.backgroundColor = COLORS.track;
  track.cornerRadius = 5;

  const fill = track.addStack();
  fill.size = new Size(fillWidth, 10);
  fill.backgroundColor = color;
  fill.cornerRadius = 5;
  track.addSpacer();

  widget.addSpacer(4);

  const bottom = widget.addStack();
  bottom.layoutHorizontally();
  addText(bottom, `${Math.round(number(summary.remainingUnits))}/${summary.capacityUnits} units`, {
    size: 10,
    color: COLORS.muted,
  });
  bottom.addSpacer();
  addText(bottom, `refill ${timeUntil(summary.nextRefillAt || summary.allCurrentUsageClearsAt)}`, {
    size: 10,
    color: COLORS.muted,
  });
}

async function loadQuota() {
  const request = new Request(QUOTA_URL);
  request.timeoutInterval = 20;
  return await request.loadJSON();
}

function renderError(widget, error) {
  widget.backgroundColor = COLORS.bg;
  widget.setPadding(14, 14, 14, 14);
  addText(widget, "Codex", { size: 16, font: Font.boldSystemFont(16) });
  widget.addSpacer(8);
  addText(widget, "Bridge error", { size: 18, font: Font.boldSystemFont(18), color: COLORS.red });
  widget.addSpacer(4);
  addText(widget, String(error.message || error).slice(0, 120), {
    size: 11,
    color: COLORS.muted,
    lineLimit: 3,
  });
}

async function createWidget() {
  const widget = new ListWidget();
  widget.backgroundColor = COLORS.bg;
  widget.setPadding(14, 14, 14, 14);

  let data;
  try {
    data = await loadQuota();
  } catch (error) {
    renderError(widget, error);
    return widget;
  }

  const totalRemaining = overallRemaining(data);
  const theme = applyTheme(widget, totalRemaining);
  const barWidth = config.widgetFamily === "small" ? 130 : 230;
  addHeader(widget, data, theme, totalRemaining);
  widget.addSpacer(12);
  addMeter(widget, "5h window", data.windows.fiveHour, barWidth);

  if (config.widgetFamily !== "small") {
    widget.addSpacer(10);
    addMeter(widget, "weekly window", data.windows.weekly, barWidth);
    widget.addSpacer(10);
    const footer = widget.addStack();
    footer.layoutHorizontally();
    addText(footer, `${data.readyAccountCount}/${data.accountCount} ready`, { size: 10, color: COLORS.muted });
    footer.addSpacer();
    addText(footer, `updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, {
      size: 10,
      color: COLORS.muted,
    });
  }

  return widget;
}

const widget = await createWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
