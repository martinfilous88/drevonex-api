/**
 * DřevoNex – sledování dostupnosti zboží od dodavatele
 *
 * Algoritmus:
 *  1. Každých REFRESH_MIN minut stáhne stránky produktů z jafholz.cz
 *  2. (Volitelně) se předtím přihlásí B2B účtem – dostupnost a ceny
 *     JAF zobrazuje pouze přihlášeným velkoobchodním zákazníkům
 *  3. Z HTML vyparsuje stav skladu + cenu a uloží do cache (paměť + disk)
 *  4. Frontend si data bere z GET /api/stock
 *
 * Konfigurace: server/.env  (viz server/.env.example)
 */
import express from "express";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import nodemailer from "nodemailer";
import Stripe from "stripe";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = process.env.PORT || 3001;
const REFRESH_MIN = Number(process.env.REFRESH_MIN || 30);
const CACHE_FILE = path.join(__dirname, "cache.json");
const PRODUCTS_FILE = path.join(__dirname, "products.json");
const BASE = "https://www.jafholz.cz";
const MAX_PRODUCTS = Number(process.env.MAX_PRODUCTS || 120);
const CONCURRENCY = 3;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* ── SMTP / Email ── */
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = process.env.SMTP_SECURE !== "false";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "";

const COMPANY_NAME = process.env.COMPANY_NAME || "DřevoNex";
const COMPANY_ADDRESS = process.env.COMPANY_ADDRESS || "";
const COMPANY_ICO = process.env.COMPANY_ICO || "";
const COMPANY_DIC = process.env.COMPANY_DIC || "";
const COMPANY_PHONE = process.env.COMPANY_PHONE || "";
const COMPANY_EMAIL = process.env.COMPANY_EMAIL || "";
const COMPANY_BANK = process.env.COMPANY_BANK || "";

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

function mailEnabled() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

/* ── Stripe ── */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
function stripeEnabled() {
  return !!(stripe && STRIPE_SECRET_KEY && !STRIPE_SECRET_KEY.includes("..."));
}

/* ── Cílové kategorie – pouze stavební řezivo, hranoly, BSH, konstrukční prvky ── */
/* ── Statické OSB desky (pevné rozměry, vždy skladem) ── */
const STATIC_OSB = [
  { id: "osb-kron-n9",  name: "OSB 3 Kronospan P+D nebroušené 2500×1250×9 mm",  category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-kron-n10", name: "OSB 3 Kronospan P+D nebroušené 2500×1250×10 mm", category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-kron-n12", name: "OSB 3 Kronospan P+D nebroušené 2500×1250×12 mm", category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-kron-n15", name: "OSB 3 Kronospan P+D nebroušené 2500×1250×15 mm", category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-kron-n18", name: "OSB 3 Kronospan P+D nebroušené 2500×1250×18 mm", category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-kron-n22", name: "OSB 3 Kronospan P+D nebroušené 2500×1250×22 mm", category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-kron-b10", name: "OSB 3 Kronospan P+D broušené 2500×1250×10 mm",   category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-kron-b12", name: "OSB 3 Kronospan P+D broušené 2500×1250×12 mm",   category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-kron-b15", name: "OSB 3 Kronospan P+D broušené 2500×1250×15 mm",   category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-kron-b18", name: "OSB 3 Kronospan P+D broušené 2500×1250×18 mm",   category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-kron-b22", name: "OSB 3 Kronospan P+D broušené 2500×1250×22 mm",   category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-egger-10", name: "OSB 3 Egger P+D 2500×1250×10 mm",                category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-egger-12", name: "OSB 3 Egger P+D 2500×1250×12 mm",                category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-egger-15", name: "OSB 3 Egger P+D 2500×1250×15 mm",                category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-egger-18", name: "OSB 3 Egger P+D 2500×1250×18 mm",                category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-egger-22", name: "OSB 3 Egger P+D 2500×1250×22 mm",                category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb4-kron-12", name: "OSB 4 Kronospan P+D 2500×1250×12 mm",            category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb4-kron-15", name: "OSB 4 Kronospan P+D 2500×1250×15 mm",            category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb4-kron-18", name: "OSB 4 Kronospan P+D 2500×1250×18 mm",            category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb4-kron-22", name: "OSB 4 Kronospan P+D 2500×1250×22 mm",            category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-profi-9",  name: "OSB 3 Kronospan P+D nebroušené 2800×1250×9 mm",  category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-profi-12", name: "OSB 3 Kronospan P+D nebroušené 2800×1250×12 mm", category: "OSB desky", availability: "in_stock", priceRaw: 0 },
  { id: "osb-profi-18", name: "OSB 3 Kronospan P+D nebroušené 2800×1250×18 mm", category: "OSB desky", availability: "in_stock", priceRaw: 0 },
].map((p) => ({ ...p, price: "Cena na dotaz", image: null, mpn: null, checkedAt: new Date().toISOString() }));

const TARGET_CATEGORIES = [
  "https://www.jafholz.cz/shop/materialy-pro-drevostavby/stavebni-rezivo~c829359",         // Stavební řezivo
  "https://www.jafholz.cz/shop/materialy-pro-drevostavby/kvh-masivni-konstrukcni-hranoly~c829361", // KVH hranoly
  "https://www.jafholz.cz/shop/materialy-pro-drevostavby/duotrio-drevene-hranoly~c829378",   // DUO/TRIO hranoly
  "https://www.jafholz.cz/shop/materialy-pro-drevostavby/bsh-lepene-vrstvene-hranoly~c829414", // BSH nosníky
  "https://www.jafholz.cz/shop/materialy-pro-drevostavby/drevene-konstrukcni-prvky~c6804272", // Dřevěné konstrukční prvky (LVL, I-trámy)
  "https://www.jafholz.cz/shop/plosne-materialy/osb-desky~c14208428", // OSB desky
];

/* ── Jednoduchý cookie jar pro udržení přihlášení ── */
const jar = new Map();
function storeCookies(res) {
  const set = res.headers.getSetCookie?.() || [];
  for (const c of set) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function jfetch(url, opts = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    ...opts,
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Cache-Control": "max-age=0",
      Cookie: cookieHeader(),
      ...(opts.headers || {}),
    },
  });
  storeCookies(res);
  return res;
}

