import axios from "axios";
import crypto from "crypto";

// ENV
const RECHARGE_API_KEY = process.env.RECHARGE_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

console.log("STORE:", SHOPIFY_STORE);
console.log("TOKEN exists:", !!SHOPIFY_ACCESS_TOKEN);
// Disable body parser
export const config = {
  api: { bodyParser: false },
};

// Raw body
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Verify webhook
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const hash = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  return hash === hmacHeader;
}

// MAIN
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const rawBody = await getRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];

    if (!verifyShopifyWebhook(rawBody, hmac)) {
      return res.status(401).send("Unauthorized");
    }

    const product = JSON.parse(rawBody.toString());

    const isInactive =
      product.status === "archived" ||
      product.status === "draft";

    if (!isInactive) return res.status(200).end();

    console.log("🚨 Inactive product:", product.title);

    await processRecharge(product);

    res.status(200).json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
}

// 🔁 Process subscriptions
async function processRecharge(product) {
  let page = 1;

  while (true) {
    const res = await axios.get(
      "https://api.rechargeapps.com/subscriptions",
      {
        headers: {
          "X-Recharge-Access-Token": RECHARGE_API_KEY,
        },
        params: {
          shopify_product_id: product.id,
          limit: 250,
          page,
        },
      }
    );

    const subs = res.data.subscriptions || [];
    if (!subs.length) break;

    for (const sub of subs) {
      await swapSubscription(sub, product);
    }

    page++;
  }
}

// 🔁 SWAP LOGIC
async function swapSubscription(sub, product) {
  console.log("🔄 Swapping sub:", sub.id);

  try {
    // 1. Find replacement product
    const replacement = await findReplacementProduct(product);

    if (!replacement) {
      console.log("❌ No replacement found → skipping");
      return;
    }

    // 2. Update subscription
    await axios.put(
      `https://api.rechargeapps.com/subscriptions/${sub.id}`,
      {
        shopify_product_id: replacement.product_id,
        shopify_variant_id: replacement.variant_id,
      },
      {
        headers: {
          "X-Recharge-Access-Token": RECHARGE_API_KEY,
        },
      }
    );

    console.log(`✅ Swapped to ${replacement.title}`);

  } catch (err) {
    console.error("❌ Swap failed:", err.response?.data || err.message);
  }
}

// 🔍 Find replacement from Shopify
async function findReplacementProduct(product) {
  try {
    console.log("STORE:", SHOPIFY_STORE);
    console.log("TOKEN exists:", !!SHOPIFY_ACCESS_TOKEN);
    console.log("TOKEN preview:", SHOPIFY_ACCESS_TOKEN?.slice(0, 10));
    const tags = product.tags; // e.g. "vegan,pescatarian"

    const res = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2023-10/products.json`,
      {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        },
        params: {
          limit: 50,
        },
      }
    );

    const products = res.data.products;

    // find product with same tag but active
    const match = products.find(p =>
      p.status === "active" &&
      p.id !== product.id &&
      tags.split(",").some(tag => p.tags.includes(tag))
    );

    if (!match) return null;

    return {
      product_id: match.id,
      variant_id: match.variants[0].id,
      title: match.title,
    };

  } catch (err) {
    console.error("❌ Shopify fetch error", err.message);
    return null;
  }
}