import axios from "axios";
import crypto from "crypto";

// ================= ENV =================
const SHOPIFY_API_VERSION = "2024-01";

const RECHARGE_API_KEY = process.env.RECHARGE_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

// ================= CACHE =================
let productCache = null;
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min

// ================= CONFIG =================
export const config = {
  api: { bodyParser: false },
};

// ================= RAW BODY =================
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ================= VERIFY WEBHOOK =================
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const hash = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  return hash === hmacHeader;
}
// ================= TAG HELPERS =================
function extractTags(tagString = "") {
  if (!tagString) return [];
  
  return tagString
    .split(",")
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

// ================= SMART MATCH =================
function findBestMatch(products, currentProduct) {
  const currentTags = extractTags(currentProduct.tags);

  let bestMatch = null;
  let bestScore = 0;

  for (const p of products) {
    if (p.status !== "active" || p.id === currentProduct.id) continue;

    const candidateTags = extractTags(p.tags);

    // 🎯 Case 1: both have tags → score match
    if (currentTags.length && candidateTags.length) {
      const score = currentTags.filter(tag =>
        candidateTags.includes(tag)
      ).length;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = p;
      }
    }

    // 🎯 Case 2: fallback (no tags anywhere)
    if (!currentTags.length && !candidateTags.length && !bestMatch) {
      bestMatch = p;
    }
  }

  // 🎯 FINAL FALLBACK (VERY IMPORTANT)
  if (!bestMatch) {
    console.log("⚠️ No tag match → using fallback product");

    bestMatch = products.find(p =>
      p.status === "active" && p.id !== currentProduct.id
    );
  }

  return bestMatch;
}

// ================= PRODUCT FETCH (CACHED + PAGINATION) =================
async function getProducts() {
  console.log("👉 STORE:", SHOPIFY_STORE);
  console.log("👉 TOKEN exists:", !!SHOPIFY_ACCESS_TOKEN);
  console.log("👉 TOKEN preview:", SHOPIFY_ACCESS_TOKEN?.slice(0, 8));
  const now = Date.now();
  
  if (productCache && now - lastFetchTime < CACHE_TTL) {
    console.log("⚡ Using cached products");
    return productCache;
  }

  console.log("🔄 Fetching products from Shopify");

  let allProducts = [];
  let url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`;

  while (url) {
    const res = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
      timeout: 10000,
    });

    allProducts.push(...res.data.products);

    const link = res.headers.link;

    if (link && link.includes('rel="next"')) {
      url = link.split(";")[0].replace("<", "").replace(">", "");
    } else {
      url = null;
    }
  }

  console.log(`✅ Cached ${allProducts.length} products`);

  productCache = allProducts;
  lastFetchTime = now;

  return allProducts;
}

// ================= MAIN HANDLER =================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const rawBody = await getRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];

    if (!hmac) {
      return res.status(401).send("Missing HMAC");
    }

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
    console.error("❌ Webhook error:", err);
    res.status(500).end();
  }
}

// ================= PROCESS RECHARGE =================
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

// ================= SWAP =================
async function swapSubscription(sub, product) {
  console.log("🔄 Swapping sub:", sub.id);

  try {
    const replacement = await findReplacementProduct(product);

    if (!replacement) {
      console.log("❌ No replacement found");
      return;
    }

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

    console.log(`✅ Swapped → ${replacement.title}`);

  } catch (err) {
    console.error("❌ Swap failed:", err.response?.data || err.message);
  }
}

// ================= FIND REPLACEMENT =================
async function findReplacementProduct(product) {
  try {
    const products = await getProducts();

    const match = findBestMatch(products, product);

    if (!match) return null;

    return {
      product_id: match.id,
      variant_id: match.variants[0]?.id,
      title: match.title,
    };

  } catch (err) {
    console.error("❌ Matching error:", err.message);
    return null;
  }
}