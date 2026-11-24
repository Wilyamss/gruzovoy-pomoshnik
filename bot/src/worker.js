// «Грузовой помощник» — Telegram-бот и приём заявок.
// Работает на Cloudflare Workers (бесплатный тариф).
//
// Маршруты:
//   POST /webhook         — обновления от Telegram (защищено секретным заголовком)
//   POST /order           — заявка из формы → сообщение владельцу
//   POST /last            — прошлая заявка клиента (для «Повторить»), нужна подпись Telegram
//   GET  /orders.csv?key= — все заявки таблицей (для Google Таблицы)
//   GET  /                — проверка, что сервис жив
// По расписанию (cron):
//   каждые 5 минут        — напоминание владельцу о заявках без ответа
//   21:00 по Москве       — сводка за день
//
// Секреты (wrangler secret put):  BOT_TOKEN, WEBHOOK_SECRET, OWNER_CHAT_ID, EXPORT_KEY
// Переменные (wrangler.toml):      FORM_URL, WELCOME_IMG, ALLOWED_ORIGIN
// Хранилище (KV):                  KV

const MAX_TEXT = 3500;
const INITDATA_MAX_AGE = 24 * 3600; // секунд
const REMIND_AFTER_MIN = 15;
const PHONE = "+7 988 342-49-00";
const TZ = "Europe/Moscow";

// Откуда пришёл клиент: t.me/gruz_pomoshnik_bot?start=car  или  форма ?src=avito
const SOURCES = {
  car: "🚐 наклейка на машине",
  card: "🪪 визитка",
  avito: "📢 Авито",
  vk: "💬 ВКонтакте",
  maps: "🗺 Яндекс Карты / 2ГИС",
  friend: "🤝 по рекомендации",
};
const sourceLabel = (s) => (s ? SOURCES[s] || `🔗 ${s}` : "");

const STATUS = { new: "🆕 Новая", acc: "✅ В работе", done: "🏁 Выполнена", rej: "❌ Отказ" };

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

const OWNER_HELP =
  "✅ <b>Вы получаете заявки «Грузового помощника».</b>\n\n" +
  "Под каждой заявкой есть кнопки:\n" +
  "• <b>✅ Взять в работу</b> — клиенту придёт сообщение, что заявка принята\n" +
  "• <b>🏁 Выполнена</b> — клиенту придёт благодарность и просьба оценить перевозку\n" +
  "• <b>❌ Отказ</b> — отметка для вас, клиенту ничего не уходит\n\n" +
  `Если заявку не взяли в работу за ${REMIND_AFTER_MIN} минут, бот напомнит (ночью с 22:00 до 8:00 — утром). ` +
  "В 21:00 приходит сводка за день.\n\n" +
  "Команды:\n" +
  "/orders — заявки, которые ещё не закрыты\n" +
  "/export — все заявки файлом для Excel\n" +
  "/price — цены";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), req, env);

      if (url.pathname === "/webhook" && req.method === "POST") {
        if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
          return new Response("forbidden", { status: 403 });
        }
        await handleUpdate(await req.json(), env);
        return new Response("ok");
      }
      if (url.pathname === "/order" && req.method === "POST") return withCors(await handleOrder(req, env), req, env);
      if (url.pathname === "/last" && req.method === "POST") return withCors(await handleLast(req, env), req, env);
      if (url.pathname === "/orders.csv" && req.method === "GET") {
        if (!env.EXPORT_KEY || url.searchParams.get("key") !== env.EXPORT_KEY) return new Response("forbidden", { status: 403 });
        return new Response(await ordersCsv(env, false), {
          headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (url.pathname === "/") return new Response("Грузовой помощник: бот работает");
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e && e.stack || e);
      if (url.pathname === "/webhook") return new Response("ok"); // не заставляем Telegram повторять
      return withCors(json({ ok: false, error: "Ошибка сервера. Позвоните или напишите в WhatsApp." }, 500), req, env);
    }
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "0 18 * * *") await dailySummary(env);
    else await remindStale(env);
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

async function tgDocument(env, chatId, filename, content, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("caption", caption);
  fd.append("document", new Blob([content], { type: "text/csv" }), filename);
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  return res.json().catch(() => ({}));
}

function mainKeyboard(env) {
  return {
    inline_keyboard: [
      [{ text: "📦 Оставить заявку", web_app: { url: env.FORM_URL } }],
      [{ text: "💰 Цены", callback_data: "prices" }, { text: "📞 Контакты", callback_data: "contacts" }],
    ],
  };
}

/* ---------------- Storage ---------------- */

