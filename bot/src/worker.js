// «Грузовой помощник» — Telegram-бот и приём заявок.
// Работает на Cloudflare Workers (бесплатный тариф).
//
// Маршруты:
//   POST /webhook  — обновления от Telegram (защищено секретным заголовком)
//   POST /order    — заявка из формы (из бота или с сайта) → сообщение владельцу
//   GET  /         — проверка, что сервис жив
//
// Секреты (wrangler secret put):  BOT_TOKEN, WEBHOOK_SECRET, OWNER_CHAT_ID
// Переменные (wrangler.toml):      FORM_URL, ALLOWED_ORIGIN

const MAX_TEXT = 3500;
const INITDATA_MAX_AGE = 24 * 3600; // секунд

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
      return url.pathname === "/order" ? withCors(r, req, env) : r;
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

function orderKeyboard(env) {
  return {
    inline_keyboard: [
      [{ text: "📦 Оставить заявку", web_app: { url: env.FORM_URL } }],
      [{ text: "💬 WhatsApp", url: "https://wa.me/79883424900" }],
    ],
  };
}

/* ---------------- Updates from Telegram ---------------- */

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.chat || msg.chat.type !== "private") return;
  const chatId = String(msg.chat.id);
  const isOwner = chatId === String(env.OWNER_CHAT_ID);
  const text = (msg.text || "").trim();

  if (text.startsWith("/start")) {
    if (isOwner) {
      await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "✅ Вы получаете заявки «Грузового помощника». Новые заявки и вопросы клиентов будут приходить сюда.",
      });
      return;
    }
    await tg(env, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text:
        "🚚 <b>Грузовой помощник</b>\n" +
        "Доставим. Перевезём. Поможем.\n\n" +
        "Грузоперевозки по Новороссийску и Краснодарскому краю: мебель, бытовая техника, личные вещи, небольшие переезды.\n\n" +
        "Нажмите <b>«Оставить заявку»</b>, заполните форму за пару минут, и мы свяжемся с вами, чтобы согласовать стоимость.\n\n" +
        "📞 +7 988 342-49-00",
      reply_markup: orderKeyboard(env),
    });
    return;
  }

  if (isOwner) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Это бот для заявок. Отвечать клиентам удобнее напрямую: по телефону или кнопкой под заявкой.",
    });
    return;
  }

  // Любое другое сообщение клиента: передаём владельцу и подсказываем про форму
  if (env.OWNER_CHAT_ID) {
    const u = msg.from || {};
    await tg(env, "sendMessage", {
      chat_id: env.OWNER_CHAT_ID,
      parse_mode: "HTML",
      text: `💬 <b>Сообщение в боте</b> от ${userLink(u)}:`,
      reply_markup: u.username ? { inline_keyboard: [[{ text: "✉️ Ответить в Telegram", url: `https://t.me/${u.username}` }]] } : undefined,
    });
    await tg(env, "forwardMessage", { chat_id: env.OWNER_CHAT_ID, from_chat_id: chatId, message_id: msg.message_id });
  }
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: "Спасибо! Сообщение передано. Чтобы рассчитать перевозку, удобнее всего оставить заявку по кнопке ниже.",
    reply_markup: orderKeyboard(env),
  });
}

/* ---------------- Orders from the form ---------------- */

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

  const source = tgUser ? `из бота, ${userLink(tgUser)}` : "с сайта";
  const message =
    `🆕 <b>Новая заявка</b> (${source})\n\n` +
    escapeHtml(text.replace(/\*/g, "")); // убираем WhatsApp-разметку *жирный*

  const buttons = [[{ text: "💬 WhatsApp клиенту", url: `https://wa.me/7${phone10}` }]];
  if (tgUser && tgUser.username) buttons.push([{ text: "✉️ Написать в Telegram", url: `https://t.me/${tgUser.username}` }]);

  const sent = await tg(env, "sendMessage", {
    chat_id: env.OWNER_CHAT_ID,
    parse_mode: "HTML",
    text: message,
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: buttons },
  });
  if (!sent.ok) return json({ ok: false, error: "Не удалось отправить заявку. Позвоните или напишите в WhatsApp." }, 502);

  if (tgUser) {
    await tg(env, "sendMessage", {
      chat_id: tgUser.id,
      text: "✅ Заявка принята! Скоро свяжемся с вами, чтобы уточнить детали и согласовать стоимость.\n\n📞 +7 988 342-49-00",
    });
  }
  return json({ ok: true });
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
