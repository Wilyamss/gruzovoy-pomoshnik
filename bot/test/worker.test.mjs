// Запуск: node --test bot/test
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { verifyInitData } from "../src/worker.js";

const env = {
  BOT_TOKEN: "123456:TEST-token",
  WEBHOOK_SECRET: "s3cret",
  OWNER_CHAT_ID: "999",
  FORM_URL: "https://wilyamss.github.io/gruzovoy-pomoshnik/",
  ALLOWED_ORIGIN: "https://wilyamss.github.io",
};

let calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ method: String(url).split("/").pop(), body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true, result: {} }));
};

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

const TEXT = "🚚 *Заявка — Грузовой помощник*\n\n👤 *Имя:* Анна <b>\n📍 *Погрузка:* Новороссийск";

test("site order goes to owner, HTML escaped, CORS set", async () => {
  calls = [];
  const r = await order({ text: TEXT, name: "Анна", phone: "+7 (918) 123-45-67" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://wilyamss.github.io");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.chat_id, "999");
  assert.match(calls[0].body.text, /с сайта/);
  assert.match(calls[0].body.text, /Анна &lt;b&gt;/);
  assert.doesNotMatch(calls[0].body.text, /\*/);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].url, "https://wa.me/79181234567");
});

test("missing fields rejected", async () => {
  calls = [];
  const r = await order({ text: TEXT, name: "А", phone: "123" });
  assert.equal(r.status, 400);
  assert.equal(calls.length, 0);
});

test("honeypot silently dropped", async () => {
  calls = [];
  const r = await order({ text: TEXT, name: "Анна", phone: "89181234567", hp: "spam" });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0);
});

test("foreign origin gets no CORS header", async () => {
  const r = await order({ text: TEXT, name: "Анна", phone: "89181234567" }, "https://evil.example");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
});

test("bot order: valid initData → owner + client confirmation", async () => {
  calls = [];
  const initData = await signInitData({ id: 42, first_name: "Иван", username: "ivan" }, env.BOT_TOKEN);
  const r = await order({ text: TEXT, name: "Иван", phone: "89181234567", initData });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[0].body.text, /из бота/);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[1][0].url, "https://t.me/ivan");
  assert.equal(calls[1].body.chat_id, 42);
});

test("bot order: forged / expired initData rejected", async () => {
  calls = [];
  const forged = await signInitData({ id: 42, first_name: "X" }, "000:wrong");
  assert.equal((await order({ text: TEXT, name: "Иван", phone: "89181234567", initData: forged })).status, 403);
  const old = await signInitData({ id: 42, first_name: "X" }, env.BOT_TOKEN, Math.floor(Date.now() / 1000) - 3 * 86400);
  assert.equal(await verifyInitData(old, env.BOT_TOKEN), null);
  assert.equal(calls.length, 0);
});

test("webhook requires secret; /start shows form button", async () => {
  calls = [];
  const upd = { message: { message_id: 1, chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Иван" }, text: "/start" } };
  const bad = await worker.fetch(new Request("https://w.example/webhook", { method: "POST", body: JSON.stringify(upd) }), env);
  assert.equal(bad.status, 403);
  const ok = await worker.fetch(new Request("https://w.example/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret" }, body: JSON.stringify(upd),
  }), env);
  assert.equal(ok.status, 200);
  assert.equal(calls[0].body.reply_markup.inline_keyboard[0][0].web_app.url, env.FORM_URL);
});

test("client free text is forwarded to owner", async () => {
  calls = [];
  const upd = { message: { message_id: 7, chat: { id: 42, type: "private" }, from: { id: 42, first_name: "Иван" }, text: "Сколько до Анапы?" } };
  await worker.fetch(new Request("https://w.example/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret" }, body: JSON.stringify(upd),
  }), env);
  assert.deepEqual(calls.map((c) => c.method), ["sendMessage", "forwardMessage", "sendMessage"]);
  assert.equal(calls[1].body.chat_id, "999");
});
