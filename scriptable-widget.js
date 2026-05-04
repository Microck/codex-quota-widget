// Paste this into Scriptable and replace QUOTA_URL.
const QUOTA_URL = "http://YOUR_TAILSCALE_IP:8765/quota?token=YOUR_WIDGET_TOKEN";

const COLORS = {
  background: new Color("#111827"),
  muted: new Color("#9ca3af"),
  text: new Color("#f9fafb"),
  ok: new Color("#22c55e"),
  warn: new Color("#f59e0b"),
  bad: new Color("#ef4444"),
};

function pct(value) {
  const number = Number(value);
  return `${Number.isFinite(number) ? Math.round(number) : 0}%`;
}

function bar(remainingPercent, width = 14) {
  const remaining = Math.max(0, Math.min(100, Number(remainingPercent) || 0));
  const filled = Math.round((remaining / 100) * width);
  return `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
}

function timeUntil(iso) {
  if (!iso) return "ready";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

function colorFor(remainingPercent) {
  if (remainingPercent <= 10) return COLORS.bad;
  if (remainingPercent <= 30) return COLORS.warn;
  return COLORS.ok;
}

function addText(stack, text, options = {}) {
  const line = stack.addText(text);
  line.textColor = options.color || COLORS.text;
  line.font = options.font || Font.systemFont(options.size || 12);
  line.lineLimit = options.lineLimit || 1;
  return line;
}

function addWindow(widget, title, windowSummary) {
  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  const label = row.addStack();
  label.layoutVertically();
  label.size = new Size(62, 34);
  addText(label, title, { size: 10, color: COLORS.muted });
  addText(label, pct(windowSummary.remainingPercent), {
    size: 18,
    font: Font.boldSystemFont(18),
    color: colorFor(windowSummary.remainingPercent),
  });

  row.addSpacer(8);

  const detail = row.addStack();
  detail.layoutVertically();
  addText(detail, bar(windowSummary.remainingPercent), {
    size: 11,
    font: Font.monospacedSystemFont(11),
    color: colorFor(windowSummary.remainingPercent),
  });
  addText(detail, `refill ${timeUntil(windowSummary.nextRefillAt || windowSummary.allCurrentUsageClearsAt)}`, {
    size: 10,
    color: COLORS.muted,
  });
}

async function createWidget() {
  const widget = new ListWidget();
  widget.backgroundColor = COLORS.background;
  widget.setPadding(14, 14, 14, 14);

  try {
    const request = new Request(QUOTA_URL);
    request.timeoutInterval = 20;
    const data = await request.loadJSON();

    const title = widget.addStack();
    title.layoutHorizontally();
    addText(title, "Codex quotas", { size: 13, font: Font.boldSystemFont(13) });
    title.addSpacer();
    addText(title, `${data.readyAccountCount}/${data.accountCount}`, {
      size: 12,
      color: data.readyAccountCount > 0 ? COLORS.ok : COLORS.bad,
      font: Font.boldSystemFont(12),
    });

    widget.addSpacer(10);
    addWindow(widget, "5h", data.windows.fiveHour);
    widget.addSpacer(8);
    addWindow(widget, "weekly", data.windows.weekly);

    if (config.widgetFamily !== "small") {
      widget.addSpacer(10);
      addText(widget, data.nextAccountReadyAt ? `next ready ${timeUntil(data.nextAccountReadyAt)}` : "accounts ready", {
        size: 11,
        color: COLORS.muted,
      });
    }
  } catch (error) {
    addText(widget, "Codex quotas", { size: 13, font: Font.boldSystemFont(13) });
    widget.addSpacer(8);
    addText(widget, "Bridge error", { size: 18, font: Font.boldSystemFont(18), color: COLORS.bad });
    addText(widget, String(error.message || error).slice(0, 80), { size: 10, color: COLORS.muted, lineLimit: 3 });
  }

  return widget;
}

const widget = await createWidget();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