const getJSON = async (env, key, dflt = null) => {
  const s = env.KV && await env.KV.get(key);
  if (!s) return dflt;
  try { return JSON.parse(s); } catch { return dflt; }
};
const putJSON = (env, key, val, opts) => env.KV.put(key, JSON.stringify(val), opts);
const getOrder = (env, n) => getJSON(env, `order:${n}`);
const saveOrder = (env, o) => putJSON(env, `order:${o.n}`, o);
async function setOpen(env, n, isOpen) {
  const open = await getJSON(env, "open", []);
  const next = open.filter((x) => x !== n);
  if (isOpen) next.push(n);
  await putJSON(env, "open", next);
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
    if (cmd === "/start" || cmd === "/help") return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: OWNER_HELP });
    if (cmd === "/price") return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: PRICES });
    if (cmd === "/orders") return sendOpenOrders(env);
    if (cmd === "/export") return sendExport(env);
    return tg(env, "sendMessage", {
      chat_id: chatId,
      text: "Это бот для заявок. Клиенту удобнее ответить напрямую: кнопками под его заявкой. Команды: /orders, /export, /help.",
    });
  }

  if (cmd === "/start" || cmd === "/help") {
    // /start car — запоминаем, откуда пришёл клиент
    const src = (text.split(/\s+/)[1] || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
    if (src && env.KV) await env.KV.put(`src:${chatId}`, src, { expirationTtl: 60 * 86400 });
    return sendWelcome(env, chatId);
  }
  if (cmd === "/price") return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: PRICES, reply_markup: mainKeyboard(env) });
  if (cmd === "/contacts") return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: CONTACTS, reply_markup: mainKeyboard(env) });

  // Ждём текст отзыва после оценки?
  if (text && !cmd && env.KV) {
    const pendingN = await env.KV.get(`review:${chatId}`);
    if (pendingN) return saveReview(env, chatId, Number(pendingN), msg);
  }

  // Любое другое сообщение клиента (текст, фото, голосовое…) — передаём владельцу
  const u = msg.from || {};
  const isMedia = !!(msg.photo || msg.video || msg.document);
  let firstInGroup = true; // в альбоме заголовок и ответ клиенту — один раз
  if (msg.media_group_id && env.KV) {
    const key = `mg:${msg.media_group_id}`;
    firstInGroup = !(await env.KV.get(key));
    if (firstInGroup) await env.KV.put(key, "1", { expirationTtl: 120 });
  }
  if (env.OWNER_CHAT_ID) {
    if (firstInGroup) {
      await tg(env, "sendMessage", {
        chat_id: env.OWNER_CHAT_ID,
        parse_mode: "HTML",
        text: `${isMedia ? "📷 <b>Фото / файл</b>" : "💬 <b>Сообщение</b>"} от ${userLink(u)}:`,
        reply_markup: u.username ? { inline_keyboard: [[{ text: "✉️ Ответить в Telegram", url: `https://t.me/${u.username}` }]] } : undefined,
      });
    }
    await tg(env, "forwardMessage", { chat_id: env.OWNER_CHAT_ID, from_chat_id: chatId, message_id: msg.message_id });
  }
  if (!firstInGroup) return;
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: isMedia
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

const stars = (k) => "⭐".repeat(k);

