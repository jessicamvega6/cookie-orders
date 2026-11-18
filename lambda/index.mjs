// One Lambda serves everything:
//   GET  /        -> order form (only shows delivery dates whose week is still open)
//   POST /        -> place an order
//   GET  /orders  -> order list for your friend (password page until signed in)
//   POST /orders  -> sign in with ADMIN_KEY (sets a cookie), sign out, or mark delivered
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
const ADMIN_KEY = process.env.ADMIN_KEY || "";
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

// Keep digits; accept 10 digits or 11 starting with 1. Returns (205) 555-1234 or "".
function formatPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : "";
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

const CSS = `
  /* Colors from the Operation: Bake It Off flyer */
  :root{--crimson:#a3293a;--crimson-dark:#82202e;--black:#0d0d0d;--gold:#e3b94a;--cream:#fbf4c4;--brown:#6b4a33;--ink:#1d1a17;--line:#c9b9a5}
  body{margin:0;padding:1.5rem 1rem;background:var(--crimson);color:var(--ink);font-family:"Bookman Old Style","Bookman",Georgia,serif;line-height:1.4}
  .card{max-width:600px;margin:0 auto;background:#fff;padding:0 1.5rem 1.75rem}
  .banner{margin:0 -1.5rem 1.25rem;padding:1.1rem 1rem;background:var(--black);color:var(--gold);text-align:center;
    font:italic 700 clamp(1.6rem,6vw,2.4rem)/1.15 Georgia,"Times New Roman",serif;letter-spacing:.01em}
  .banner a{color:inherit;text-decoration:none}
  h2{color:var(--crimson);font-size:1.4rem;margin:.5rem 0} h3{color:var(--crimson);margin:1.25rem 0 .5rem}
  label{display:block;margin:.9rem 0 .25rem;font-weight:700}
  input,select,button{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink)}
  input:focus,select:focus{outline:3px solid var(--gold);outline-offset:1px;border-color:var(--brown)}
  input[type=radio]{accent-color:var(--crimson)}
  button{margin-top:1.4rem;background:var(--crimson);color:#fff;border:0;font-weight:700;font-size:1.05rem;cursor:pointer}
  button:hover{background:var(--crimson-dark)} button:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
  .msg{padding:.8rem 1rem;border-radius:6px;background:var(--cream);border-left:5px solid var(--gold)} .hp{position:absolute;left:-9999px}
  a{color:var(--crimson)}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:0 .8rem} @media (max-width:420px){.row{grid-template-columns:1fr}}
  fieldset{border:0;padding:0;margin:.9rem 0 0} legend{font-weight:700;margin:0 0 .4rem;padding:0}
  .choices{display:flex;gap:1.5rem} .choices label{display:flex;align-items:center;gap:.4rem;margin:0;font-weight:400}
  .choices input{width:auto;margin:0} .hint{margin:.3rem 0 0;font-size:.9rem;color:var(--brown);font-style:italic} [hidden]{display:none!important}
  .scroll{overflow-x:auto} .deliv{margin:0;text-align:center} .deliv input[type=checkbox]{width:1.4rem;height:1.4rem;margin:0;accent-color:var(--crimson);cursor:pointer}
  tr.done td{color:#8a8178;background:#f6f3ee} .sub{font-size:.9rem;font-weight:400;color:var(--brown)} button.secondary{background:#fff;color:var(--crimson);border:1px solid var(--crimson);width:auto;padding:.4rem 1rem;font-size:.9rem}
  table{border-collapse:collapse;width:100%;font-size:.9rem} th,td{border-bottom:1px solid #e6d8c6;padding:.4rem;text-align:left;vertical-align:top}
  th{background:var(--cream)}
`;

const layout = (title, inner) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style></head><body><main class="card">
<h1 class="banner"><a href="/">${esc(SHOP)}</a></h1>
${inner}
</main></body></html>`;

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
  const form = windows.length
    ? `<form method="post" action="/">
  <div class="row">
    <div><label for="firstName">First name</label>
    <input id="firstName" name="firstName" maxlength="50" autocomplete="given-name" required value="${esc(values.firstName)}"></div>
    <div><label for="lastName">Last name</label>
    <input id="lastName" name="lastName" maxlength="50" autocomplete="family-name" required value="${esc(values.lastName)}"></div>
  </div>
  <label for="phone">Phone</label>
  <input id="phone" name="phone" type="tel" maxlength="20" autocomplete="tel" placeholder="(205) 555-1234" required value="${esc(values.phone)}">
  <fieldset>
    <legend>Best way to reach you</legend>
    <div class="choices">
      ${Object.entries(CONTACT_PREFS).map(([v, label]) => `<label><input type="radio" name="contactPref" value="${v}" required${values.contactPref === v ? " checked" : ""}> ${label}</label>`).join("\n      ")}
    </div>
  </fieldset>
  <label for="pickupDate">Delivery date</label>
  <select id="pickupDate" name="pickupDate" required>
    <option value="">Pick a date</option>
    ${windows.map((w) => `<optgroup label="${esc(`Order by ${prettyDate(cutoffFor(w.id))}`)}">
      ${w.dates.map((d) => `<option value="${d}" data-left="${w.left}"${values.pickupDate === d ? " selected" : ""}>${esc(prettyDate(d))}</option>`).join("")}
    </optgroup>`).join("")}
  </select>
  <label for="boxes">How many boxes?</label>
  <select id="boxes" name="boxes" required aria-describedby="boxesHint">
    ${boxOptions(
      windows.find((w) => w.dates.includes(values.pickupDate))?.left ?? Math.max(...windows.map((w) => w.left)),
      values.boxes
    )}
  </select>
  <p class="hint" id="boxesHint">If you want more, please pick a different date for delivery.</p>
  <label for="location">Delivery location</label>
  <select id="location" name="location" required>
    <option value="">Pick a location</option>
    ${Object.entries(LOCATIONS).map(([v, label]) => `<option value="${v}"${values.location === v ? " selected" : ""}>${esc(label)}</option>`).join("")}
  </select>
  <div id="addressBox"${values.location === "home" ? "" : " hidden"}>
    <label for="address">Home address</label>
    <input id="address" name="address" maxlength="200" autocomplete="street-address" placeholder="Street, city, ZIP" value="${esc(values.address)}"${values.location === "home" ? " required" : ""}>
  </div>
  <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
  <button type="submit">Place order</button>
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
  const loc = document.getElementById("location"), box = document.getElementById("addressBox"), addr = document.getElementById("address");
  const sync = () => { const home = loc.value === "home"; box.hidden = !home; addr.required = home; };
  loc.addEventListener("change", () => { sync(); if (loc.value === "home") addr.focus(); });
  sync();
