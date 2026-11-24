// «Грузовой помощник» — Telegram-бот и приём заявок.
// Работает на Cloudflare Workers (бесплатный тариф).
//
// Маршруты:
//   POST /webhook  — обновления от Telegram (защищено секретным заголовком)
//   POST /order    — заявка из формы → сообщение владельцу
//   GET  /         — проверка, что сервис жив
//
// Секреты (wrangler secret put):  BOT_TOKEN, WEBHOOK_SECRET, OWNER_CHAT_ID
// Переменные (wrangler.toml):      FORM_URL, WELCOME_IMG, ALLOWED_ORIGIN
// Хранилище (KV):                  KV — счётчик номеров заявок

const MAX_TEXT = 3500;
const INITDATA_MAX_AGE = 24 * 3600; // секунд
const PHONE = "+7 988 342-49-00";
const WA_OWNER = "https://wa.me/79883424900";

const PRICES =
  "💰 <b>Ориентировочные цены</b>\n\n" +
  "🚚 Минимальный городской заказ — <b>от 1 500 ₽</b>\n" +
  "⏱ Дополнительный час — <b>600 ₽</b>\n" +
  "🛣 Дополнительный километр — <b>35 ₽</b>\n" +
  "📍 Дополнительная остановка — <b>300 ₽</b>\n" +
  "💪 Услуги грузчика — <b>от 700 ₽/час</b>\n" +
  "🌄 Пригородные маршруты — <b>индивидуальный расчёт</b>\n\n" +
  "<i>Цены предварительные. Итоговая стоимость согласовывается до начала перевозки и зависит от маршрута, объёма груза, этажности и дополнительных услуг.</i>";

const CONTACTS =
  "📞 <b>Контакты</b>\n\n" +
  `Телефон и WhatsApp: <b>${PHONE}</b>\n` +
  "Telegram: @seywax\n\n" +
  "📍 Новороссийск и Краснодарский край\n" +
  "🚐 Лада Ларгус, цельнометаллический фургон";

const WELCOME =
  "🚚 <b>Грузовой помощник</b>\n" +
  "<i>Доставим. Перевезём. Поможем.</i>\n\n" +
  "Грузоперевозки по Новороссийску и Краснодарскому краю: мебель, бытовая техника, личные вещи, небольшие переезды.\n\n" +
  "👇 Нажмите <b>«Оставить заявку»</b> — это займёт пару минут. Мы свяжемся с вами и согласуем стоимость до начала перевозки.";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), req, env);

      if (url.pathname === "/webhook" && req.method === "POST") {
        if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
        const update = await req.json();
        await handleUpdate(update, env);
        return new Response("ok");
      }

      if (url.pathname === "/order" && req.method === "POST") {
        return withCors(await handleOrder(req, env), req, env);
      }

      if (url.pathname === "/") return new Response("Грузовой помощник: бот работает");
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e && e.stack || e);
      const r = json({ ok: false, error: "Ошибка сервера. Позвоните или напишите в WhatsApp." }, 500);
      return url.pathname === "/order" ? withCors(r, req, env) : (url.pathname === "/webhook" ? new Response("ok") : r);
    }
  },
};

/* ---------------- Telegram API ---------------- */

async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.error("Telegram", method, res.status, data.description);
  return data;
}

function mainKeyboard(env) {
  return {
    inline_keyboard: [
      [{ text: "📦 Оставить заявку", web_app: { url: env.FORM_URL } }],
      [{ text: "💰 Цены", callback_data: "prices" }, { text: "📞 Контакты", callback_data: "contacts" }],
    ],
  };
}

/* ---------------- Updates from Telegram ---------------- */