async function handleCallback(cq, env) {
  const data = String(cq.data || "");
  const fromId = String(cq.from && cq.from.id);
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;

  if (data === "prices" || data === "contacts") {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text: data === "prices" ? PRICES : CONTACTS, reply_markup: mainKeyboard(env) });
  }

  // Оценка от клиента: "rate:<номер>:<1-5>"
  const r = data.match(/^rate:(\d+):([1-5])$/);
  if (r) return handleRating(env, cq, Number(r[1]), Number(r[2]));

  // Статусы заявок — только для владельца: "acc|done|rej:<clientId>:<номер>:<телефон>"
  const m = data.match(/^(acc|done|rej):(\d+):(\d+):(\d{10})$/);
  if (!m || fromId !== String(env.OWNER_CHAT_ID)) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });

  const [, action, clientId, num, phone10] = m;
  const msg = cq.message;
  const time = nowMsk({ day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const statusLine = `\n\n${STATUS[action]} · ${time}`;
  const contactRow = orderContactRow(phone10, msg);
  const keyboard = action === "acc"
    ? [[{ text: "🏁 Выполнена", callback_data: `done:${clientId}:${num}:${phone10}` }, { text: "❌ Отказ", callback_data: `rej:${clientId}:${num}:${phone10}` }], contactRow]
    : [contactRow];

  // Меняем только хвост сообщения (строку статуса), форматирование сохраняется
  const baseText = (msg.text || "").replace(/\n\n(✅ В работе|🏁 Выполнена|❌ Отказ) · .*$/s, "");
  await tg(env, "editMessageText", {
    chat_id: msg.chat.id, message_id: msg.message_id,
    text: baseText + statusLine,
    entities: (msg.entities || []).filter((e) => e.offset + e.length <= baseText.length),
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard },
  });

  const order = env.KV && await getOrder(env, num);
  if (order) {
    order.status = action;
    order[`${action}At`] = Date.now();
    await saveOrder(env, order);
    await setOpen(env, Number(num), action === "acc");
  }

  let notified = false;
  if (clientId !== "0" && action === "acc") {
    await tg(env, "sendMessage", {
      chat_id: Number(clientId),
      text: `✅ Заявка №${num} принята в работу! Скоро свяжемся с вами, чтобы уточнить детали и согласовать стоимость.\n\n📞 ${PHONE}`,
    });
    notified = true;
  }
  if (clientId !== "0" && action === "done") {
    await tg(env, "sendMessage", {
      chat_id: Number(clientId),
      text: `🏁 Заявка №${num} выполнена. Спасибо, что выбрали «Грузовой помощник»!\n\nОцените, пожалуйста, перевозку — это займёт секунду 🙏`,
      reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map((k) => ({ text: `${k} ⭐`, callback_data: `rate:${num}:${k}` }))] },
    });
    notified = true;
  }
  return tg(env, "answerCallbackQuery", {
    callback_query_id: cq.id,
    text: notified ? `${STATUS[action]}. Клиенту отправлено сообщение` : STATUS[action],
  });
}

async function handleRating(env, cq, n, k) {
  const fromId = cq.from && cq.from.id;
  const order = env.KV && await getOrder(env, n);
  if (!order || String(order.cid) !== String(fromId)) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
  if (order.rating) return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Оценка уже учтена, спасибо!" });

  order.rating = k;
  await saveOrder(env, order);
  await tg(env, "editMessageText", {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    text: `🏁 Заявка №${n} выполнена. Спасибо, что выбрали «Грузовой помощник»!\n\nВаша оценка: ${stars(k)}`,
  });
  await env.KV.put(`review:${fromId}`, String(n), { expirationTtl: 2 * 86400 });
  await tg(env, "sendMessage", {
    chat_id: fromId,
    text: k >= 4
      ? "Спасибо за оценку! 🙌 Если не сложно, напишите пару слов о перевозке одним сообщением — нам это очень поможет."
      : "Спасибо за честную оценку. Напишите, пожалуйста, одним сообщением, что было не так — мы обязательно разберёмся.",
  });
  await tg(env, "sendMessage", {
    chat_id: env.OWNER_CHAT_ID, parse_mode: "HTML",
    text: `${stars(k)} <b>Оценка ${k}/5</b> к заявке №${n} от ${escapeHtml(order.name || "клиента")}`,
  });
  return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Спасибо!" });
}

async function saveReview(env, chatId, n, msg) {
  await env.KV.delete(`review:${chatId}`);
  const text = String(msg.text || "").slice(0, 1000);
  const order = await getOrder(env, n);
  if (order) { order.review = text; await saveOrder(env, order); }
  await tg(env, "sendMessage", {
    chat_id: env.OWNER_CHAT_ID, parse_mode: "HTML",
    text: `📝 <b>Отзыв</b> к заявке №${n}${order && order.rating ? ` (${stars(order.rating)})` : ""} от ${userLink(msg.from || {})}:\n\n«${escapeHtml(text)}»`,
  });
  return tg(env, "sendMessage", { chat_id: chatId, text: "Спасибо за отзыв! Будем рады помочь снова 🚚", reply_markup: mainKeyboard(env) });
}

