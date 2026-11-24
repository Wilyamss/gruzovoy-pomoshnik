// Запуск: cd bot && node --test test/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { verifyInitData } from "../src/worker.js";

const store = new Map();
const env = {
  BOT_TOKEN: "123456:TEST-token",
  WEBHOOK_SECRET: "s3cret",
  OWNER_CHAT_ID: "999",
  FORM_URL: "https://wilyamss.github.io/gruzovoy-pomoshnik/",
  WELCOME_IMG: "https://wilyamss.github.io/gruzovoy-pomoshnik/brand/welcome.png",
  ALLOWED_ORIGIN: "https://wilyamss.github.io",
  KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } },
};

let calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true, result: {} }));
};
beforeEach(() => { calls = []; });

async function signInitData(user, token, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: "AAA", user: JSON.stringify(user) });
  const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = new Uint8Array(await crypto.subtle.sign("HMAC", k1, enc.encode(token)));
  const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", k2, enc.encode(dcs)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  params.set("hash", sig);
  return params.toString();
}

const order = (body, origin = "https://wilyamss.github.io") =>
  worker.fetch(new Request("https://w.example/order", {
    method: "POST", headers: { "content-type": "application/json", Origin: origin }, body: JSON.stringify(body),
  }), env);
const hook = (update) =>
  worker.fetch(new Request("https://w.example/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret" }, body: JSON.stringify(update),
  }), env);

const TEXT = "🚚 *Заявка — Грузовой помощник*\n\n👤 *Имя:* Анна <b>\n📍 *Погрузка:* Новороссийск";

test("site order: numbered, escaped, status buttons, CORS", async () => {
  store.clear();
  const r = await order({ text: TEXT, name: "Анна", phone: "+7 (918) 123-45-67" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).number, 1);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://wilyamss.github.io");
  assert.equal(calls.length, 1);
  const m = calls[0].body;
  assert.equal(m.chat_id, "999");
  assert.match(m.text, /Заявка №1<\/b> · с сайта/);
  assert.match(m.text, /Анна &lt;b&gt;/);
  assert.doesNotMatch(m.text, /\*|Грузовой помощник/);
  assert.equal(m.reply_markup.inline_keyboard[0][0].callback_data, "acc:0:1:9181234567");
  assert.equal(m.reply_markup.inline_keyboard[1][0].url, "https://wa.me/79181234567");
  const r2 = await order({ text: TEXT, name: "Анна", phone: "89181234567" });
  assert.equal((await r2.json()).number, 2);
});

test("missing fields rejected", async () => {
  const r = await order({ text: TEXT, name: "А", phone: "123" });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test("honeypot silently dropped", async () => {
  const r = await order({ text: TEXT, name: "Анна", phone: "89181234567", hp: "spam" });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0);
});

test("foreign origin gets no CORS header", async () => {
  const r = await order({ text: TEXT, name: "Анна", phone: "89181234567" }, "https://evil.example");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
});

test("bot order: valid initData → owner + client confirmation with number", async () => {
  store.clear();
  const initData = await signInitData({ id: 42, first_name: "Иван", username: "ivan" }, env.BOT_TOKEN);
  const r = await order({ text: TEXT, name: "Иван", phone: "89181234567", initData });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[0].body.text, /Иван<\/a> \(@ivan\)/);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].callback_data, "acc:42:1:9181234567");
  assert.equal(calls[0].body.reply_markup.inline_keyboard[1][1].url, "https://t.me/ivan");
  assert.equal(calls[1].body.chat_id, 42);
  assert.match(calls[1].body.text, /Заявка №1 отправлена/);
});

test("bot order: forged / expired initData rejected", async () => {
  const forged = await signInitData({ id: 42, first_name: "X" }, "000:wrong");
  assert.equal((await order({ text: TEXT, name: "Иван", phone: "89181234567", initData: forged })).status, 403);
  const old = await signInitData({ id: 42, first_name: "X" }, env.BOT_TOKEN, Math.floor(Date.now() / 1000) - 3 * 86400);
  assert.equal(await verifyInitData(old, env.BOT_TOKEN), null);
  assert.equal(calls.length, 0);
});

