// One Lambda serves everything:
//   GET  /        -> order form (only shows delivery dates whose week is still open)
//   POST /        -> place an order
//   GET  /orders  -> order list for your friend (password page until signed in)
//   POST /orders  -> sign in with the admin password (sets a cookie), sign out, or mark delivered
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

const ORDERS_TABLE = process.env.ORDERS_TABLE;
const COUNTS_TABLE = process.env.COUNTS_TABLE;
const ATTEMPTS_TABLE = process.env.ATTEMPTS_TABLE;
// Orders (names, phones, addresses) are deleted automatically this many days after delivery.
const RETENTION_DAYS = Number(process.env.ORDER_RETENTION_DAYS ?? 30);
// { "2026-12-06": { "dates": ["2026-12-06","2026-12-07","2026-12-08"], "limit": 12 }, ... }
// Keyed by the window's first delivery date. "limit" is the number of boxes for the
// whole week; every date in the week draws from it.
const WINDOWS = JSON.parse(process.env.DELIVERY_WINDOWS || "{}");
const CUTOFF_DAYS = Number(process.env.ORDER_CUTOFF_DAYS ?? 3);
const ADMIN_KEY_PARAM = process.env.ADMIN_KEY_PARAM; // SSM parameter name holding the /orders password
const TZ = process.env.TIMEZONE || "America/Chicago";
const SHOP = process.env.SHOP_NAME || "Operation: Bake It Off";

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD

const prettyDate = (d) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });

// YYYY-MM-DD minus n days
const minusDays = (d, n) => {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
};

// Orders for a window are accepted through the end of its cutoff day (local time).
const cutoffFor = (windowId) => minusDays(WINDOWS[windowId].dates[0], CUTOFF_DAYS);

// delivery date -> window id
const DATE_TO_WINDOW = Object.fromEntries(
  Object.entries(WINDOWS).flatMap(([id, w]) => w.dates.map((d) => [d, id]))
);

// Delivery locations. "home" asks for an address.
const LOCATIONS = {
  home: "Home delivery",
  pelham: "Pelham Civic Center",
  kingwood: "Kingwood",
};
const CONTACT_PREFS = { call: "Call", text: "Text" };

// Keep digits; accept 10 digits or 11 starting with 1. Returns (205) 555-1234 or ""
// if it can't be a real US number: area code and exchange can't start with 0 or 1,
// and the area code can't be a service code like 911.
function formatPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (!/^[2-9]\d\d[2-9]\d{6}$/.test(d) || /^[2-9]11/.test(d)) return "";
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

const fullName = (o) => o.firstName ? `${o.firstName} ${o.lastName}` : o.name || "";

// Sent with every response. CSP and SECURITY_HEADERS are defined near the bottom of
// the file, once the page scripts they hash exist.
const html = (statusCode, body) => ({
  statusCode,
  headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
  body,
});

const sha256 = (s) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

// Fonts bundled in the zip and served by this Lambda (see FONTS near the bottom).
// Dancing Script: SIL Open Font License, see lambda/fonts/OFL.txt.
const FONT_URL = "/fonts/dancing-script-v1.woff2"; // bump v1 if the file ever changes (it's cached for a year)

