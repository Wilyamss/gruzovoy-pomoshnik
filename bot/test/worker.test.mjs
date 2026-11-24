// Запуск: cd bot && node --test test/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { verifyInitData, remindStale, dailySummary } from "../src/worker.js";

const store = new Map();
const env = {
  BOT_TOKEN: "123456:TEST-token",
  WEBHOOK_SECRET: "s3cret",
  OWNER_CHAT_ID: "999",
  FORM_URL: "https://wilyamss.github.io/gruzovoy-pomoshnik/",
  WELCOME_IMG: "https://wilyamss.github.io/gruzovoy-pomoshnik/brand/welcome.png",
  ALLOWED_ORIGIN: "https://wilyamss.github.io",
  KV: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } },
  EXPORT_KEY: "exp-key",
};

let calls = [];
globalThis.fetch = async (url, init) => {
  const body = init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body);
  calls.push({ method: String(url).split("/").pop(), body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 500 + calls.length } }));
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

/* ---------- новые функции ---------- */

const META = { from: "Новороссийск, Советов 1", to: "Анапа", when: "25.11.2026 (ср)", cargo: "Мебель", loader: "1 грузчик" };

test("source from /start link goes into order; record + open list saved; repeat form stored", async () => {
  store.clear();
  await hook({ message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "/start car" } });
  assert.equal(store.get("src:42"), "car");
  calls = [];
  const initData = await signInitData({ id: 42, first_name: "Иван" }, env.BOT_TOKEN);
  await order({ text: TEXT, name: "Иван", phone: "89181234567", initData, estimate: 2200, meta: META, form: { name: "Иван", from: "Новороссийск", cargo: ["Мебель"], "bad key": "x" } });
  assert.match(calls[0].body.text, /Источник: 🚐 наклейка на машине/);
  assert.match(calls[0].body.text, /Клиент видел оценку: от 2 200 ₽/);
  const rec = JSON.parse(store.get("order:1"));
  assert.equal(rec.status, "new"); assert.equal(rec.cid, 42); assert.equal(rec.from, META.from); assert.equal(rec.ownerMsgId, 501);
  assert.deepEqual(JSON.parse(store.get("open")), [1]);
  assert.deepEqual(JSON.parse(store.get("last:42")), { name: "Иван", from: "Новороссийск", cargo: ["Мебель"] });
  const last = await worker.fetch(new Request("https://w.example/last", { method: "POST", body: JSON.stringify({ initData }) }), env);
  assert.equal((await last.json()).form.from, "Новороссийск");
  const bad = await worker.fetch(new Request("https://w.example/last", { method: "POST", body: JSON.stringify({ initData: "x=1&hash=00" }) }), env);
  assert.equal(bad.status, 403);
});

test("site ?src= is used for site orders", async () => {
  store.clear();
  await order({ text: TEXT, name: "Анна", phone: "89181234567", source: "avito" });
  assert.match(calls[0].body.text, /Источник: 📢 Авито/);
});