/* ── Přihlášení do JAF Online-Shopu (volitelné) ── */
let loggedIn = false;
async function login() {
  const email = process.env.JAF_EMAIL;
  const password = process.env.JAF_PASSWORD;
  if (!email || !password) {
    console.log("[jaf] JAF_EMAIL/JAF_PASSWORD nenastaveno – běžím bez přihlášení (dostupnost bude omezená)");
    return false;
  }
  try {
    // 1) načíst přihlašovací stránku kvůli session cookies + skrytým polím formuláře
            // 0) nejdřív navštívit homepage
    const home = await jfetch("https://www.jafholz.cz/");
    await home.text();
    console.log("[jaf] homepage navštíveno");
    await sleep(800);

    // 1) načíst přihlašovací stránku
    const page = await jfetch("https://www.jafholz.cz/login/login");
    const html = await page.text();
    console.log(`[jaf] login page status: ${page.status}, length: ${html.length}`);
    if (html.length < 5000) {
      console.log(`[jaf] login page snippet: ${html.substring(0, 500)}`);
    }
    const $ = cheerio.load(html);
    const form = $("form").filter((_, f) => $(f).find("input[type='password']").length > 0).first();
    if (!form.length) {
      const allForms = $("form").length;
      console.warn(`[jaf] forms found: ${allForms}, password inputs: ${$("input[type='password']").length}`);
      throw new Error("přihlašovací formulář nenalezen");
    }

    const action = new URL(form.attr("action") || "/login/login", "https://www.jafholz.cz").href;
    const body = new URLSearchParams();
    form.find("input").each((_, inp) => {
      const n = $(inp).attr("name");
      if (!n) return;
      const type = ($(inp).attr("type") || "").toLowerCase();
      if (type === "password") body.set(n, password);
      else if (type === "email" || /mail|user|login/i.test(n)) body.set(n, email);
      else body.set(n, $(inp).attr("value") || "");
    });

    // 2) odeslat formulář
    const res = await jfetch(action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const after = await res.text();
    loggedIn = !/type=['"]password['"]/i.test(after);
    console.log(`[jaf] přihlášení: ${loggedIn ? "OK" : "NEÚSPĚŠNÉ (zkontrolujte údaje v server/.env)"}`);
    return loggedIn;
  } catch (e) {
    console.warn("[jaf] přihlášení selhalo:", e.message);
    return false;
  }
}

/* ── Parsování dostupnosti a ceny z detailu produktu ──
 * Zdroje dat ve veřejném HTML (ověřeno):
 *  1. window.dataLayer (GTM ecommerce) – obsahuje "price":17765 i bez přihlášení
 *  2. JSON-LD <script type="application/ld+json"> – název, obrázek, kat. číslo (mpn)
 *  3. text stránky – klíčová slova dostupnosti („dostupné", „skladem", …)
 */
function parseProduct(html) {
  const $ = cheerio.load(html);
  const text = $("body").text().replace(/\s+/g, " ");

  // 1) cena z dataLayeru – první číselný výskyt "price"
  let price = null;
  let priceRaw = null;
  const pm = html.match(/"price":"?(\d+(?:\.\d+)?)"?/);
  if (pm) {
    priceRaw = parseFloat(pm[1]);
    price = priceRaw.toLocaleString("cs-CZ", { maximumFractionDigits: 0 }) + " Kč";
  }
  // záloha: cena přímo v textu stránky
  if (!price) {
    const tm = text.match(/(\d[\d\s]{0,9}(?:,\d{1,2})?)\s*(?:Kč|CZK)/i);
    if (tm) price = tm[1].replace(/\s/g, "") + " Kč";
  }

  // 2) JSON-LD – metadata produktu
  let title = null;
  let image = null;
  let mpn = null;
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      if (data["@type"] === "Product") {
        title = data.name || title;
        image = data.image || image;
        mpn = data.mpn || mpn;
      }
    } catch {
      /* nevalidní JSON-LD přeskočíme */
    }
  });
  if (!title) title = $("h1").first().text().trim() || null;

  // 3) dostupnost – heuristika podle klíčových slov
  let availability = "unknown";
  let availabilityText = null;
  const rules = [
    [/není\s+skladem|vyprodáno|nedostupn/i, "out_of_stock"],
    [/skladem|ihned\s+k\s+odběru|dostupné/i, "in_stock"],
    [/na\s+objednávku|na\s+dotaz|do\s+\d+\s+dn/i, "on_order"],
  ];
  for (const [re, status] of rules) {
    const mm = text.match(re);
    if (mm) {
      availability = status;
      availabilityText = mm[0].trim();
      break;
    }
  }
  // máme-li cenu, produkt je v nabídce, i když klíčová slova chybí
  if (availability === "unknown" && price) availability = "on_order";
  // pokud stránka vyžaduje přihlášení a nic jsme nenašli
  if (availability === "unknown" && /registrovaný zákazník|Přihlásit se/i.test(text)) {
    availability = "login_required";
  }

  return { title, availability, availabilityText, price, priceRaw, image, mpn };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Crawler: projde jen cílové kategorie a jejich přímé podkategorie ── */