// "Recipe card" look. Static so its hash can go in the CSP. Don't put ${...} values in here.
const CSS = `
  @font-face{font-family:"Dancing Script";src:url("/fonts/dancing-script-v1.woff2") format("woff2");font-weight:400 700;font-style:normal;font-display:swap}
  /* Colors from the Operation: Bake It Off flyer */
  :root{--crimson:#a3293a;--crimson-dark:#82202e;--black:#0d0d0d;--gold:#e3b94a;--cream:#fbf4c4;--paper:#fffdf3;--brown:#6b4a33;--ink:#1d1a17;
    --rule:rgba(107,74,51,.16);--hand:"Dancing Script",cursive;
    --body:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
  *{box-sizing:border-box}
  html,body{margin:0}
  /* gingham tablecloth: two translucent crimson stripe layers crossing */
  body{min-height:100vh;overflow-x:hidden;font-family:var(--body);color:var(--ink);line-height:1.4;background-color:#fff8f2;
    background-image:repeating-linear-gradient(0deg,rgba(163,41,58,.42) 0 22px,transparent 22px 44px),repeating-linear-gradient(90deg,rgba(163,41,58,.42) 0 22px,transparent 22px 44px);
    padding:44px 16px 56px}

  /* the index card, with cream sheets peeking out behind it */
  .stack{position:relative;max-width:560px;margin:0 auto}
  .stack.wide{max-width:1000px}
  .stack::before,.stack::after{content:"";position:absolute;inset:6px 4px;border-radius:6px;box-shadow:0 8px 18px rgba(29,26,23,.22)}
  .stack::before{background:var(--cream);transform:rotate(2.6deg)}
  .stack::after{background:#f3e6b0;transform:rotate(-1.8deg)}
  .card{position:relative;z-index:1;background-color:var(--paper);background-image:repeating-linear-gradient(180deg,transparent 0 31px,var(--rule) 31px 32px);
    border-radius:6px;padding:34px 22px 28px;box-shadow:0 1px 0 rgba(0,0,0,.06),0 14px 28px rgba(29,26,23,.28),0 4px 8px rgba(29,26,23,.18)}
  /* washi tape */
  .card::before{content:"";position:absolute;top:-16px;left:50%;width:150px;height:34px;margin-left:-75px;transform:rotate(-3deg);
    background-color:rgba(227,185,74,.82);background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.35) 0 6px,transparent 6px 12px);
    box-shadow:0 1px 3px rgba(0,0,0,.18);clip-path:polygon(3% 0,97% 4%,100% 50%,96% 100%,2% 96%,0 50%)}

  .head{text-align:center;position:relative;margin:0 -22px;padding:0 22px 14px;border-bottom:2px solid rgba(163,41,58,.55)}
  .kicker{font-family:var(--hand);color:var(--brown);font-size:19px;margin:0 0 2px}
  h1{font-family:var(--hand);font-weight:700;color:var(--crimson);font-size:38px;line-height:1.02;margin:0;letter-spacing:.5px;text-shadow:2px 2px 0 var(--gold)}
  h1 a{color:inherit;text-decoration:none}
  h1 span{color:var(--ink);text-shadow:2px 2px 0 rgba(227,185,74,.7)}
  .cookie{position:absolute}
  .cookie-a{top:-12px;right:8px;width:54px;height:54px;transform:rotate(14deg)}
  .cookie-b{top:40px;left:10px;width:40px;height:40px;transform:rotate(-20deg)}
  .tagline{font-family:var(--hand);color:var(--crimson-dark);text-align:center;font-size:19px;margin:22px 0 18px}

  h2{font-family:var(--hand);font-weight:700;color:var(--crimson);font-size:32px;line-height:1.1;margin:22px 0 12px}
  h3{color:var(--brown);font-size:17px;margin:22px 0 8px}
  a{color:var(--crimson)}
  .msg{margin:18px 0;padding:12px 14px;border-radius:10px;background:var(--cream);border:2px dashed rgba(163,41,58,.55);color:var(--ink)}

  /* form */
  form{display:grid;gap:18px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media (max-width:420px){.row{grid-template-columns:1fr;gap:18px}}
  .field{display:grid;gap:6px;min-width:0}
  label,legend{font-weight:700;font-size:14px;letter-spacing:.2px;color:var(--brown)}
  input:not([type=radio]):not([type=checkbox]):not([type=hidden]),select{width:100%;font:16px/1.3 var(--body);color:var(--ink);background:#fff;
    border:2px solid var(--ink);border-radius:10px;padding:11px 12px;box-shadow:3px 3px 0 rgba(107,74,51,.35);appearance:none;-webkit-appearance:none}
  input::placeholder{color:#8a7d70}
  select{padding-right:40px;background-image:linear-gradient(45deg,transparent 50%,var(--crimson) 50%),linear-gradient(135deg,var(--crimson) 50%,transparent 50%);
    background-position:calc(100% - 20px) 50%,calc(100% - 14px) 50%;background-size:6px 6px,6px 6px;background-repeat:no-repeat}
  select:disabled{color:#8a7d70;background-color:#f6f3ee}
  input:focus,select:focus{outline:3px solid var(--gold);outline-offset:2px;border-color:var(--crimson)}
  input[aria-invalid=true]{border-color:var(--crimson)}
  fieldset{border:0;margin:0;padding:0;min-width:0}
  legend{padding:0;margin-bottom:8px}
  /* Call / Text: real radio buttons drawn as pills */
  .pills{display:flex;gap:10px}
  .pill{position:relative;flex:1}
  .pill input{position:absolute;opacity:0;inset:0;margin:0}
  .pill label{display:flex;align-items:center;justify-content:center;gap:8px;font-size:16px;color:var(--ink);background:#fff;border:2px solid var(--ink);
    border-radius:999px;padding:10px 12px;box-shadow:3px 3px 0 rgba(107,74,51,.35);cursor:pointer}
  .pill label::before{content:"";width:16px;height:16px;border-radius:50%;border:2px solid var(--ink);background:#fff;flex:none}
  .pill input:checked+label{background:var(--cream);border-color:var(--crimson);color:var(--crimson-dark)}
  .pill input:checked+label::before{border-color:var(--crimson);background:radial-gradient(circle,var(--crimson) 0 4px,#fff 4.5px)}
  .pill input:focus-visible+label{outline:3px solid var(--gold);outline-offset:2px}
  .hint{margin:2px 0 0;font-style:italic;font-size:14px;color:var(--brown)}
  .addr{display:grid;gap:18px} .opt{font-weight:400;font-style:italic;color:var(--brown)}
  .err{margin:2px 0 0;color:var(--crimson);font-weight:700;font-size:14px}
  .divider{display:flex;align-items:center;gap:10px;font-family:var(--hand);font-weight:700;color:var(--crimson);font-size:20px;margin:4px 0 -4px}
  .divider::before,.divider::after{content:"";flex:1;height:0;border-top:2px dashed rgba(163,41,58,.5)}
  .hp{position:absolute;left:-9999px}
  [hidden]{display:none!important}

  button{margin-top:6px;width:100%;font-family:var(--hand);font-size:28px;font-weight:700;letter-spacing:.5px;color:#fff;background:var(--crimson);
    background-image:radial-gradient(circle at 30% 20%,rgba(255,255,255,.18),transparent 60%);border:3px solid var(--black);border-radius:999px;
    padding:12px 20px 14px;box-shadow:0 6px 0 var(--crimson-dark),0 6px 0 3px var(--black),0 12px 18px rgba(29,26,23,.25);cursor:pointer}
  button:hover{background-color:var(--crimson-dark)}
  button:focus-visible{outline:3px solid var(--gold);outline-offset:6px}
  button svg{width:26px;height:26px;vertical-align:-4px;margin-left:6px}
  button.secondary{width:auto;justify-self:start;margin-top:18px;font:700 14px var(--body);letter-spacing:0;color:var(--crimson);background:#fff;border:2px solid var(--crimson);
    padding:6px 16px;box-shadow:2px 2px 0 rgba(107,74,51,.35)}
  button.secondary:hover{background:var(--cream)}
  .signoff{text-align:center;font-family:var(--hand);color:var(--brown);font-size:18px;margin:18px 0 0}

  /* orders page */
  .scroll{overflow-x:auto;background:#fff;border:2px solid var(--ink);border-radius:10px;box-shadow:3px 3px 0 rgba(107,74,51,.35)}
  table{border-collapse:collapse;width:100%;font-size:14px}
  th,td{border-bottom:1px solid #e6d8c6;padding:7px 8px;text-align:left;vertical-align:top}
  tr:last-child td{border-bottom:0}
  th{background:var(--cream);color:var(--brown)}
  tr.done td{color:#8a8178;background:#f6f3ee}
  .sub{font-size:14px;font-weight:400;color:var(--brown)}
  .deliv{display:block;margin:0;text-align:center}
  .deliv input[type=checkbox]{width:22px;height:22px;margin:0;accent-color:var(--crimson);cursor:pointer}

  @media (min-width:700px){
    body{padding:64px 24px 72px}
    .card{padding:40px 44px 34px;transform:rotate(-.6deg)}
    .wide .card{transform:none}
    .head{margin:0 -44px;padding:0 44px 16px}
    h1{font-size:48px}
    .cookie-a{width:66px;height:66px;right:14px;top:-18px}
    .cookie-b{left:30px}
  }
`;