async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);

  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== "private") return;
  const chatId = String(msg.chat.id);
  const isOwner = chatId === String(env.OWNER_CHAT_ID);
  const text = (msg.text || "").trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : "";

  if (isOwner) {
    if (cmd === "/start" || cmd === "/help") {
      return tg(env, "sendMessage", {
        chat_id: chatId, parse_mode: "HTML",
        text:
          "✅ <b>Вы получаете заявки «Грузового помощника».</b>\n\n" +
          "Под каждой заявкой есть кнопки:\n" +
          "• <b>✅ Взять в работу</b> — клиенту придёт сообщение, что заявка принята\n" +
          "• <b>🏁 Выполнена</b> — клиенту придёт благодарность\n" +
          "• <b>❌ Отказ</b> — отметка для вас, клиенту ничего не уходит\n\n" +
          "Фото и вопросы клиентов из бота тоже приходят сюда.",
      });
    }
    if (cmd === "/price") return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: PRICES });
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Это бот для заявок. Клиенту удобнее ответить напрямую: кнопками под его заявкой или сообщением.",
    });
  }

  if (cmd === "/start" || cmd === "/help") return sendWelcome(env, chatId);
  if (cmd === "/price") return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: PRICES, reply_markup: mainKeyboard(env) });
  if (cmd === "/contacts") return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: CONTACTS, reply_markup: mainKeyboard(env) });

  // Любое другое сообщение клиента (текст, фото, голосовое…) — передаём владельцу
  if (env.OWNER_CHAT_ID) {
    const u = msg.from || {};
    const isMedia = !!(msg.photo || msg.video || msg.document);
    // В альбоме из нескольких фото заголовок и ответ клиенту — только один раз
    let firstInGroup = true;
    if (msg.media_group_id && env.KV) {
      const key = `mg:${msg.media_group_id}`;
      firstInGroup = !(await env.KV.get(key));
      if (firstInGroup) await env.KV.put(key, "1", { expirationTtl: 120 });
    }
    if (firstInGroup) {
      await tg(env, "sendMessage", {
        chat_id: env.OWNER_CHAT_ID,
        parse_mode: "HTML",
        text: `${isMedia ? "📷 <b>Фото / файл</b>" : "💬 <b>Сообщение</b>"} от ${userLink(u)}:`,
        reply_markup: u.username ? { inline_keyboard: [[{ text: "✉️ Ответить в Telegram", url: `https://t.me/${u.username}` }]] } : undefined,
      });
    }
    await tg(env, "forwardMessage", { chat_id: env.OWNER_CHAT_ID, from_chat_id: chatId, message_id: msg.message_id });
    if (!firstInGroup) return;
  }
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: msg.photo || msg.video || msg.document
      ? "📷 Спасибо, передали! Если ещё не оставляли заявку — нажмите кнопку ниже."
      : "Спасибо, сообщение передано — скоро ответим. Чтобы мы сразу рассчитали перевозку, удобнее оставить заявку по кнопке ниже.",
    reply_markup: mainKeyboard(env),
  });
}

async function sendWelcome(env, chatId) {
  if (env.WELCOME_IMG) {
    const r = await tg(env, "sendPhoto", {
      chat_id: chatId, photo: env.WELCOME_IMG, caption: WELCOME, parse_mode: "HTML", reply_markup: mainKeyboard(env),
    });
    if (r.ok) return r;
  }
  return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: WELCOME, reply_markup: mainKeyboard(env) });
}

/* ---------------- Inline buttons ---------------- */

async function handleCallback(cq, env) {
  const data = String(cq.data || "");
  const fromId = String(cq.from && cq.from.id);
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;

  if (data === "prices" || data === "contacts") {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: data === "prices" ? PRICES : CONTACTS, reply_markup: mainKeyboard(env) });
  }

  // Статусы заявок — только для владельца: "acc|done|rej:<clientId>:<номер>:<телефон>"
  const m = data.match(/^(acc|done|rej):(\d+):(\d+):(\d{10})$/);
  if (!m || fromId !== String(env.OWNER_CHAT_ID)) {
    return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  }
  const [, action, clientId, num, phone10] = m;
  const msg = cq.message;
  const time = new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const label = { acc: "✅ В работе", done: "🏁 Выполнена", rej: "❌ Отказ" }[action];
  const statusLine = `\n\n${label} · ${time}`;

  const contactRow = orderContactRow(phone10, msg);
  const keyboard = action === "acc"
    ? [[{ text: "🏁 Выполнена", callback_data: `done:${clientId}:${num}:${phone10}` }, { text: "❌ Отказ", callback_data: `rej:${clientId}:${num}:${phone10}` }], contactRow]
    : [contactRow];

  // Убираем прошлую строку статуса и дописываем новую (форматирование сохраняется — меняем только хвост)
  const baseText = (msg.text || "").replace(/\n\n(✅ В работе|🏁 Выполнена|❌ Отказ) · .*$/s, "");
  await tg(env, "editMessageText", {
    chat_id: msg.chat.id, message_id: msg.message_id,
    text: baseText + statusLine,
    entities: (msg.entities || []).filter((e) => e.offset + e.length <= baseText.length),
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard },
  });

  const clientNote = clientId !== "0" && {
    acc: `✅ Заявка №${num} принята в работу! Скоро свяжемся с вами, чтобы уточнить детали и согласовать стоимость.\n\n📞 ${PHONE}`,
    done: `🏁 Заявка №${num} выполнена. Спасибо, что выбрали «Грузовой помощник»! Будем рады помочь снова 🚚`,
  }[action];
  if (clientNote) await tg(env, "sendMessage", { chat_id: Number(clientId), text: clientNote, reply_markup: mainKeyboard(env) });

  return tg(env, "answerCallbackQuery", {
    callback_query_id: cq.id,
    text: action === "rej" ? "Отмечено: отказ" : clientNote ? `${label}. Клиенту отправлено уведомление` : label,
  });
}

