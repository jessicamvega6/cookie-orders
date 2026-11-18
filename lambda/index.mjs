// One Lambda serves everything:
//   GET  /        -> order form (only shows pickup dates that still have room)
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
const SLOTS = JSON.parse(process.env.PICKUP_SLOTS || "{}"); // { "2026-12-19": 12, ... }
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const TZ = process.env.TIMEZONE || "America/Chicago";
const SHOP = process.env.SHOP_NAME || "Cookie Orders";

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
  body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#3b2a1a;background:#fffaf3}
  h1{font-size:1.6rem} label{display:block;margin:.9rem 0 .25rem;font-weight:600}
  input,select,textarea,button{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid #c9b8a3;border-radius:8px;background:#fff}
  textarea{min-height:5rem} button{margin-top:1.2rem;background:#8a4b1f;color:#fff;border:0;font-weight:600;cursor:pointer}
  .msg{padding:.8rem;border-radius:8px;background:#fde8d4} .hp{position:absolute;left:-9999px}
  table{border-collapse:collapse;width:100%;font-size:.9rem} th,td{border-bottom:1px solid #e6d8c6;padding:.4rem;text-align:left;vertical-align:top}
</style></head><body>${inner}</body></html>`;

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

async function getCounts() {
  const rows = await scanAll(COUNTS_TABLE);
  return Object.fromEntries(rows.map((r) => [r.pickupDate, r.orderCount || 0]));
}

function openDates(counts) {
  const t = today();
  return Object.keys(SLOTS)
    .filter((d) => d >= t && (counts[d] || 0) < SLOTS[d])
    .sort();
}

function parseForm(event) {
  let body = event.body || "";
  if (event.isBase64Encoded) body = Buffer.from(body, "base64").toString("utf8");
  return Object.fromEntries(new URLSearchParams(body));
}

// ---------- pages ----------
async function orderPage(message = "", values = {}) {
  const dates = openDates(await getCounts());
  const form = dates.length
    ? `<form method="post" action="/">
  <label for="name">Your name</label>
  <input id="name" name="name" maxlength="100" required value="${esc(values.name)}">
  <label for="contact">Phone or email</label>
  <input id="contact" name="contact" maxlength="100" required value="${esc(values.contact)}">
  <label for="items">What would you like?</label>
  <textarea id="items" name="items" maxlength="500" required placeholder="e.g. 2 dozen chocolate chip">${esc(values.items)}</textarea>
  <label for="pickupDate">Pickup date</label>
  <select id="pickupDate" name="pickupDate" required>
    <option value="">Pick a date</option>
    ${dates.map((d) => `<option value="${d}">${esc(prettyDate(d))}</option>`).join("")}
  </select>
  <label for="notes">Notes or allergies (optional)</label>
  <textarea id="notes" name="notes" maxlength="500">${esc(values.notes)}</textarea>
  <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
  <button type="submit">Place order</button>
</form>`
    : `<p class="msg">All pickup dates are full right now. Check back soon!</p>`;

  return html(200, layout(SHOP, `<h1>${esc(SHOP)}</h1>
${message ? `<p class="msg">${esc(message)}</p>` : ""}
${form}`));
}

async function placeOrder(event) {
  const o = parseForm(event);
  if (o.website) return html(200, layout(SHOP, "<h1>Thanks!</h1>")); // bot filled the hidden field

  const name = (o.name || "").trim().slice(0, 100);
  const contact = (o.contact || "").trim().slice(0, 100);
  const items = (o.items || "").trim().slice(0, 500);
  const notes = (o.notes || "").trim().slice(0, 500);
  const pickupDate = o.pickupDate || "";

  if (!name || !contact || !items) {
    return orderPage("Please fill in your name, contact info and order.", o);
  }
  if (!(pickupDate in SLOTS) || pickupDate < today()) {
    return orderPage("Please pick one of the listed pickup dates.", o);
  }

  // Claim a spot for that date. The condition makes this safe even if two
  // people submit for the last spot at the same moment.
  try {
    await db.send(new UpdateCommand({
      TableName: COUNTS_TABLE,
      Key: { pickupDate },
      UpdateExpression: "ADD orderCount :one",
      ConditionExpression: "attribute_not_exists(orderCount) OR orderCount < :limit",
      ExpressionAttributeValues: { ":one": 1, ":limit": SLOTS[pickupDate] },
    }));
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") {
      return orderPage("Sorry, that pickup date just filled up. Please pick another.", o);
    }
    throw e;
  }

  await db.send(new PutCommand({
    TableName: ORDERS_TABLE,
    Item: {
      orderId: randomUUID(),
      createdAt: new Date().toISOString(),
      pickupDate, name, contact, items, notes,
    },
  }));

  return html(200, layout(SHOP, `<h1>Thanks, ${esc(name)}!</h1>
<p class="msg">Your order is in for pickup on <strong>${esc(prettyDate(pickupDate))}</strong>.</p>
<p><strong>Order:</strong> ${esc(items)}</p>
<p><a href="/">Place another order</a></p>`));
}

async function adminPage(event) {
  const key = event.queryStringParameters?.key || "";
  if (!ADMIN_KEY || key !== ADMIN_KEY) return html(403, layout("Forbidden", "<p>Not allowed.</p>"));

  const [orders, counts] = await Promise.all([scanAll(ORDERS_TABLE), getCounts()]);
  orders.sort((a, b) =>
    (a.pickupDate + a.createdAt).localeCompare(b.pickupDate + b.createdAt)
  );

  const summary = Object.keys(SLOTS).sort().map((d) =>
    `<tr><td>${esc(prettyDate(d))}</td><td>${counts[d] || 0} / ${SLOTS[d]}</td></tr>`
  ).join("");

  const rows = orders.map((o) => `<tr>
  <td>${esc(prettyDate(o.pickupDate))}</td><td>${esc(o.name)}</td><td>${esc(o.contact)}</td>
  <td>${esc(o.items)}</td><td>${esc(o.notes)}</td>
  <td>${esc(new Date(o.createdAt).toLocaleString("en-US", { timeZone: TZ }))}</td></tr>`).join("");

  return html(200, layout(`${SHOP} – Orders`, `<h1>Orders (${orders.length})</h1>
<h2>Pickup dates</h2>
<table><tr><th>Date</th><th>Orders / limit</th></tr>${summary}</table>
<h2>All orders</h2>
<table><tr><th>Pickup</th><th>Name</th><th>Contact</th><th>Order</th><th>Notes</th><th>Placed</th></tr>${rows}</table>`));
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