const COOKIES_SVG = `<svg class="cookie cookie-a" viewBox="0 0 64 64" aria-hidden="true">
  <circle cx="32" cy="32" r="29" fill="#d79a52" stroke="#6b4a33" stroke-width="3"/><circle cx="32" cy="32" r="22" fill="#e6b26a" opacity="0.6"/>
  <ellipse cx="22" cy="22" rx="4.5" ry="3.5" fill="#3b2516"/><ellipse cx="40" cy="18" rx="3.5" ry="3" fill="#3b2516"/><ellipse cx="44" cy="36" rx="4.5" ry="3.5" fill="#3b2516"/>
  <ellipse cx="27" cy="42" rx="4" ry="3.2" fill="#3b2516"/><ellipse cx="33" cy="30" rx="2.6" ry="2.2" fill="#3b2516"/><ellipse cx="18" cy="34" rx="2.5" ry="2" fill="#3b2516"/>
</svg>
<svg class="cookie cookie-b" viewBox="0 0 64 64" aria-hidden="true">
  <circle cx="32" cy="32" r="28" fill="#fbf4c4" stroke="#a3293a" stroke-width="3"/>
  <rect x="18" y="20" width="10" height="4" rx="2" fill="#a3293a" transform="rotate(30 23 22)"/><rect x="36" y="16" width="10" height="4" rx="2" fill="#e3b94a" transform="rotate(-20 41 18)"/>
  <rect x="40" y="36" width="10" height="4" rx="2" fill="#6b4a33" transform="rotate(60 45 38)"/><rect x="20" y="40" width="10" height="4" rx="2" fill="#e3b94a" transform="rotate(-40 25 42)"/>
  <rect x="28" y="28" width="9" height="4" rx="2" fill="#a3293a" transform="rotate(10 32 30)"/>
</svg>`;