test("status flow updates record and open list; done asks client for rating", async () => {
  store.clear();
  const initData = await signInitData({ id: 42, first_name: "Иван" }, env.BOT_TOKEN);
  await order({ text: TEXT, name: "Иван", phone: "89181234567", initData, meta: META });
  calls = [];
  const msg = { message_id: 501, chat: { id: 999 }, text: "🆕 Заявка №1 · Иван\n\nтекст", entities: [] };
  await hook({ callback_query: { id: "a", data: "acc:42:1:9181234567", from: { id: 999 }, message: msg } });
  assert.equal(JSON.parse(store.get("order:1")).status, "acc");
  assert.deepEqual(JSON.parse(store.get("open")), [1]);
  calls = [];
  await hook({ callback_query: { id: "b", data: "done:42:1:9181234567", from: { id: 999 }, message: msg } });
  assert.equal(JSON.parse(store.get("order:1")).status, "done");
  assert.deepEqual(JSON.parse(store.get("open")), []);
  const ask = calls.find((c) => c.method === "sendMessage" && c.body.chat_id === 42);
  assert.equal(ask.body.reply_markup.inline_keyboard[0][4].callback_data, "rate:1:5");

  // клиент ставит 5 и пишет отзыв
  calls = [];
  await hook({ callback_query: { id: "c", data: "rate:1:5", from: { id: 42 }, message: { message_id: 9, chat: { id: 42 } } } });
  assert.equal(JSON.parse(store.get("order:1")).rating, 5);
  assert.ok(calls.some((c) => c.body.chat_id === "999" && /Оценка 5\/5/.test(c.body.text)));
  calls = [];
  await hook({ message: { message_id: 10, chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Иван" }, text: "Всё отлично, быстро и аккуратно" } });
  assert.equal(JSON.parse(store.get("order:1")).review, "Всё отлично, быстро и аккуратно");
  assert.ok(calls.some((c) => c.body.chat_id === "999" && /Отзыв/.test(c.body.text)));
  assert.equal(store.get("review:42"), undefined);

  // повторная оценка и чужая оценка не проходят
  calls = [];
  await hook({ callback_query: { id: "d", data: "rate:1:1", from: { id: 42 }, message: { message_id: 9, chat: { id: 42 } } } });
  await hook({ callback_query: { id: "e", data: "rate:1:1", from: { id: 77 }, message: { message_id: 9, chat: { id: 77 } } } });
  assert.equal(JSON.parse(store.get("order:1")).rating, 5);
  assert.deepEqual(calls.map((c) => c.method), ["answerCallbackQuery", "answerCallbackQuery"]);
});

test("reminder after 15 min, once, not at night", async () => {
  store.clear();
  await order({ text: TEXT, name: "Анна", phone: "89181234567", meta: META });
  const o = JSON.parse(store.get("order:1"));
  const noonMsk = Date.UTC(2026, 10, 25, 9, 0); // 12:00 МСК
  o.ts = noonMsk - 20 * 60000; store.set("order:1", JSON.stringify(o));
  calls = [];
  await remindStale(env, noonMsk - 10 * 60000); // прошло 10 минут — рано
  assert.equal(calls.length, 0);
  await remindStale(env, Date.UTC(2026, 10, 24, 21, 0)); // 00:00 МСК — ночь
  assert.equal(calls.length, 0);
  await remindStale(env, noonMsk);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Заявка №1 ждёт ответа<\/b> уже 20 мин/);
  assert.equal(calls[0].body.reply_parameters.message_id, 501);
  await remindStale(env, noonMsk + 600000);
  assert.equal(calls.length, 1);
});

test("daily summary counts today's orders and sources", async () => {
  store.clear();
  await order({ text: TEXT, name: "Анна", phone: "89181234567", source: "avito", meta: META });
  await order({ text: TEXT, name: "Олег", phone: "89181234568", source: "avito", meta: META });
  calls = [];
  await dailySummary(env);
  assert.match(calls[0].body.text, /Новых заявок: <b>2<\/b>/);
  assert.match(calls[0].body.text, /Авито — 2/);
  assert.match(calls[0].body.text, /Незакрытых заявок всего: <b>2<\/b>/);
});

test("owner /orders and /export; CSV endpoint needs the key", async () => {
  store.clear();
  await order({ text: TEXT, name: "Анна", phone: "89181234567", source: "car", estimate: 1500, meta: META });
  calls = [];
  await hook({ message: { message_id: 3, chat: { id: 999, type: "private" }, from: { id: 999 }, text: "/orders" } });
  assert.match(calls[0].body.text, /Незакрытые заявки: 1/);
  assert.match(calls[0].body.text, /Новороссийск, Советов 1 → Анапа/);
  calls = [];
  await hook({ message: { message_id: 4, chat: { id: 999, type: "private" }, from: { id: 999 }, text: "/export" } });
  assert.equal(calls[0].method, "sendDocument");
  const bytes = new Uint8Array(await calls[0].body.document.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]); // BOM, чтобы Excel понял кириллицу
  const csvText = await calls[0].body.document.text();
  assert.ok(csvText.startsWith("№,Дата,Время,Статус,Имя"));
  assert.match(csvText, /1,.*Новая,Анна,\+79181234567,,"Новороссийск, Советов 1",Анапа/);
  assert.equal((await worker.fetch(new Request("https://w.example/orders.csv?key=nope"), env)).status, 403);
  const ok = await worker.fetch(new Request("https://w.example/orders.csv?key=exp-key"), env);
  assert.match(await ok.text(), /наклейка на машине,1500/);
});