async function discoverProducts() {
  const seenCats = new Set();
  const queue = [...TARGET_CATEGORIES];
  const products = new Map(); // pId -> { id, name, url, category }
  const KEYWORDS = /\b(trám|fošna|krokev|lať|lata|nosník|hran|bsh|kvh|duo|trio|lvl|i[ -]?nosník|rezivo|osb)\b/i;
  const BLACKLIST = /|panel|palubka|obklad|hoblovan|přísluš|spojka|kotva|vrut|hřeb|závit|prkno|podlaha|stěna|plot|pero|drážka|lišta|rámus|stojina|základ|schrán|bedně|izolac|foli|křiž|kryt|těsněn|hmož|šroub|laťovka|dýha|truhl/i;

  while (queue.length && products.size < MAX_PRODUCTS) {
    const catUrl = queue.shift();
    const catKey = catUrl.match(/~c(\d+)/)?.[1] || catUrl;
    if (seenCats.has(catKey)) continue;
    seenCats.add(catKey);

    try {
      const res = await jfetch(catUrl);
      const html = await res.text();
      const $ = cheerio.load(html);
      const catName = $("h1").first().text().trim() || catKey;
      console.log(`[jaf] kategorie: ${catName}`);

      $("a[href]").each((_, a) => {
        const href = $(a).attr("href");
        if (!href || !href.startsWith("/shop")) return;
        const abs = new URL(href, BASE).href.split("?")[0];

        // podkategorie – přidáme jen pokud název odpovídá řezivu
        const cm = abs.match(/~c(\d+)/);
        if (cm && !seenCats.has(cm[1]) && !queue.includes(abs)) {
          const subName = $(a).text().replace(/\s+/g, " ").trim();
          if (KEYWORDS.test(subName) && !BLACKLIST.test(subName)) {
            queue.push(abs);
          }
          return;
        }
        // produkt – uložíme jen pokud název obsahuje klíčová slova
        const pm = abs.match(/~p(\d+)/);
        if (pm && !products.has(pm[1]) && products.size < MAX_PRODUCTS) {
          const name = $(a).text().replace(/\s+/g, " ").trim();
         if (KEYWORDS.test(name) && !BLACKLIST.test(name)) {
            products.set(pm[1], {
              id: `p${pm[1]}`,
              name: name,
              url: abs,
              category: catName,
            });
          }
        }
      });
    } catch (e) {
      console.warn(`[jaf] kategorie ${catUrl}: CHYBA – ${e.message}`);
    }
    await sleep(600);
  }

  const list = [...products.values()];
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(list, null, 2));
  console.log(`[jaf] objeveno ${list.length} produktů v ${seenCats.size} kategoriích`);
  return list;
}