function orderContactRow(phone10, msg) {
  const row = [{ text: "💬 WhatsApp", url: `https://wa.me/7${phone10}` }];
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

const clip = (v, n = 300) => String(v == null ? "" : v).slice(0, n);
function cleanForm(form) {
  if (!form || typeof form !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(form).slice(0, 40)) {
    if (!/^[A-Za-z]{1,20}$/.test(k)) continue;
    out[k] = Array.isArray(v) ? v.slice(0, 10).map((x) => clip(x, 60)) : clip(v, 600);
  }
  return out;
}

async function handleOrder(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Неверный формат заявки" }, 400); }
  if (!body || typeof body !== "object") return json({ ok: false, error: "Неверный формат заявки" }, 400);
  if (body.hp) return json({ ok: true }); // ловушка для спам-ботов

  const text = clip(body.text, MAX_TEXT).trim();
  const name = clip(body.name, 60).trim();
  const digits = String(body.phone || "").replace(/\D/g, "");
  const phone10 = digits.length === 11 && /^[78]/.test(digits) ? digits.slice(1) : digits;
  if (name.length < 2 || phone10.length !== 10 || text.length < 20) {
    return json({ ok: false, error: "Заполните имя, телефон и адреса" }, 400);
  }

  let tgUser = null;
  if (body.initData) {
    tgUser = await verifyInitData(String(body.initData), env.BOT_TOKEN);
    if (!tgUser) return json({ ok: false, error: "Не удалось подтвердить отправку из Telegram. Откройте форму из бота ещё раз." }, 403);
  }

  // Источник: из ссылки на бота (/start car) или из адреса формы (?src=avito)
  let source = clip(body.source, 32).replace(/[^A-Za-z0-9_-]/g, "");
  if (tgUser && env.KV) source = (await env.KV.get(`src:${tgUser.id}`)) || source;
  const estimate = Number(body.estimate) > 0 ? Math.round(Number(body.estimate)) : 0;
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};

  const num = await nextOrderNumber(env);
  const numLabel = num ? ` №${num}` : "";
  const head = [`🆕 <b>Заявка${numLabel}</b> · ${tgUser ? userLink(tgUser) : "с сайта"}`];
  if (source) head.push(`Источник: ${escapeHtml(sourceLabel(source))}`);
  if (estimate) head.push(`Клиент видел оценку: от ${fmtRub(estimate)}`);
  const body_ = text.replace(/\*/g, "").replace(/^🚚[^\n]*\n+/, "");
  const message = head.join("\n") + "\n\n" + escapeHtml(body_);

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

  if (num && env.KV) {
    await saveOrder(env, {
      n: num, ts: Date.now(), status: "new", cid,
      tg: tgUser ? (tgUser.username ? "@" + tgUser.username : String(tgUser.id)) : "",
      name, phone: "+7" + phone10,
      from: clip(meta.from), to: clip(meta.to), when: clip(meta.when, 80),
      cargo: clip(meta.cargo, 200), loader: clip(meta.loader, 40),
      source, estimate, ownerMsgId: sent.result && sent.result.message_id,
    });
    await setOpen(env, num, true);
    const form = cleanForm(body.form);
    if (tgUser && form) await putJSON(env, `last:${tgUser.id}`, form, { expirationTtl: 365 * 86400 });
  }

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

async function handleLast(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false }, 400); }
  const user = body && body.initData && await verifyInitData(String(body.initData), env.BOT_TOKEN);
  if (!user) return json({ ok: false }, 403);
  return json({ ok: true, form: await getJSON(env, `last:${user.id}`) });
}

/* ---------------- Owner tools: list, export, reminders, summary ---------------- */

function orderLine(o) {
  const when = o.when ? ` · ${o.when}` : "";
  const route = [o.from, o.to].filter(Boolean).join(" → ");
  return `<b>№${o.n}</b> ${STATUS[o.status] || ""} · ${escapeHtml(o.name)} ${escapeHtml(o.phone)}${escapeHtml(when)}\n    ${escapeHtml(route || "—")}`;
}

async function sendOpenOrders(env) {
  const open = await getJSON(env, "open", []);
  const orders = (await Promise.all(open.slice(-30).map((n) => getOrder(env, n)))).filter(Boolean);
  const text = orders.length
    ? `📋 <b>Незакрытые заявки: ${orders.length}</b>\n\n` + orders.map(orderLine).join("\n\n")
    : "📋 Незакрытых заявок нет 👌";
  return tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, parse_mode: "HTML", text, link_preview_options: { is_disabled: true } });
}

async function allOrders(env) {
  const last = Number(await env.KV.get("orderSeq") || 0);
  const nums = Array.from({ length: last }, (_, i) => i + 1);
  return (await Promise.all(nums.map((n) => getOrder(env, n)))).filter(Boolean);
}

const CSV_COLS = [
  ["№", (o) => o.n],
  ["Дата", (o) => fmtMsk(o.ts, { day: "2-digit", month: "2-digit", year: "numeric" })],
  ["Время", (o) => fmtMsk(o.ts, { hour: "2-digit", minute: "2-digit" })],
  ["Статус", (o) => (STATUS[o.status] || "").replace(/^\S+\s/, "")],
  ["Имя", (o) => o.name],
  ["Телефон", (o) => o.phone],
  ["Telegram", (o) => o.tg],
  ["Погрузка", (o) => o.from],
  ["Доставка", (o) => o.to],
  ["Когда", (o) => o.when],
  ["Груз", (o) => o.cargo],
  ["Грузчик", (o) => o.loader],
  ["Источник", (o) => sourceLabel(o.source).replace(/^\S+\s/, "")],
  ["Оценка цены, ₽", (o) => o.estimate || ""],
  ["Оценка клиента", (o) => o.rating || ""],
  ["Отзыв", (o) => o.review || ""],
];