const HEART_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.3-9.2C1.4 8.4 3.6 5 7 5c2 0 3.5 1.1 5 3 1.5-1.9 3-3 5-3 3.4 0 5.6 3.4 4.3 6.8C19.5 16.4 12 21 12 21z" fill="#e3b94a" stroke="#0d0d0d" stroke-width="1.6"/></svg>`;

// "Operation: Bake It Off" -> "Operation:" on one line, "Bake It Off" (dark) under it.
const shopTitle = () => {
  const i = SHOP.indexOf(":");
  return i > 0 && i < SHOP.length - 1
    ? `${esc(SHOP.slice(0, i + 1))}<br><span>${esc(SHOP.slice(i + 1).trim())}</span>`
    : esc(SHOP);
};

// wide: roomier card for the orders table
const layout = (title, inner, { wide = false } = {}) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preload" href="${FONT_URL}" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body><div class="stack${wide ? " wide" : ""}"><main class="card">
<header class="head">
${COOKIES_SVG}
<p class="kicker">from my kitchen to yours</p>
<h1><a href="/">${shopTitle()}</a></h1>
</header>
${inner}
<p class="signoff">baked with love (and extra butter)</p>
</main></div></body></html>`;

async function scanAll(TableName) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await db.send(new ScanCommand({ TableName, ExclusiveStartKey }));
    items.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Counts table: one row per delivery window; orderCount = boxes ordered so far. Its key attribute is still named
// "pickupDate" (to avoid replacing the table) but holds the window id.
async function getCounts() {
  const rows = await scanAll(COUNTS_TABLE);
  return Object.fromEntries(rows.map((r) => [r.pickupDate, r.orderCount || 0]));
}

const boxesLeft = (id, counts) => Math.max(0, WINDOWS[id].limit - (counts[id] || 0));

const windowIsOpen = (id, counts) => today() <= cutoffFor(id) && boxesLeft(id, counts) > 0;

// Open windows, sorted, each with its dates and boxes left.
function openWindows(counts) {
  return Object.keys(WINDOWS)
    .filter((id) => windowIsOpen(id, counts))
    .sort()
    .map((id) => ({ id, dates: [...WINDOWS[id].dates].sort(), left: boxesLeft(id, counts) }));
}

const boxOptions = (max, selected) =>
  Array.from({ length: max }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${String(n) === String(selected) ? " selected" : ""}>${n}</option>`)
    .join("");

function parseForm(event) {
  let body = event.body || "";
  if (event.isBase64Encoded) body = Buffer.from(body, "base64").toString("utf8");
  return Object.fromEntries(new URLSearchParams(body));
}

// ---------- pages ----------
async function orderPage(message = "", values = {}) {
  const windows = openWindows(await getCounts());
  const homeReq = values.location === "home" ? " required" : "";
  const form = windows.length
    ? `<p class="tagline">Fill out the card &amp; I&rsquo;ll get the oven warm.</p>
<form method="post" action="/">
  <div class="row">
    <div class="field"><label for="firstName">First name</label>
    <input id="firstName" name="firstName" maxlength="50" autocomplete="given-name" required value="${esc(values.firstName)}"></div>
    <div class="field"><label for="lastName">Last name</label>
    <input id="lastName" name="lastName" maxlength="50" autocomplete="family-name" required value="${esc(values.lastName)}"></div>
  </div>
  <div class="field">
    <label for="phone">Phone</label>
    <input id="phone" name="phone" type="tel" inputmode="tel" maxlength="20" autocomplete="tel" placeholder="(205) 555-1234" required aria-describedby="phoneErr" value="${esc(values.phone)}">
    <p class="err" id="phoneErr" aria-live="polite" hidden></p>
  </div>
  <fieldset>
    <legend>Best way to reach you</legend>
    <div class="pills">
      ${Object.entries(CONTACT_PREFS).map(([v, label]) => `<div class="pill"><input id="cp-${v}" type="radio" name="contactPref" value="${v}" required${values.contactPref === v ? " checked" : ""}><label for="cp-${v}">${label}</label></div>`).join("\n      ")}
    </div>
  </fieldset>
  <p class="divider" aria-hidden="true">the sweet part</p>
  <div class="field">
    <label for="pickupDate">Delivery date</label>
    <select id="pickupDate" name="pickupDate" required>
      <option value="">Pick a date</option>
      ${windows.map((w) => `<optgroup label="${esc(`Order by ${prettyDate(cutoffFor(w.id))}`)}">
        ${w.dates.map((d) => `<option value="${d}" data-left="${w.left}"${values.pickupDate === d ? " selected" : ""}>${esc(prettyDate(d))}</option>`).join("")}
      </optgroup>`).join("")}
    </select>
  </div>
  <div class="field">
    <label for="boxes">How many boxes?</label>
    <select id="boxes" name="boxes" required aria-describedby="boxesHint">
      ${boxOptions(
        windows.find((w) => w.dates.includes(values.pickupDate))?.left ?? Math.max(...windows.map((w) => w.left)),
        values.boxes
      )}
    </select>
    <p class="hint" id="boxesHint">If you want more, please pick a different date for delivery.</p>
  </div>
  <div class="field">
    <label for="location">Delivery location</label>
    <select id="location" name="location" required>
      <option value="">Pick a location</option>
      ${Object.entries(LOCATIONS).map(([v, label]) => `<option value="${v}"${values.location === v ? " selected" : ""}>${esc(label)}</option>`).join("")}
    </select>
  </div>
  <div class="addr" id="addressBox"${values.location === "home" ? "" : " hidden"}>
    <div class="field">
      <label for="street">Street address</label>
      <input id="street" name="street" maxlength="100" autocomplete="address-line1" placeholder="123 Oak St" value="${esc(values.street)}"${homeReq}>
    </div>
    <div class="field">
      <label for="unit">Apt, suite or unit <span class="opt">(optional)</span></label>
      <input id="unit" name="unit" maxlength="40" autocomplete="address-line2" value="${esc(values.unit)}">
    </div>
    <div class="row">
      <div class="field">
        <label for="city">City</label>
        <input id="city" name="city" maxlength="60" autocomplete="address-level2" value="${esc(values.city)}"${homeReq}>
      </div>
      <div class="field">
        <label for="zip">ZIP code</label>
        <input id="zip" name="zip" maxlength="10" inputmode="numeric" autocomplete="postal-code" pattern="\\d{5}(-\\d{4})?" title="5-digit ZIP code" value="${esc(values.zip)}"${homeReq}>
      </div>
    </div>
  </div>
  <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
  <button type="submit">Place order ${HEART_SVG}</button>
</form>
<script>${ORDER_JS}</script>`
    : `<p class="msg">Orders are closed for all delivery dates right now.</p>`;

  return html(200, layout(SHOP, `${message ? `<p class="msg">${esc(message)}</p>` : ""}
${form}`));
}