/* ── Hlavní smyčka aktualizace ── */
let cache = { updatedAt: null, loggedIn: false, items: [] };
let productList = [];
try {
  try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  console.log("[jaf] cache načtena z disku");
  const existingIds = new Set(cache.items.map((i) => i.id));
  const missingOsb = STATIC_OSB.filter((p) => !existingIds.has(p.id));
  if (missingOsb.length) {
    cache.items.push(...missingOsb);
    cache.total = cache.items.length;
    console.log(`[jaf] přidáno ${missingOsb.length} statických OSB do cache`);
  }
} catch {
  /* první spuštění */
}
try {
  productList = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
  console.log(`[jaf] seznam ${productList.length} produktů načten z disku`);
} catch {
  /* první spuštění */
}

async function scrapeOne(p) {
  try {
    const res = await jfetch(p.url);
    const html = await res.text();
    const parsed = parseProduct(html);
    return { ...p, ...parsed, error: null, checkedAt: new Date().toISOString() };
  } catch (e) {
    const prev = cache.items.find((i) => i.id === p.id);
    return prev ? { ...prev, error: e.message } : { ...p, availability: "unknown", error: e.message };
  }
}

let refreshing = false;
async function refreshAll({ rediscover = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  console.log("[jaf] aktualizuji dostupnost…");
  if (!loggedIn) await login();

  if (rediscover || productList.length === 0) {
    productList = await discoverProducts();
  }

  const items = [];
  let done = 0;
  // zpracování po dávkách (šetrné k JAF serveru)
  for (let i = 0; i < productList.length; i += CONCURRENCY) {
    const batch = productList.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(scrapeOne));
    items.push(...results);
    done += batch.length;
    if (done % 30 < CONCURRENCY) console.log(`[jaf]  …${done}/${productList.length}`);
    // průběžně ukládáme, aby API mělo data i během dlouhého běhu
    cache = { updatedAt: new Date().toISOString(), loggedIn, total: productList.length, items: [...items] };
    await sleep(700);
  }

    const allItems = [...items, ...STATIC_OSB];
  cache = { updatedAt: new Date().toISOString(), loggedIn, total: allItems.length, items: allItems };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  refreshing = false;
  console.log(`[jaf] hotovo – ${items.length} produktů + ${STATIC_OSB.length} OSB`);
}

/* ── API ── */
const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

app.get("/api/stock", (_, res) => res.json(cache));

app.get("/api/stock/refresh", (_, res) => {
  refreshAll(); // běží na pozadí, průběžné výsledky jsou hned v /api/stock
  res.json({ started: true, refreshing: true });
});

app.get("/api/stock/rediscover", (_, res) => {
  refreshAll({ rediscover: true });
  res.json({ started: true, rediscover: true });
});

/* ── Orders ── */
const ORDERS_FILE = path.join(__dirname, "orders.json");
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")); } catch { return []; }
}
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function fmtCZK(n) {
  return (n || 0).toLocaleString("cs-CZ") + " Kč";
}

