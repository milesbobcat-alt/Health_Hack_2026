import { randomBytes } from "node:crypto";

const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = 30 * DAY;
function repeatIntervalDays(frequency = "") {
  const interval = frequency.match(/\bevery\s+(\d+)\s+(day|week)s?\b/i);
  if (interval) return Number(interval[1]) * (interval[2].toLowerCase() === "week" ? 7 : 1);
  if (/\b(?:weekly|every week)\b/i.test(frequency)) return 7;
  if (/\b(?:daily|every day|each day|each morning|every morning|each evening|every evening|each night|every night|nightly|times daily)\b/i.test(frequency)) return 1;
  return 0;
}

export function createChecklistStore({ now = Date.now, send = async () => {}, reminderIntervalMs = DAY } = {}) {
  const plans = new Map();

  function purge() {
    for (const [id, plan] of plans) if (plan.expiresAt <= now()) plans.delete(id);
  }

  function publicPlan(plan) {
    refreshRecurringItems(plan);
    return {
      id: plan.id,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      items: plan.items.map(({ text, category, name, description, strength, dose, frequency, timing, due, done }) => ({
        text, category: ["routine", "followup", "other"].includes(category) ? "care" : category,
        name, description, strength, dose, frequency, timing, due, done,
      })),
      warnings: [...plan.warnings],
      medicationChanges: { before: [...plan.medicationChanges.before], after: [...plan.medicationChanges.after] },
    };
  }

  function refreshRecurringItems(plan) {
    const currentTime = now();
    for (const item of plan.items) {
      const intervalDays = repeatIntervalDays(item.frequency);
      if (intervalDays && item.completedOn && currentTime - Date.parse(item.completedOn) >= intervalDays * DAY) item.done = false;
    }
  }

  function create(payload) {
    const { items, warnings = [], medicationChanges = { before: [], after: [] }, phone, email, consent, reminders = true } = payload;
    let { shareMode } = payload;
    shareMode ||= phone && email ? "both" : phone ? "sms" : email ? "email" : "link";
    purge();
    if (!["link", "sms", "email", "both"].includes(shareMode)) throw new Error("Choose a valid sharing method.");
    if (!Array.isArray(items) || !items.length || items.length > 30 ||
        items.some((item) => {
          const text = typeof item === "string" ? item : item?.text;
          const optionalFields = ["name", "description", "strength", "dose", "frequency", "timing", "due"];
          return typeof text !== "string" || !text.trim() || text.length > 500 ||
            (typeof item !== "string" && (!item || !["medication", "care", "testing", "avoid", "routine", "followup", "other"].includes(item.category) ||
              optionalFields.some((field) => item[field] !== undefined && (typeof item[field] !== "string" || item[field].length > 200))));
        })) {
      throw new Error("Enter 1 to 30 reviewed checklist items, each under 500 characters.");
    }
    if (!Array.isArray(warnings) || warnings.length > 20 || warnings.some((warning) => typeof warning !== "string" || !warning.trim() || warning.length > 500)) throw new Error("Review warning signs before sharing.");
    if (!medicationChanges || !["before", "after"].every((side) => Array.isArray(medicationChanges[side]) && medicationChanges[side].length <= 50 && medicationChanges[side].every((entry) => typeof entry === "string" && entry.trim() && entry.length <= 500))) throw new Error("Review the medication comparison.");
    const needsPhone = shareMode === "sms" || shareMode === "both";
    const needsEmail = shareMode === "email" || shareMode === "both";
    if (shareMode !== "link" && consent !== true) throw new Error("Patient consent is required for reminders.");
    if (needsPhone && !/^\+[1-9]\d{7,14}$/.test(phone || "")) throw new Error("Use an international phone number such as +15551234567.");
    if (needsEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "")) throw new Error("Enter a valid email address.");
    const createdAt = now();
    const plan = {
      id: randomBytes(24).toString("base64url"), createdAt,
      expiresAt: createdAt + MAX_AGE,
      items: items.map((item) => typeof item === "string"
        ? ({ text: item.trim(), category: "other", frequency: "once", done: false, completedOn: null })
        : ({
          text: item.text.trim(), category: ["routine", "followup", "other"].includes(item.category) ? "care" : item.category,
          name: item.name?.trim() || "", description: item.description?.trim() || "", strength: item.strength?.trim() || "",
          dose: item.dose?.trim() || "", frequency: item.frequency?.trim() || "", timing: item.timing?.trim() || "", due: item.due?.trim() || "",
          done: false, completedOn: null,
        })),
      warnings: warnings.map((warning) => warning.trim()),
      medicationChanges: { before: medicationChanges.before.map((entry) => entry.trim()), after: medicationChanges.after.map((entry) => entry.trim()) },
      phone: needsPhone ? phone : null, email: needsEmail ? email : null,
      nextReminderAt: shareMode === "link" ? Infinity : createdAt,
      reminders: reminders === true,
      delivery: [],
    };
    plans.set(plan.id, plan);
    return publicPlan(plan);
  }

  function get(id) {
    purge();
    const plan = plans.get(id);
    return plan ? publicPlan(plan) : null;
  }

  function update(id, index, done) {
    purge();
    const plan = plans.get(id);
    if (!plan) return null;
    refreshRecurringItems(plan);
    if (!Number.isInteger(index) || index < 0 || index >= plan.items.length || typeof done !== "boolean") {
      throw new Error("Invalid checklist update.");
    }
    plan.items[index].done = done;
    if (repeatIntervalDays(plan.items[index].frequency)) {
      plan.items[index].completedOn = done ? new Date(now()).toISOString() : null;
    }
    return publicPlan(plan);
  }

  async function dispatchDue(baseUrl) {
    purge();
    for (const plan of plans.values()) {
      refreshRecurringItems(plan);
      if (plan.nextReminderAt > now() || plan.items.every((item) => item.done)) continue;
      // Advance before awaiting delivery so a slow provider cannot duplicate a reminder.
      plan.nextReminderAt = plan.reminders ? now() + reminderIntervalMs : Infinity;
      const link = `${baseUrl}/patient/${plan.id}`;
      const body = `Please review your care checklist: ${link}`;
      for (const [channel, to] of [["sms", plan.phone], ["email", plan.email]]) {
        if (!to) continue;
        try {
          const status = await send({ channel, to, body, link });
          plan.delivery.push({ channel, status, at: now() });
        } catch {
          plan.delivery.push({ channel, status: "failed", at: now() });
        }
      }
    }
  }

  function delivery(id) {
    purge();
    const plan = plans.get(id);
    return plan ? [...plan.delivery] : null;
  }

  return { create, get, update, dispatchDue, delivery, purge };
}

export function createReminderSender({ env = process.env, fetchImpl = fetch } = {}) {
  return async ({ channel, to, body, link }) => {
    if (!/^https:\/\//i.test(link)) return "demo only";
    if (channel === "sms") {
      const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from } = env;
      if (!sid || !token || !from) return "demo only";
      const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
      });
      if (!response.ok) throw new Error("SMS provider rejected the message.");
      return "accepted by Twilio";
    }
    const { SENDGRID_API_KEY: key, SENDGRID_FROM_EMAIL: from } = env;
    if (!key || !from) return "demo only";
    const response = await fetchImpl("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from },
        subject: "Care checklist reminder", content: [{ type: "text/plain", value: `Please review your care checklist: ${link}` }] }),
    });
    if (!response.ok) throw new Error("Email provider rejected the message.");
    return "accepted by SendGrid";
  };
}