// Static so its hash can go in the CSP. Don't put ${...} values in here.
const ORDER_JS = `
  // Limit the box count to what's left in the chosen date's week.
  const date = document.getElementById("pickupDate"), boxes = document.getElementById("boxes");
  const syncBoxes = () => {
    const opt = date.selectedOptions[0], left = Number(opt?.dataset.left || 0), keep = Number(boxes.value) || 1;
    boxes.disabled = !left;
    boxes.innerHTML = left
      ? Array.from({ length: left }, (_, i) => '<option value="' + (i + 1) + '">' + (i + 1) + '</option>').join("")
      : '<option value="">Pick a date first</option>';
    if (left) boxes.value = String(Math.min(keep, left));
  };
  date.addEventListener("change", syncBoxes);
  syncBoxes();

  // Show the address field only for home delivery.
  const loc = document.getElementById("location"), box = document.getElementById("addressBox");
  const homeRequired = ["street", "city", "zip"].map((id) => document.getElementById(id));
  const sync = () => { const home = loc.value === "home"; box.hidden = !home; homeRequired.forEach((f) => { f.required = home; }); };
  loc.addEventListener("change", () => { sync(); if (loc.value === "home") homeRequired[0].focus(); });
  sync();

  // Phone: check it when they leave the field or submit, tidy the format,
  // and say what's wrong. The server checks the same rules.
  const phone = document.getElementById("phone"), phoneErr = document.getElementById("phoneErr");
  const phoneDigits = () => {
    let d = phone.value.replace(/\\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    return d;
  };
  const phoneProblem = (d) =>
    !d ? "Please enter your phone number."
    : d.length !== 10 ? "Please enter a 10-digit phone number, including area code."
    : !/^[2-9]\\d\\d[2-9]/.test(d) || /^[2-9]11/.test(d) ? "That doesn't look like a valid US phone number."
    : "";
  const checkPhone = () => {
    const d = phoneDigits(), problem = phoneProblem(d);
    if (!problem) phone.value = "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
    phone.setCustomValidity(problem);
    phoneErr.textContent = problem;
    phoneErr.hidden = !problem;
    phone.setAttribute("aria-invalid", problem ? "true" : "false");
    return !problem;
  };
  phone.addEventListener("blur", () => { if (phone.value) checkPhone(); });
  phone.addEventListener("input", () => { if (!phoneErr.hidden) checkPhone(); });
  phone.form.addEventListener("submit", (e) => { if (!checkPhone()) { e.preventDefault(); phone.focus(); } });
`;

