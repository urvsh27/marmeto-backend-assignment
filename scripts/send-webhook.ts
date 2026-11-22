import { config } from "../src/config";
import { sign } from "../src/http/hmac";

// Sends a correctly signed orders/create webhook, then the same one again, then
// a fresh delivery of the same order. Signs with the same sign() the server
// verifies with, so there is one definition of a signature.
//
//   npm run send-webhook              random order id
//   npm run send-webhook ORD-123      a specific one, to force a duplicate

const url = `${config.apiBaseUrl}/webhooks/orders-create`;

function orderPayload(orderId: string) {
  return {
    id: orderId,
    email: "customer@example.com",
    created_at: new Date().toISOString(),
    currency: "INR",
    line_items: [
      { sku: "TSHIRT-M", title: "T-shirt, medium", quantity: 2, price: "499.00" },
      { sku: "MUG", title: "Mug", quantity: 1, price: "249.00" },
    ],
    shipping_address: {
      name: "A Customer",
      address1: "12 Example Street",
      city: "Pune",
      province: "Maharashtra",
      zip: "411001",
      country_code: "IN",
    },
  };
}

async function post(label: string, webhookId: string, body: string, signature: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shop-hmac-sha256": signature,
      "x-shop-webhook-id": webhookId,
    },
    body,
  });

  console.log(`${label.padEnd(32)} ${res.status}  ${await res.text()}`);
  return res.status;
}

async function main() {
  const orderId = process.argv[2] ?? `ORD-${Date.now()}`;
  const body = JSON.stringify(orderPayload(orderId));
  const signature = sign(body, config.webhookSecret);

  console.log(`order ${orderId} -> ${url}\n`);

  const first = await post("new order", `WH-${orderId}-a`, body, signature);
  const replay = await post("same webhook id again", `WH-${orderId}-a`, body, signature);
  const resent = await post("new webhook id, same order", `WH-${orderId}-b`, body, signature);
  const tampered = await post("tampered body", `WH-${orderId}-c`, body.replace("Pune", "Mumba"), signature);

  // 200 on the first call means this order id was already stored, which happens
  // when the script is run twice with the same one. still correct.
  const ok = (first === 202 || first === 200) && replay === 200 && resent === 200 && tampered === 401;

  if (!ok) {
    console.log("\nsomething is off, see the statuses above");
    process.exitCode = 1;
  } else if (first === 200) {
    console.log(`\nall four behaved as expected (${orderId} already existed, so nothing was queued)`);
  } else {
    console.log("\nall four behaved as expected");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