function invoiceHTML(order, user) {
  const now = new Date();
  const due = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 dní splatnost
  const itemsRows = order.items.map((it) => {
    const qty = it.qty || 1;
    const unit = it.priceRaw || 0;
    const line = unit * qty;
    return `<tr>
      <td style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.08);">${it.name}</td>
      <td style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.08);text-align:center;">${qty}</td>
      <td style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.08);text-align:right;">${fmtCZK(unit)}</td>
      <td style="padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.08);text-align:right;">${fmtCZK(line)}</td>
    </tr>`;
  }).join("");

  const subtotal = order.totalBeforeDiscount ?? order.total;
  const discount = subtotal - order.total;
  const vat = Math.round(order.total * 0.21);

  return `<!DOCTYPE html>
<html lang="cs">
<head><meta charset="UTF-8"><title>Faktura ${order.invoiceNumber}</title></head>
<body style="font-family:Inter,Helvetica,Arial,sans-serif;color:#333;max-width:800px;margin:0 auto;padding:32px 24px;">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;">
    <div>
      <h1 style="margin:0 0 4px;font-size:24px;color:#B8860B;">${COMPANY_NAME}</h1>
      <p style="margin:0;font-size:12px;color:#666;">${COMPANY_ADDRESS.replace(/,/g, "<br>")}</p>
      <p style="margin:4px 0 0;font-size:12px;color:#666;">IČO: ${COMPANY_ICO} | DIČ: ${COMPANY_DIC}</p>
    </div>
    <div style="text-align:right;">
      <h2 style="margin:0 0 4px;font-size:20px;color:#B8860B;">FAKTURA</h2>
      <p style="margin:0;font-size:14px;font-weight:600;">č. ${order.invoiceNumber}</p>
      <p style="margin:4px 0 0;font-size:12px;color:#666;">Datum vystavení: ${now.toLocaleDateString("cs-CZ")}</p>
      <p style="margin:0;font-size:12px;color:#666;">Splatnost: ${due.toLocaleDateString("cs-CZ")}</p>
    </div>
  </div>

  <div style="margin-bottom:24px;padding:16px;background:#f9f8f6;border-radius:8px;">
    <p style="margin:0 0 4px;font-weight:600;">Odběratel:</p>
    <p style="margin:0;font-size:14px;">${order.customer.name}</p>
    ${order.customer.company ? `<p style="margin:0;font-size:14px;">${order.customer.company}</p>` : ""}
    <p style="margin:0;font-size:12px;color:#666;">${order.customer.email} | ${order.customer.phone}</p>
    ${order.customer.address ? `<p style="margin:0;font-size:12px;color:#666;">${order.customer.address}, ${order.customer.city || ""} ${order.customer.zip || ""}</p>` : ""}
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px;">
    <thead>
      <tr style="border-bottom:2px solid #B8860B;">
        <th style="text-align:left;padding:8px 0;">Položka</th>
        <th style="text-align:center;padding:8px 0;">Množ.</th>
        <th style="text-align:right;padding:8px 0;">Jedn. cena</th>
        <th style="text-align:right;padding:8px 0;">Celkem</th>
      </tr>
    </thead>
    <tbody>${itemsRows}</tbody>
  </table>

  <div style="text-align:right;margin-bottom:24px;">
    ${discount > 0 ? `<p style="margin:0 0 4px;font-size:13px;color:#5E9E6A;">Sleva: −${fmtCZK(discount)}</p>` : ""}
    <p style="margin:0 0 4px;font-size:13px;color:#666;">Mezisoučet: ${fmtCZK(order.total)}</p>
    <p style="margin:0 0 4px;font-size:13px;color:#666;">DPH 21 %: ${fmtCZK(vat)}</p>
    <p style="margin:0;font-size:18px;font-weight:700;color:#B8860B;">CELKEM K ÚHRADĚ: ${fmtCZK(order.total + vat)}</p>
  </div>

  <div style="border-top:1px solid rgba(0,0,0,0.1);padding-top:16px;font-size:12px;color:#666;">
    <p style="margin:0 0 4px;"><strong>Platební údaje:</strong></p>
    <p style="margin:0;">Bankovní účet: ${COMPANY_BANK}</p>
    <p style="margin:0;">Variabilní symbol: ${order.invoiceNumber.replace(/\D/g, "")}</p>
    <p style="margin:8px 0 0;font-size:11px;color:#999;">Fakturu vystavil ${COMPANY_NAME} | ${COMPANY_PHONE} | ${COMPANY_EMAIL}</p>
  </div>
</body>
</html>`;
}