async function placeOrder(event) {
  const o = parseForm(event);
  if (o.website) return html(200, layout(SHOP, "<h2>Thanks!</h2>")); // bot filled the hidden field

  const firstName = (o.firstName || "").trim().slice(0, 50);
  const lastName = (o.lastName || "").trim().slice(0, 50);
  const phone = formatPhone(o.phone);
  const contactPref = o.contactPref in CONTACT_PREFS ? o.contactPref : "";
  const location = o.location in LOCATIONS ? o.location : "";
  const home = location === "home";
  const clean = (v, n) => (home ? String(v || "").trim().replace(/\s+/g, " ").slice(0, n) : "");
  const street = clean(o.street, 100), unit = clean(o.unit, 40), city = clean(o.city, 60), zip = clean(o.zip, 10);
  // One line for the confirmation and the orders page, e.g. "123 Oak St, Apt 4B, Hoover, AL 35226".
  const address = home ? [street, unit, `${city}, AL ${zip}`].filter(Boolean).join(", ") : "";
  const pickupDate = o.pickupDate || "";
  const boxes = Number(o.boxes);

  if (!firstName || !lastName) {
    return orderPage("Please fill in your first and last name.", o);
  }
  if (!phone) return orderPage("Please enter a valid 10-digit US phone number, including area code.", o);
  if (!contactPref) return orderPage("Please choose call or text.", o);
  if (!location) return orderPage("Please pick a delivery location.", o);
  if (home && (!street || !city)) return orderPage("Please enter your street address and city.", o);
  if (home && !/^\d{5}(-\d{4})?$/.test(zip)) return orderPage("Please enter a 5-digit ZIP code.", o);
  const windowId = DATE_TO_WINDOW[pickupDate];
  if (!windowId) {
    return orderPage("Please pick one of the listed delivery dates.", o);
  }
  if (today() > cutoffFor(windowId)) {
    return orderPage(`Sorry, orders for that week closed on ${prettyDate(cutoffFor(windowId))}. Please pick a later date.`, o);
  }
  const limit = WINDOWS[windowId].limit;
  if (!Number.isInteger(boxes) || boxes < 1 || boxes > limit) {
    return orderPage("Please choose how many boxes you'd like.", o);
  }

  // Claim the boxes in that week. The condition makes this safe even if two
  // people submit for the last boxes at the same moment.
  try {
    await db.send(new UpdateCommand({
      TableName: COUNTS_TABLE,
      Key: { pickupDate: windowId },
      UpdateExpression: "ADD orderCount :n",
      ConditionExpression: "attribute_not_exists(orderCount) OR orderCount <= :max",
      ExpressionAttributeValues: { ":n": boxes, ":max": limit - boxes },
    }));
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") {
      const left = boxesLeft(windowId, await getCounts());
      return orderPage(left
        ? `Sorry, that week only has ${left} box${left === 1 ? "" : "es"} left. Please order fewer or pick a different date.`
        : "Sorry, that week just filled up. Please pick a date in another week.", o);
    }
    throw e;
  }

  await db.send(new PutCommand({
    TableName: ORDERS_TABLE,
    Item: {
      orderId: randomUUID(),
      createdAt: new Date().toISOString(),
      pickupDate, boxes, firstName, lastName, phone, contactPref, location, address, street, unit, city, zip,
      // DynamoDB TTL (epoch seconds): deleted RETENTION_DAYS after the delivery date.
      expiresAt: Math.floor(Date.parse(`${minusDays(pickupDate, -RETENTION_DAYS)}T23:59:59Z`) / 1000),
    },
  }));

  const where = location === "home" ? address : LOCATIONS[location];
  return html(200, layout(SHOP, `<h2>Thanks, ${esc(firstName)}!</h2>
<p class="msg">Your order for <strong>${boxes} box${boxes === 1 ? "" : "es"}</strong> is in for delivery on <strong>${esc(prettyDate(pickupDate))}</strong> to <strong>${esc(where)}</strong>.
I'll ${contactPref} you at ${esc(phone)} if I have questions.</p>
<p><a href="/">Place another order</a></p>`));
}

// ---------- orders-page sign-in ----------
// The password lives in SSM Parameter Store (SecureString). It's fetched only when
// /orders is used, then cached for a few minutes so a changed password takes effect
// without a redeploy.
const KEY_CACHE_MS = 5 * 60_000;
let keyCache; // { value, at }
let keyFetch; // in-flight request, shared by concurrent callers

async function getAdminKey() {
  if (keyCache && Date.now() - keyCache.at < KEY_CACHE_MS) return keyCache.value;
  keyFetch ??= ssm
    .send(new GetParameterCommand({ Name: ADMIN_KEY_PARAM, WithDecryption: true }))
    .then((r) => (keyCache = { value: r.Parameter?.Value || "", at: Date.now() }).value)
    .finally(() => { keyFetch = undefined; });
  return keyFetch;
}