test("webhook requires secret; /start sends welcome photo with form button", async () => {
  const upd = { message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Иван" }, text: "/start" } };
  const bad = await worker.fetch(new Request("https://w.example/webhook", { method: "POST", body: JSON.stringify(upd) }), env);
  assert.equal(bad.status, 403);
  assert.equal((await hook(upd)).status, 200);
  assert.equal(calls[0].method, "sendPhoto");
  assert.equal(calls[0].body.photo, env.WELCOME_IMG);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].web_app.url, env.FORM_URL);
});

test("/price and the Цены button show prices", async () => {
  await hook({ message: { message_id: 2, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/price" } });
  assert.match(calls[0].body.text, /от 1 500 ₽/);
  calls = [];
  await hook({ callback_query: { id: "q", data: "contacts", from: { id: 42 }, message: { chat: { id: 42 } } } });
  assert.deepEqual(calls.map((c) => c.method), ["answerCallbackQuery", "sendMessage"]);
  assert.match(calls[1].body.text, /342-49-00/);
});

test("client text is forwarded to owner", async () => {
  await hook({ message: { message_id: 7, chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Иван" }, text: "Сколько до Анапы?" } });
  assert.deepEqual(calls.map((c) => c.method), ["sendMessage", "forwardMessage", "sendMessage"]);
  assert.equal(calls[1].body.chat_id, "999");
});

test("photo album: one header, every photo forwarded, one reply", async () => {
  store.clear();
  for (const id of [10, 11, 12]) {
    await hook({ message: { message_id: id, media_group_id: "G1", chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Иван" }, photo: [{}] } });
  }
  assert.deepEqual(calls.map((c) => c.method), ["sendMessage", "forwardMessage", "sendMessage", "forwardMessage", "forwardMessage"]);
  assert.match(calls[0].body.text, /Фото/);
});

const ownerMsg = {
  message_id: 55, chat: { id: 999 },
  text: "🆕 Заявка №3 · Иван (@ivan)\n\n👤 Имя: Иван",
  entities: [{ type: "bold", offset: 3, length: 9 }],
  reply_markup: { inline_keyboard: [[{ text: "✅", callback_data: "acc:42:3:9181234567" }], [{ text: "💬 WhatsApp", url: "https://wa.me/79181234567" }, { text: "✉️ Telegram", url: "https://t.me/ivan" }]] },
};

test("owner takes order: message edited, client notified, next buttons", async () => {
  await hook({ callback_query: { id: "q1", data: "acc:42:3:9181234567", from: { id: 999 }, message: ownerMsg } });
  const methods = calls.map((c) => c.method);
  assert.deepEqual(methods, ["editMessageText", "sendMessage", "answerCallbackQuery"]);
  const ed = calls[0].body;
  assert.match(ed.text, /\n\n✅ В работе · /);
  assert.deepEqual(ed.entities, ownerMsg.entities);
  assert.equal(ed.reply_markup.inline_keyboard[0][0].callback_data, "done:42:3:9181234567");
  assert.equal(ed.reply_markup.inline_keyboard[1][1].url, "https://t.me/ivan");
  assert.equal(calls[1].body.chat_id, 42);
  assert.match(calls[1].body.text, /№3 принята в работу/);
});

test("done replaces previous status line; reject doesn't message client", async () => {
  const taken = { ...ownerMsg, text: ownerMsg.text + "\n\n✅ В работе · 24.11, 14:05" };
  await hook({ callback_query: { id: "q2", data: "done:42:3:9181234567", from: { id: 999 }, message: taken } });
  assert.doesNotMatch(calls[0].body.text, /В работе/);
  assert.match(calls[0].body.text, /🏁 Выполнена · /);
  assert.equal(calls[0].body.reply_markup.inline_keyboard.length, 1);
  assert.match(calls[1].body.text, /выполнена. Спасибо/);
  calls = [];
  await hook({ callback_query: { id: "q3", data: "rej:42:3:9181234567", from: { id: 999 }, message: ownerMsg } });
  assert.deepEqual(calls.map((c) => c.method), ["editMessageText", "answerCallbackQuery"]);
});

test("strangers can't press owner's status buttons", async () => {
  await hook({ callback_query: { id: "q4", data: "acc:42:3:9181234567", from: { id: 42 }, message: ownerMsg } });
  assert.deepEqual(calls.map((c) => c.method), ["answerCallbackQuery"]);
});