function orderContactRow(phone10, msg) {
  const row = [{ text: "💬 WhatsApp", url: `https://wa.me/7${phone10}` }];
  // Кнопку «Telegram» берём из исходной клавиатуры, если она там была
  const kb = msg && msg.reply_markup && msg.reply_markup.inline_keyboard || [];
  for (const r of kb) for (const b of r) if (b.url && b.url.startsWith("https://t.me/")) row.push({ text: "✉️ Telegram", url: b.url });
  return row;
}

/* ---------------- Orders from the form ---------------- */

async function nextOrderNumber(env) {
  if (!env.KV) return null;
  const n = Number(await env.KV.get("orderSeq") || 0) + 1;
  await env.KV.put("orderSeq", String(n));
  return n;
}

async function handleOrder(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Неверный формат заявки" }, 400); }
  if (!body || typeof body !== "object") return json({ ok: false, error: "Неверный формат заявки" }, 400);

  // Ловушка для спам-ботов: настоящие люди это поле не видят
  if (body.hp) return json({ ok: true });

  const text = String(body.text || "").slice(0, MAX_TEXT).trim();
  const name = String(body.name || "").trim().slice(0, 60);
  const digits = String(body.phone || "").replace(/\D/g, "");
  const phone10 = digits.length === 11 && /^[78]/.test(digits) ? digits.slice(1) : digits;
  if (name.length < 2 || phone10.length !== 10 || text.length < 20) {
    return json({ ok: false, error: "Заполните имя, телефон и адреса" }, 400);
  }

  // Заявка из бота: проверяем подпись Telegram, чтобы знать, кто отправил
  let tgUser = null;
  if (body.initData) {
    tgUser = await verifyInitData(String(body.initData), env.BOT_TOKEN);
    if (!tgUser) return json({ ok: false, error: "Не удалось подтвердить отправку из Telegram. Откройте форму из бота ещё раз." }, 403);
  }

  const num = await nextOrderNumber(env);
  const numLabel = num ? ` №${num}` : "";
  const source = tgUser ? userLink(tgUser) : "с сайта";
  // Убираем первую строку-заголовок формы и WhatsApp-разметку *жирный*
  const body_ = text.replace(/\*/g, "").replace(/^🚚[^\n]*\n+/, "");
  const message = `🆕 <b>Заявка${numLabel}</b> · ${source}\n\n` + escapeHtml(body_);

  const cid = tgUser ? tgUser.id : 0;
  const n = num || 0;
  const contactRow = [{ text: "💬 WhatsApp", url: `https://wa.me/7${phone10}` }];
  if (tgUser && tgUser.username) contactRow.push({ text: "✉️ Telegram", url: `https://t.me/${tgUser.username}` });

  const sent = await tg(env, "sendMessage", {
    chat_id: env.OWNER_CHAT_ID,
    parse_mode: "HTML",
    text: message,
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Взять в работу", callback_data: `acc:${cid}:${n}:${phone10}` }, { text: "❌ Отказ", callback_data: `rej:${cid}:${n}:${phone10}` }],
        contactRow,
      ],
    },
  });
  if (!sent.ok) return json({ ok: false, error: "Не удалось отправить заявку. Позвоните или напишите в WhatsApp." }, 502);

  if (tgUser) {
    await tg(env, "sendMessage", {
      chat_id: tgUser.id,
      text:
        `📨 Заявка${numLabel} отправлена! Мы скоро свяжемся с вами, чтобы уточнить детали и согласовать стоимость.\n\n` +
        "📷 Если есть фото груза — пришлите их сюда, это поможет точнее рассчитать перевозку.\n\n" +
        `📞 ${PHONE}`,
    });
  }
  return json({ ok: true, number: num });
}

/* ---------------- Helpers ---------------- */

// Проверка подписи Telegram Mini App:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function verifyInitData(initData, botToken, now = Date.now() / 1000) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const enc = new TextEncoder();
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  const sig = toHex(await hmac(secret, enc.encode(dataCheckString)));
  if (!timingSafeEqual(sig, hash)) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || now - authDate > INITDATA_MAX_AGE) return null;
  try { return JSON.parse(params.get("user") || "null"); } catch { return null; }
}

async function hmac(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function userLink(u) {
  const name = escapeHtml([u.first_name, u.last_name].filter(Boolean).join(" ") || "клиент");
  const handle = u.username ? ` (@${escapeHtml(u.username)})` : "";
  return `<a href="tg://user?id=${Number(u.id)}">${name}</a>${handle}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function withCors(res, req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = new Headers(res.headers);
  if (allowed.includes(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
    h.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    h.set("Access-Control-Allow-Headers", "content-type");
    h.set("Access-Control-Max-Age", "86400");
  }
  return new Response(res.body, { status: res.status, headers: h });
}