export async function ordersCsv(env, bom) {
  const esc = (v) => { const s = String(v == null ? "" : v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [CSV_COLS.map((c) => c[0])];
  for (const o of await allOrders(env)) rows.push(CSV_COLS.map((c) => c[1](o)));
  return (bom ? "﻿" : "") + rows.map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

async function sendExport(env) {
  const csv = await ordersCsv(env, true);
  const count = csv.trim().split("\n").length - 1;
  const date = nowMsk({ day: "2-digit", month: "2-digit", year: "numeric" });
  return tgDocument(env, env.OWNER_CHAT_ID, `zayavki-${date}.csv`, csv, `📊 Все заявки: ${count}. Файл открывается в Excel или Google Таблицах.`);
}

function mskHour(ts = Date.now()) {
  return Number(new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(ts));
}

export async function remindStale(env, now = Date.now()) {
  const h = mskHour(now);
  if (h >= 22 || h < 8) return; // ночью не будим
  const open = await getJSON(env, "open", []);
  for (const n of open) {
    const o = await getOrder(env, n);
    if (!o || o.status !== "new" || o.reminded) continue;
    const mins = Math.round((now - o.ts) / 60000);
    if (mins < REMIND_AFTER_MIN) continue;
    const ago = mins < 90 ? `${mins} мин` : `с ${fmtMsk(o.ts, { hour: "2-digit", minute: "2-digit" })}`;
    await tg(env, "sendMessage", {
      chat_id: env.OWNER_CHAT_ID, parse_mode: "HTML",
      text: `⏰ <b>Заявка №${n} ждёт ответа</b> ${mins < 90 ? "уже " : ""}${ago}. Клиент: ${escapeHtml(o.name)}, ${escapeHtml(o.phone)}`,
      reply_parameters: o.ownerMsgId ? { message_id: o.ownerMsgId, allow_sending_without_reply: true } : undefined,
    });
    o.reminded = true;
    await saveOrder(env, o);
  }
}

export async function dailySummary(env, now = Date.now()) {
  const today = fmtMsk(now, { day: "2-digit", month: "2-digit", year: "numeric" });
  const last = Number(await env.KV.get("orderSeq") || 0);
  const todays = [];
  for (let n = last; n >= 1 && n > last - 200; n--) {
    const o = await getOrder(env, n);
    if (!o) continue;
    if (fmtMsk(o.ts, { day: "2-digit", month: "2-digit", year: "numeric" }) !== today) break;
    todays.push(o);
  }
  const open = await getJSON(env, "open", []);
  const by = (s) => todays.filter((o) => o.status === s).length;
  const rated = todays.filter((o) => o.rating);
  const lines = [`📊 <b>Итоги дня, ${today}</b>`, ""];
  if (todays.length) {
    lines.push(`Новых заявок: <b>${todays.length}</b>`);
    lines.push(`🏁 выполнено: ${by("done")} · ✅ в работе: ${by("acc")} · 🆕 без ответа: ${by("new")} · ❌ отказ: ${by("rej")}`);
    if (rated.length) lines.push(`⭐ средняя оценка: ${(rated.reduce((a, o) => a + o.rating, 0) / rated.length).toFixed(1)}`);
    const srcs = {};
    for (const o of todays) if (o.source) srcs[o.source] = (srcs[o.source] || 0) + 1;
    const s = Object.entries(srcs).map(([k, v]) => `${sourceLabel(k)} — ${v}`);
    if (s.length) lines.push("", "Откуда пришли:", ...s);
  } else {
    lines.push("Сегодня новых заявок не было.");
  }
  lines.push("", `Незакрытых заявок всего: <b>${open.length}</b>${open.length ? " — /orders" : ""}`);
  return tg(env, "sendMessage", { chat_id: env.OWNER_CHAT_ID, parse_mode: "HTML", text: lines.join("\n") });
}

/* ---------------- Helpers ---------------- */

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function verifyInitData(initData, botToken, now = Date.now() / 1000) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
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

const fmtMsk = (ts, opts) => new Date(ts).toLocaleString("ru-RU", { timeZone: TZ, ...opts });
const nowMsk = (opts) => fmtMsk(Date.now(), opts);
const fmtRub = (n) => n.toLocaleString("ru-RU").replace(/ /g, " ") + " ₽";

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