// The cookie holds a value derived from the password, never the password itself.
// Changing admin_key signs everyone out.
const COOKIE = "bio_admin";
const SESSION_DAYS = 30;
const sessionToken = (key) => createHmac("sha256", key).update("orders-session-v1").digest("hex");

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const isSignedIn = async (event) => {
  const cookies = event.cookies || (event.headers?.cookie || "").split(/;\s*/);
  const value = cookies.map((c) => c.split("=")).find(([k]) => k === COOKIE)?.[1];
  if (!value) return false; // skip the SSM call for visitors without a cookie
  const key = await getAdminKey();
  return !!key && sameSecret(value, sessionToken(key));
};

// Sign-in attempts allowed per IP address per window, counted in DynamoDB so the
// limit holds across Lambda instances and parallel requests.
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MIN = 15;

async function tooManyAttempts(event) {
  // Function URLs report the real connecting IP here (not a client-set header).
  const ip = event.requestContext?.http?.sourceIp || "unknown";
  const bucket = Math.floor(Date.now() / (ATTEMPT_WINDOW_MIN * 60_000));
  const r = await db.send(new UpdateCommand({
    TableName: ATTEMPTS_TABLE,
    Key: { id: `${ip}#${bucket}` },
    UpdateExpression: "ADD attempts :one SET expiresAt = :exp",
    ExpressionAttributeValues: { ":one": 1, ":exp": (bucket + 2) * ATTEMPT_WINDOW_MIN * 60 },
    ReturnValues: "UPDATED_NEW",
  }));
  return r.Attributes.attempts > MAX_ATTEMPTS;
}

const redirect = (location, cookies) => ({
  statusCode: 303,
  headers: { ...SECURITY_HEADERS, location },
  ...(cookies ? { cookies } : {}),
});

const cookieAttrs = "Path=/orders; HttpOnly; Secure; SameSite=Strict";

function signInPage(message = "", status = 200) {
  return html(status, layout(`${SHOP} – Sign in`, `<h2>Orders</h2>
${message ? `<p class="msg">${esc(message)}</p>` : ""}
<form method="post" action="/orders">
  <label for="key">Password</label>
  <input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
</form>`));
}

async function ordersPost(event) {
  const f = parseForm(event);
  if (f.action === "signout") return redirect("/orders", [`${COOKIE}=; ${cookieAttrs}; Max-Age=0`]);
  if (f.action === "delivered") return setDelivered(event, f);
  if (await tooManyAttempts(event)) {
    return signInPage(`Too many sign-in attempts. Please wait ${ATTEMPT_WINDOW_MIN} minutes and try again.`, 429);
  }
  const key = await getAdminKey();
  if (!key || !sameSecret(f.key || "", key)) {
    await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
    return signInPage("That password didn't match.", 401);
  }
  return redirect("/orders", [`${COOKIE}=${sessionToken(key)}; ${cookieAttrs}; Max-Age=${SESSION_DAYS * 86400}`]);
}

// Mark one order delivered / not delivered. Called by the checkbox via fetch
// (answers 204) or by a plain form post without JavaScript (redirects back).
async function setDelivered(event, f) {
  if (!(await isSignedIn(event))) return html(401, layout("Signed out", "<p>Please sign in again.</p>"));
  const orderId = String(f.orderId || "");
  const delivered = f.delivered === "on";
  try {
    await db.send(new UpdateCommand({
      TableName: ORDERS_TABLE,
      Key: { orderId },
      UpdateExpression: delivered ? "SET delivered = :t, deliveredAt = :now" : "SET delivered = :f REMOVE deliveredAt",
      ConditionExpression: "attribute_exists(orderId)",
      ExpressionAttributeValues: delivered ? { ":t": true, ":now": new Date().toISOString() } : { ":f": false },
    }));
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") return html(404, layout("Not found", "<p>Order not found.</p>"));
    throw e;
  }
  return event.headers?.["x-requested-with"] === "fetch"
    ? { statusCode: 204, headers: SECURITY_HEADERS }
    : redirect("/orders");
}