app.post("/api/order", async (req, res) => {
  // ověření uživatele
  const user = userFromToken(req);
  if (!user) {
    return res.status(401).json({ error: "Pro objednání se musíte přihlásit." });
  }

  const { items, total, totalBeforeDiscount, discountRate, customer } = req.body;
  if (!items || !items.length || !customer?.name || !customer?.email || !customer?.phone) {
    return res.status(400).json({ error: "Vyplňte jméno, email a telefon." });
  }

  const invoiceNumber = "FV-" + Date.now();
  const order = {
    id: "ORD-" + Date.now(),
    invoiceNumber,
    createdAt: new Date().toISOString(),
    items,
    total: total || 0,
    totalBeforeDiscount: totalBeforeDiscount || total,
    discountRate: discountRate || 0,
    customer,
    userId: user.id,
    userEmail: user.email,
    userName: user.name,
    status: "new",
  };

  const orders = loadOrders();
  orders.unshift(order);
  saveOrders(orders);

  // uložení faktury jako HTML
  const invoicePath = path.join(__dirname, "invoices", `${invoiceNumber}.html`);
  fs.mkdirSync(path.dirname(invoicePath), { recursive: true });
  fs.writeFileSync(invoicePath, invoiceHTML(order, user));

  console.log(`[order] #${order.id} — ${customer.name}, ${total} Kč, ${items.length} items`);
  console.log(`[invoice] ulozena: ${invoicePath}`);

  if (!mailEnabled()) {
    console.log("[mail] SMTP neni nastaveno — emaily se neodesilaji. Faktura ulozena lokalne.");
  }

  // emailové notifikace
  if (mailEnabled()) {
    try {
      // 1) zákazníkovi — potvrzení objednávky + faktura
      await transporter.sendMail({
        from: `"${COMPANY_NAME}" <${SMTP_USER}>`,
        to: customer.email,
        subject: `Potvrzení objednávky ${order.id} — ${COMPANY_NAME}`,
        html: `<p>Dobrý den ${customer.name},</p>
          <p>Děkujeme za objednávku. Číslo objednávky: <strong>${order.id}</strong></p>
          <p>Celkem: <strong>${fmtCZK(total)} bez DPH</strong> / ${fmtCZK(total + Math.round(total * 0.21))} s DPH</p>
          <p>Fakturu najdete v příloze.</p>
          <p style="margin-top:16px;color:#666;font-size:12px;">V případě dotazů nás kontaktujte: ${COMPANY_PHONE} | ${COMPANY_EMAIL}</p>`,
        attachments: [
          { filename: `${invoiceNumber}.html`, path: invoicePath, contentType: "text/html" },
        ],
      });
      // 2) vlastníkovi — oznámení o objednávce
      if (OWNER_EMAIL && OWNER_EMAIL !== customer.email) {
        await transporter.sendMail({
          from: `"${COMPANY_NAME}" <${SMTP_USER}>`,
          to: OWNER_EMAIL,
          subject: `Nová objednávka ${order.id} — ${customer.name}`,
          html: `<p>Nová objednávka:</p>
            <ul>
              <li><strong>Zákazník:</strong> ${customer.name}${customer.company ? " (" + customer.company + ")" : ""}</li>
              <li><strong>Email:</strong> ${customer.email}</li>
              <li><strong>Telefon:</strong> ${customer.phone}</li>
              <li><strong>Celkem bez DPH:</strong> ${fmtCZK(total)}</li>
              <li><strong>Položky:</strong> ${items.length}</li>
            </ul>
            <p>Faktura: ${invoiceNumber}.html</p>`,
        });
      }
      console.log(`[mail] odesláno ${customer.email} + ${OWNER_EMAIL || "nikomu"}`);
    } catch (e) {
      console.error("[mail] chyba:", e.message);
    }
  }

  res.json({ success: true, orderId: order.id, invoiceNumber });
});

app.get("/api/orders", (_, res) => {
  res.json(loadOrders());
});

