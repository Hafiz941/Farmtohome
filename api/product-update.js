import axios from "axios";
import crypto from "crypto";
import nodemailer from "nodemailer";

// ================= ENV =================
const SHOPIFY_API_VERSION = "2024-01";
const RECHARGE_API_KEY = process.env.RECHARGE_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;

// ================= HELPERS =================
const delay = (ms) => new Promise(res => setTimeout(res, ms));
const notifiedCustomers = new Set();

// ⚠️ In-memory cache (NOTE: resets on Vercel cold start)
const productStatusCache = new Map();
const processedProducts = new Set();

// ================= EMAIL =================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

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

// ================= VERIFY =================
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const hash = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  return hash === hmacHeader;
}

// ================= TAGS =================
function extractTags(tagString = "") {
  return tagString
    .split(",")
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

// ================= MATCH =================
function findBestMatch(products, currentProduct) {
  const currentTags = extractTags(currentProduct.tags);

  let bestMatch = null;
  let bestScore = 0;

  for (const p of products) {
    if (p.status !== "active" || p.id === currentProduct.id) continue;

    const candidateTags = extractTags(p.tags);

    const score = currentTags.filter(tag =>
      candidateTags.includes(tag)
    ).length;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = p;
    }
  }

  return bestMatch;
}

// ================= PRODUCTS CACHE =================
let productCache = null;
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getProducts() {
  const now = Date.now();

  if (productCache && now - lastFetchTime < CACHE_TTL) {
    return productCache;
  }

  let allProducts = [];
  let url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`;

  while (url) {
    const res = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
    });

    allProducts.push(...res.data.products);

    const link = res.headers.link;
    url = link?.includes('rel="next"')
      ? link.split(";")[0].replace(/[<>]/g, "")
      : null;
  }

  productCache = allProducts;
  lastFetchTime = now;

  return allProducts;
}

// ================= MAIN =================
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  try {
    const topic = req.headers["x-shopify-topic"];

    if (topic !== "products/update") {
      return res.status(200).end();
    }

    const rawBody = await getRawBody(req);
    const hmac = req.headers["x-shopify-hmac-sha256"];

    if (!verifyShopifyWebhook(rawBody, hmac)) {
      return res.status(401).send("Unauthorized");
    }

    const product = JSON.parse(rawBody.toString());

    if (!product?.id) return res.status(200).end();

    // ================= STATUS TRANSITION CHECK =================
    const previousStatus = productStatusCache.get(product.id);
    const currentStatus = product.status;

    productStatusCache.set(product.id, currentStatus);

    if (!previousStatus) {
      console.log("⏭️ First time, skipping:", product.title);
      return res.status(200).end();
    }

    const becameInactive =
      previousStatus === "active" &&
      (currentStatus === "draft" || currentStatus === "archived");

    if (!becameInactive) {
      return res.status(200).end();
    }

    // ================= DUPLICATE PROTECTION =================
    if (processedProducts.has(product.id)) {
      return res.status(200).end();
    }
    processedProducts.add(product.id);

    console.log("🚨 Product became inactive:", product.title);

    const replacement = await findReplacementProduct(product);
    if (!replacement) return res.status(200).end();

    await processRecharge(product, replacement);

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("❌ Error:", err);
    return res.status(500).end();
  }
}

// ================= REPLACEMENT =================
async function findReplacementProduct(product) {
  const products = await getProducts();
  const match = findBestMatch(products, product);

  if (!match?.variants?.length) return null;

  return {
    product_id: match.id,
    variant_id: match.variants[0].id,
    title: match.title,
  };
}

// ================= EMAIL =================
async function sendEmailNotification(email, oldProduct, newProduct) {
  await transporter.sendMail({
    from: `"Farm to Home" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Subscription Update",
    html: `<p>${oldProduct} → ${newProduct}</p>`,
  });
}

// ================= RECHARGE =================
async function processRecharge(product, replacement) {
  let page = 1;

  while (true) {
    const res = await axios.get(
      "https://api.rechargeapps.com/subscriptions",
      {
        headers: { "X-Recharge-Access-Token": RECHARGE_API_KEY },
        params: {
          shopify_product_id: product.id,
          status: "ACTIVE",
          limit: 250,
          page,
        },
      }
    );

    const subs = res.data.subscriptions || [];
    if (!subs.length) break;

    for (const sub of subs) {
      await axios.put(
        `https://api.rechargeapps.com/subscriptions/${sub.id}`,
        {
          shopify_product_id: replacement.product_id,
          shopify_variant_id: replacement.variant_id,
        },
        {
          headers: { "X-Recharge-Access-Token": RECHARGE_API_KEY },
        }
      );

      const email = sub.email || sub.customer?.email;

      if (email && !notifiedCustomers.has(email)) {
        await sendEmailNotification(
          email,
          sub.product_title,
          replacement.title
        );
        notifiedCustomers.add(email);
      }

      await delay(200);
    }

    page++;
  }
}