async function adminPage(event) {
  if (!(await isSignedIn(event))) return signInPage();

  const [orders, counts] = await Promise.all([scanAll(ORDERS_TABLE), getCounts()]);
  orders.sort((a, b) =>
    (a.pickupDate + a.createdAt).localeCompare(b.pickupDate + b.createdAt)
  );

  const summary = Object.keys(WINDOWS).sort().map((id) => {
    const ds = [...WINDOWS[id].dates].sort();
    return `<tr><td>${esc(prettyDate(ds[0]))} – ${esc(prettyDate(ds[ds.length - 1]))}</td>
  <td>${esc(prettyDate(cutoffFor(id)))}</td><td>${counts[id] || 0} / ${WINDOWS[id].limit}</td></tr>`;
  }).join("");

  const rows = orders.map((o) => `<tr${o.delivered ? ' class="done"' : ""}>
  <td><form method="post" action="/orders" class="deliv">
    <input type="hidden" name="action" value="delivered"><input type="hidden" name="orderId" value="${esc(o.orderId)}">
    <input type="checkbox" name="delivered" aria-label="Delivered: ${esc(fullName(o))}, ${esc(prettyDate(o.pickupDate))}"${o.delivered ? " checked" : ""}>
    <noscript><button type="submit" class="secondary">Save</button></noscript>
  </form></td>
  <td>${esc(prettyDate(o.pickupDate))}</td><td>${esc(o.boxes ?? "")}</td><td>${esc(fullName(o))}</td>
  <td>${esc(o.phone || o.contact)}${o.contactPref ? ` (${esc(CONTACT_PREFS[o.contactPref])})` : ""}</td>
  <td>${esc(o.location === "home" ? `Home: ${o.address}` : LOCATIONS[o.location] || "")}</td>
  <td>${esc(new Date(o.createdAt).toLocaleString("en-US", { timeZone: TZ }))}</td></tr>`).join("");

  const totalBoxes = orders.reduce((t, o) => t + (Number(o.boxes) || 0), 0);
  return html(200, layout(`${SHOP} – Orders`, `<h2>Orders (${orders.length}, ${totalBoxes} box${totalBoxes === 1 ? "" : "es"})</h2>
<h3>Delivery weeks</h3>
<div class="scroll"><table><tr><th>Week</th><th>Order by</th><th>Boxes / limit</th></tr>${summary}</table></div>
<h3>All orders <span class="sub">(<span id="doneCount">${orders.filter((o) => o.delivered).length}</span> of ${orders.length} delivered)</span></h3>
<div class="scroll"><table><tr><th>Delivered</th><th>Delivery</th><th>Boxes</th><th>Name</th><th>Phone</th><th>Location</th><th>Placed</th></tr>${rows}</table></div>
<form method="post" action="/orders"><input type="hidden" name="action" value="signout">
  <button type="submit" class="secondary">Sign out</button></form>
<script>${ADMIN_JS}</script>`, { wide: true }));
}

// Static so its hash can go in the CSP. Don't put ${...} values in here.
const ADMIN_JS = `
  // Save a delivered checkbox as soon as it's clicked; undo it if saving fails.
  const doneCount = document.getElementById("doneCount");
  document.querySelectorAll("form.deliv input[type=checkbox]").forEach((box) => {
    box.addEventListener("change", async () => {
      const row = box.closest("tr"), form = box.form;
      row.classList.toggle("done", box.checked);
      doneCount.textContent = Number(doneCount.textContent) + (box.checked ? 1 : -1);
      const body = new URLSearchParams(new FormData(form)); // read before disabling: disabled boxes aren't sent
      box.disabled = true;
      try {
        // getAttribute: form.action would return the hidden input named "action"
        const r = await fetch(form.getAttribute("action"), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-requested-with": "fetch" },
          body,
        });
        if (!r.ok) throw new Error(r.status === 401 ? "You've been signed out. Please reload and sign in." : "Couldn't save. Please try again.");
      } catch (e) {
        box.checked = !box.checked;
        row.classList.toggle("done", box.checked);
        doneCount.textContent = Number(doneCount.textContent) + (box.checked ? 1 : -1);
        alert(e instanceof TypeError ? "Couldn't save. Check your connection." : e.message); // TypeError = network failure
      } finally {
        box.disabled = false;
      }
    });
  });
`;

// Browsers only run the exact scripts/styles above; anything injected is blocked.
const CSP = [
  "default-src 'none'",
  `script-src ${sha256(ORDER_JS)} ${sha256(ADMIN_JS)}`,
  `style-src ${sha256(CSS)}`,
  "font-src 'self'", // Dancing Script, served from /fonts/
  "connect-src 'self'", // delivered checkbox fetch
  "form-action 'self'",
  "frame-ancestors 'none'", // no framing (clickjacking)
  "base-uri 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "x-frame-options": "DENY", // older browsers
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "cache-control": "no-store",
};

// Font files served from the zip, read once when the Lambda starts. Versioned URLs,
// so browsers can cache them for a year.
const FONTS = {
  [FONT_URL]: readFileSync(new URL("./fonts/dancing-script-latin.woff2", import.meta.url)).toString("base64"),
};

const font = (path) => ({
  statusCode: 200,
  headers: { ...SECURITY_HEADERS, "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" },
  body: FONTS[path],
  isBase64Encoded: true,
});

// ---------- entry point ----------
export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  try {
    if (Object.hasOwn(FONTS, path) && method === "GET") return font(path);
    if (path === "/orders" && method === "GET") return await adminPage(event);
    if (path === "/orders" && method === "POST") return await ordersPost(event);
    if (path !== "/") return html(404, layout("Not found", "<p>Not found.</p>"));
    if (method === "POST") return await placeOrder(event);
    return await orderPage();
  } catch (e) {
    console.error(e);
    return html(500, layout("Error", "<p>Something went wrong. Please try again.</p>"));
  }
};