`;

async function placeOrder(event) {
  const o = parseForm(event);
  if (o.website) return html(200, layout(SHOP, "<h2>Thanks!</h2>")); // bot filled the hidden field

  const firstName = (o.firstName || "").trim().slice(0, 50);
  const lastName = (o.lastName || "").trim().slice(0, 50);
  const phone = formatPhone(o.phone);
  const contactPref = o.contactPref in CONTACT_PREFS ? o.contactPref : "";
  const location = o.location in LOCATIONS ? o.location : "";
  const address = location === "home" ? (o.address || "").trim().slice(0, 200) : "";
  const pickupDate = o.pickupDate || "";
  const boxes = Number(o.boxes);

  if (!firstName || !lastName) {
    return orderPage("Please fill in your first and last name.", o);
  }
  if (!phone) return orderPage("Please enter a 10-digit phone number.", o);
  if (!contactPref) return orderPage("Please choose call or text.", o);
  if (!location) return orderPage("Please pick a delivery location.", o);
  if (location === "home" && !address) return orderPage("Please enter your home address.", o);
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
      pickupDate, boxes, firstName, lastName, phone, contactPref, location, address,
      // DynamoDB TTL (epoch seconds): deleted RETENTION_DAYS after the delivery date.
      expiresAt: Math.floor(Date.parse(`${minusDays(pickupDate, -RETENTION_DAYS)}T23:59:59Z`) / 1000),
    },
  }));

  const where = location === "home" ? address : LOCATIONS[location];
  return html(200, layout(SHOP, `<h2>Thanks, ${esc(firstName)}!</h2>
<p class="msg">Your order for <strong>${boxes} box${boxes === 1 ? "" : "es"}</strong> is in for delivery on <strong>${esc(prettyDate(pickupDate))}</strong> to <strong>${esc(where)}</strong>.
We'll ${contactPref} you at ${esc(phone)} if we have questions.</p>
<p><a href="/">Place another order</a></p>`));
}

// ---------- orders-page sign-in ----------
// The cookie holds a value derived from ADMIN_KEY, never the key itself.
// Changing admin_key signs everyone out.
const COOKIE = "bio_admin";
const SESSION_DAYS = 30;
const sessionToken = () => createHmac("sha256", ADMIN_KEY).update("orders-session-v1").digest("hex");

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const isSignedIn = (event) => {
  if (!ADMIN_KEY) return false;
  const cookies = event.cookies || (event.headers?.cookie || "").split(/;\s*/);
  const value = cookies.map((c) => c.split("=")).find(([k]) => k === COOKIE)?.[1];
  return !!value && sameSecret(value, sessionToken());
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
  if (!ADMIN_KEY || !sameSecret(f.key || "", ADMIN_KEY)) {
    await new Promise((r) => setTimeout(r, 1000)); // slow down guessing
    return signInPage("That password didn't match.", 401);
  }
  return redirect("/orders", [`${COOKIE}=${sessionToken()}; ${cookieAttrs}; Max-Age=${SESSION_DAYS * 86400}`]);
}

// Mark one order delivered / not delivered. Called by the checkbox via fetch
// (answers 204) or by a plain form post without JavaScript (redirects back).
async function setDelivered(event, f) {
  if (!isSignedIn(event)) return html(401, layout("Signed out", "<p>Please sign in again.</p>"));
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
  if (!isSignedIn(event)) return signInPage();

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

  return html(200, layout(`${SHOP} – Orders`, `<h2>Orders (${orders.length}, ${orders.reduce((t, o) => t + (Number(o.boxes) || 0), 0)} boxes)</h2>
<h3>Delivery weeks</h3>
<div class="scroll"><table><tr><th>Week</th><th>Order by</th><th>Boxes / limit</th></tr>${summary}</table></div>
<h3>All orders <span class="sub">(<span id="doneCount">${orders.filter((o) => o.delivered).length}</span> of ${orders.length} delivered)</span></h3>
<div class="scroll"><table><tr><th>Delivered</th><th>Delivery</th><th>Boxes</th><th>Name</th><th>Phone</th><th>Location</th><th>Placed</th></tr>${rows}</table></div>
<form method="post" action="/orders"><input type="hidden" name="action" value="signout">
  <button type="submit" class="secondary">Sign out</button></form>
<script>${ADMIN_JS}</script>`));
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
        const r = await fetch(form.action, {
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

// ---------- entry point ----------
export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  try {
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
