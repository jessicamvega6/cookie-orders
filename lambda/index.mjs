// One Lambda serves everything:
//   GET  /        -> order form (only shows delivery dates whose week is still open)
//   POST /        -> place an order
//   GET  /orders  -> order list for your friend (needs ?key=ADMIN_KEY)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const ORDERS_TABLE = process.env.ORDERS_TABLE;
const COUNTS_TABLE = process.env.COUNTS_TABLE;
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

const html = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  body,
});

const layout = (title, inner) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
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
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:.9rem} th,td{border-bottom:1px solid #e6d8c6;padding:.4rem;text-align:left;vertical-align:top}
  th{background:var(--cream)}
</style></head><body><main class="card">
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
<script>
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
</script>`
    : `<p class="msg">Orders are closed for all delivery dates right now.</p>`;

  return html(200, layout(SHOP, `${message ? `<p class="msg">${esc(message)}</p>` : ""}
${form}`));
}

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
    },
  }));

  const where = location === "home" ? address : LOCATIONS[location];
  return html(200, layout(SHOP, `<h2>Thanks, ${esc(firstName)}!</h2>
<p class="msg">Your order for <strong>${boxes} box${boxes === 1 ? "" : "es"}</strong> is in for delivery on <strong>${esc(prettyDate(pickupDate))}</strong> to <strong>${esc(where)}</strong>.
We'll ${contactPref} you at ${esc(phone)} if we have questions.</p>
<p><a href="/">Place another order</a></p>`));
}

async function adminPage(event) {
  const key = event.queryStringParameters?.key || "";
  if (!ADMIN_KEY || key !== ADMIN_KEY) return html(403, layout("Forbidden", "<p>Not allowed.</p>"));

  const [orders, counts] = await Promise.all([scanAll(ORDERS_TABLE), getCounts()]);
  orders.sort((a, b) =>
    (a.pickupDate + a.createdAt).localeCompare(b.pickupDate + b.createdAt)
  );

  const summary = Object.keys(WINDOWS).sort().map((id) => {
    const ds = [...WINDOWS[id].dates].sort();
    return `<tr><td>${esc(prettyDate(ds[0]))} – ${esc(prettyDate(ds[ds.length - 1]))}</td>
  <td>${esc(prettyDate(cutoffFor(id)))}</td><td>${counts[id] || 0} / ${WINDOWS[id].limit}</td></tr>`;
  }).join("");

  const rows = orders.map((o) => `<tr>
  <td>${esc(prettyDate(o.pickupDate))}</td><td>${esc(o.boxes ?? "")}</td><td>${esc(fullName(o))}</td>
  <td>${esc(o.phone || o.contact)}${o.contactPref ? ` (${esc(CONTACT_PREFS[o.contactPref])})` : ""}</td>
  <td>${esc(o.location === "home" ? `Home: ${o.address}` : LOCATIONS[o.location] || "")}</td>
  <td>${esc(new Date(o.createdAt).toLocaleString("en-US", { timeZone: TZ }))}</td></tr>`).join("");

  return html(200, layout(`${SHOP} – Orders`, `<h2>Orders (${orders.length}, ${orders.reduce((t, o) => t + (Number(o.boxes) || 0), 0)} boxes)</h2>
<h3>Delivery weeks</h3>
<div class="scroll"><table><tr><th>Week</th><th>Order by</th><th>Boxes / limit</th></tr>${summary}</table></div>
<h3>All orders</h3>
<div class="scroll"><table><tr><th>Delivery</th><th>Boxes</th><th>Name</th><th>Phone</th><th>Location</th><th>Placed</th></tr>${rows}</table></div>`));
}

// ---------- entry point ----------
export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  try {
    if (path === "/orders" && method === "GET") return await adminPage(event);
    if (path !== "/") return html(404, layout("Not found", "<p>Not found.</p>"));
    if (method === "POST") return await placeOrder(event);
    return await orderPage();
  } catch (e) {
    console.error(e);
    return html(500, layout("Error", "<p>Something went wrong. Please try again.</p>"));
  }
};