/* ── Uživatelé / autentizace ── */
const USERS_FILE = path.join(__dirname, "users.json");
const COMPANY_DISCOUNT = Number(process.env.COMPANY_DISCOUNT || 0.05); // 5 % pro firmy
const PROMO_LIMIT = Number(process.env.PROMO_LIMIT || 20); // prvních 20 registrovaných
const PROMO_DISCOUNT = Number(process.env.PROMO_DISCOUNT || 0.05); // 5 % uvítací sleva
const sessions = new Map(); // token -> userId

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { return []; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
}
function publicUser(u) {
  // Sleva: firmy maji vzdy COMPANY_DISCOUNT, prvni 20 firem ma flag isPromo
  const isPromo = !!u.isCompany && !!u.regNumber && u.regNumber <= PROMO_LIMIT;
  const discountRate = u.isCompany ? COMPANY_DISCOUNT : 0;
  const discountLabel = u.isCompany ? "Firemní sleva" : null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    isCompany: u.isCompany,
    company: u.company || null,
    ico: u.ico || null,
    regNumber: u.regNumber || null,
    isPromo,
    discountRate,
    discountLabel,
  };
}
function userFromToken(req) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const userId = sessions.get(token);
  if (!userId) return null;
  return loadUsers().find((u) => u.id === userId) || null;
}

app.post("/api/auth/register", (req, res) => {
  const { name, email, password, isCompany, company, ico } = req.body || {};
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: "Vyplňte jméno, email a heslo (min. 6 znaků)." });
  }
  if (isCompany && (!company || !ico)) {
    return res.status(400).json({ error: "Pro firemní účet vyplňte název firmy a IČO." });
  }
  const users = loadUsers();
  if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: "Uživatel s tímto emailem už existuje." });
  }
  const regNumber = users.length + 1;
  const user = {
    id: "U-" + Date.now(),
    regNumber,
    name,
    email,
    passwordHash: hashPassword(password),
    isCompany: !!isCompany,
    company: isCompany ? company : null,
    ico: isCompany ? ico : null,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, user.id);
  const promoNote = regNumber <= PROMO_LIMIT ? ` [PROMO #${regNumber}/${PROMO_LIMIT}]` : "";
  console.log(`[auth] registrace: ${email}${isCompany ? " (firma " + ico + ")" : ""}${promoNote}`);
  res.json({ token, user: publicUser(user) });
});

app.get("/api/auth/promo", (_, res) => {
  const used = loadUsers().length;
  res.json({
    limit: PROMO_LIMIT,
    used,
    remaining: Math.max(0, PROMO_LIMIT - used),
    discount: PROMO_DISCOUNT,
    active: used < PROMO_LIMIT,
  });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const users = loadUsers();
  const user = users.find((u) => u.email.toLowerCase() === (email || "").toLowerCase());
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Nesprávný email nebo heslo." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, user.id);
  console.log(`[auth] přihlášení: ${email}`);
  res.json({ token, user: publicUser(user) });
});

app.get("/api/auth/me", (req, res) => {
  const user = userFromToken(req);
  if (!user) return res.status(401).json({ error: "Nepřihlášen." });
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  sessions.delete(token);
  res.json({ success: true });
});

/* ── Stripe Checkout ── */
app.post("/api/create-checkout-session", async (req, res) => {
  if (!stripeEnabled()) {
    return res.status(503).json({ error: "Platební brána není nastavena. Kontaktujte podporu." });
  }

  const user = userFromToken(req);
  if (!user) {
    return res.status(401).json({ error: "Pro placení se musíte přihlásit." });
  }

  const { items, total, totalBeforeDiscount, discountRate, customer } = req.body || {};
  if (!items || !items.length) {
    return res.status(400).json({ error: "Košík je prázdný." });
  }

  const invoiceNumber = "FV-" + Date.now();
  const orderId = "ORD-" + Date.now();

  // Uložíme pending order
  const order = {
    id: orderId,
    invoiceNumber,
    createdAt: new Date().toISOString(),
    items,
    total: total || 0,
    totalBeforeDiscount: totalBeforeDiscount || total,
    discountRate: discountRate || 0,
    customer: customer || {},
    userId: user.id,
    userEmail: user.email,
    userName: user.name,
    status: "pending",
  };
  const orders = loadOrders();
  orders.unshift(order);
  saveOrders(orders);

  const lineItems = items.map((it) => {
    const unitAmount = Math.round((it.priceRaw || 0) * 100); // haléře
    return {
      price_data: {
        currency: "czk",
        product_data: {
          name: it.name,
          images: it.image ? [it.image] : [],
        },
        unit_amount: unitAmount,
      },
      quantity: it.qty || 1,
    };
  });

  // Sleva jako kupón (pokud je)
  let discounts = [];
  if (discountRate > 0 && totalBeforeDiscount > total) {
    const coupon = await stripe.coupons.create({
      percent_off: Math.round(discountRate * 100),
      duration: "once",
    });
    discounts.push({ coupon: coupon.id });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      discounts,
      mode: "payment",
      locale: "cs",
      submit_type: "pay",
      success_url: `${FRONTEND_URL}/#/checkout-success?session_id={CHECKOUT_SESSION_ID}&order=${orderId}`,
      cancel_url: `${FRONTEND_URL}/#/checkout`,
      customer_email: customer?.email || user.email,
      metadata: { orderId, userId: String(user.id) },
      invoice_creation: { enabled: true },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("[stripe] create session error:", e.message);
    res.status(500).json({ error: "Nepodařilo se vytvořit platební relaci." });
  }
});

