import assert from "node:assert/strict";
import { test } from "node:test";
import { createChecklistStore, createReminderSender } from "./checklists.mjs";

test("consented checklist sends generic reminders and stops when complete", async () => {
  let time = 1000;
  const sent = [];
  const store = createChecklistStore({ now: () => time, reminderIntervalMs: 100,
    send: async (message) => { sent.push(message); return "demo only"; } });
  const plan = store.create({ items: ["Take medicine at 8 AM"], phone: "+15551234567", email: "a@example.com", consent: true });
  await store.dispatchDue("http://localhost:3001");
  assert.equal(sent.length, 2);
  assert(sent.every((message) => !message.body.includes("medicine")));
  time += 100;
  store.update(plan.id, 0, true);
  await store.dispatchDue("http://localhost:3001");
  assert.equal(sent.length, 2);
});

test("checklists expire and require consent", () => {
  let time = 0;
  const store = createChecklistStore({ now: () => time });
  assert.throws(() => store.create({ items: ["Step"], email: "a@example.com", consent: false }));
  const plan = store.create({ items: ["Step"], email: "a@example.com", consent: true });
  time = 30 * 24 * 60 * 60 * 1000;
  assert.equal(store.get(plan.id), null);
});

test("retains category-specific fields for patient checklists", () => {
  const store = createChecklistStore();
  const plan = store.create({ items: [
    { category: "medication", text: "Warfarin", name: "Warfarin", strength: "2 mg", dose: "1 tablet", frequency: "Every evening", timing: "8:00 PM" },
    { category: "care", text: "Keep the incision clean", description: "Keep the incision clean", frequency: "Daily" },
    { category: "testing", text: "Blood test", name: "Blood test", frequency: "Every 7 days", timing: "Before breakfast", due: "By next week" },
    { category: "avoid", text: "Do not drive", description: "Do not drive" },
  ] });

  assert.deepEqual(plan.items.map(({ category, name, description, strength, dose, frequency, timing, due }) => ({ category, name, description, strength, dose, frequency, timing, due })), [
    { category: "medication", name: "Warfarin", description: "", strength: "2 mg", dose: "1 tablet", frequency: "Every evening", timing: "8:00 PM", due: "" },
    { category: "care", name: "", description: "Keep the incision clean", strength: "", dose: "", frequency: "Daily", timing: "", due: "" },
    { category: "testing", name: "Blood test", description: "", strength: "", dose: "", frequency: "Every 7 days", timing: "Before breakfast", due: "By next week" },
    { category: "avoid", name: "", description: "Do not drive", strength: "", dose: "", frequency: "", timing: "", due: "" },
  ]);
});

test("repeating items reset on their configured interval", () => {
  let time = Date.UTC(2026, 0, 1);
  const store = createChecklistStore({ now: () => time });
  const plan = store.create({ items: [{ category: "testing", text: "Blood test", name: "Blood test", frequency: "Every 7 days" }] });
  store.update(plan.id, 0, true);
  time += 6 * 24 * 60 * 60 * 1000;
  assert.equal(store.get(plan.id).items[0].done, true);
  time += 24 * 60 * 60 * 1000;
  assert.equal(store.get(plan.id).items[0].done, false);
});

test("unconfigured provider remains in demo mode", async () => {
  const send = createReminderSender({ env: {}, fetchImpl: () => { throw new Error("Should not call provider"); } });
  assert.equal(await send({ channel: "sms", to: "+15551234567", body: "Hello" }), "demo only");
  assert.equal(await send({ channel: "email", to: "a@example.com", link: "http://localhost" }), "demo only");
});