app.get("/api/verify-payment", async (req, res) => {
  if (!stripeEnabled()) {
    return res.status(503).json({ error: "Stripe není nastaveno." });
  }
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "Chybí session_id." });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== "paid") {
      return res.json({ paid: false, status: session.payment_status });
    }

    const orderId = session.metadata?.orderId;
    if (!orderId) return res.status(400).json({ error: "Neplatná relace." });

    const orders = loadOrders();
    const order = orders.find((o) => o.id === orderId);
    if (!order) return res.status(404).json({ error: "Objednávka nenalezena." });

    if (order.status === "pending") {
      order.status = "paid";
      order.paidAt = new Date().toISOString();
      order.stripeSessionId = session_id;
      saveOrders(orders);

      // Faktura
      const invoicePath = path.join(__dirname, "invoices", `${order.invoiceNumber}.html`);
      fs.mkdirSync(path.dirname(invoicePath), { recursive: true });
      fs.writeFileSync(invoicePath, invoiceHTML(order, { name: order.userName, email: order.userEmail }));

      console.log(`[stripe] zaplaceno #${order.id}`);

      // Emaily
      if (mailEnabled()) {
        try {
          await transporter.sendMail({
            from: `"${COMPANY_NAME}" <${SMTP_USER}>`,
            to: order.customer.email,
            subject: `Potvrzení platby ${order.id} — ${COMPANY_NAME}`,
            html: `<p>Dobrý den ${order.customer.name},</p>
              <p>Vaše platba byla úspěšně přijata. Číslo objednávky: <strong>${order.id}</strong></p>
              <p>Celkem zaplaceno: <strong>${fmtCZK(order.total)} bez DPH</strong> / ${fmtCZK(order.total + Math.round(order.total * 0.21))} s DPH</p>
              <p>Fakturu najdete v příloze.</p>
              <p style="margin-top:16px;color:#666;font-size:12px;">V případě dotazů: ${COMPANY_PHONE} | ${COMPANY_EMAIL}</p>`,
            attachments: [
              { filename: `${order.invoiceNumber}.html`, path: invoicePath, contentType: "text/html" },
            ],
          });
          if (OWNER_EMAIL && OWNER_EMAIL !== order.customer.email) {
            await transporter.sendMail({
              from: `"${COMPANY_NAME}" <${SMTP_USER}>`,
              to: OWNER_EMAIL,
              subject: `Platba přijata ${order.id} — ${order.customer.name}`,
              html: `<p>Objednávka zaplacena:</p>
                <ul>
                  <li><strong>Zákazník:</strong> ${order.customer.name}${order.customer.company ? " (" + order.customer.company + ")" : ""}</li>
                  <li><strong>Email:</strong> ${order.customer.email}</li>
                  <li><strong>Celkem bez DPH:</strong> ${fmtCZK(order.total)}</li>
                </ul>`,
            });
          }
          console.log(`[mail] odesláno ${order.customer.email} + ${OWNER_EMAIL || "nikomu"}`);
        } catch (e) {
          console.error("[mail] chyba:", e.message);
        }
      }
    }

    res.json({ paid: true, orderId: order.id, invoiceNumber: order.invoiceNumber });
  } catch (e) {
    console.error("[stripe] verify error:", e.message);
    res.status(500).json({ error: "Chyba ověření platby." });
  }
});

app.listen(PORT, () => {
  console.log(`[jaf] stock API běží na http://localhost:${PORT}/api/stock`);
  refreshAll();
  setInterval(refreshAll, REFRESH_MIN * 60 * 1000);
});
