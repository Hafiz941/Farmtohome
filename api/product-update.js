import axios from "axios";
import crypto from "crypto";
import nodemailer from "nodemailer";

// ================= ENV =================
const SHOPIFY_API_VERSION = "2024-01";
const RECHARGE_API_KEY = process.env.RECHARGE_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const delay = (ms) => new Promise(res => setTimeout(res, ms));
const notifiedCustomers = new Set();

// ================= EMAIL SETUP =================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

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

const CATEGORY_PRIORITY = [
  "meat",
  "fish",
  "vegetariano e vegan",
  "functional soups",
  "addons",
  "meat & fish"
];

function getPrimaryCategory(tags = []) {
  for (const category of CATEGORY_PRIORITY) {
    if (tags.includes(category)) {
      return category;
    }
  }
  return null;
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
        "X-Shopify-Access-Token": String(SHOPIFY_ACCESS_TOKEN).trim(),
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

    // 🔐 Verify webhook
    if (!hmac) {
      return res.status(401).send("Missing HMAC");
    }

    if (!verifyShopifyWebhook(rawBody, hmac)) {
      return res.status(401).send("Unauthorized");
    }

    const product = JSON.parse(rawBody.toString());

    // 🎯 Only process inactive products
    const isInactive =
      product.status === "archived" ||
      product.status === "draft";

    if (!isInactive) return res.status(200).end();

    console.log("🚨 Inactive product:", product.title);

    // ✅ STEP 1 — Find replacement ONCE
    const replacement = await findReplacementProduct(product);

    if (!replacement) {
      console.log("❌ No category product → removing + notifying");
    
      await processRemovalOnly(product);
      await removeFromQueuedOrders(product);
    
      return res.status(200).json({ removed: true });
    }

    // ✅ STEP 2 — Update all subscriptions
    await processRecharge(product, replacement);

    // ✅ STEP 3 — Update future queued orders
    await updateQueuedOrders(product, replacement);

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).end();
  }
}

async function processRemovalOnly(product) {
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
          status: "ACTIVE",
          limit: 250,
          page,
        },
      }
    );

    const subs = res.data.subscriptions || [];
    if (!subs.length) break;

    for (const sub of subs) {
      console.log(`⚠️ NOT deleting subscription ${sub.id}`);

      // ✅ ONLY SEND EMAIL
      if (sub.email && !notifiedCustomers.has(sub.email)) {
        const category =
          getPrimaryCategory(extractTags(product.tags)) || "this category";

        await sendRemovalEmail(
          sub.email,
          sub.product_title,
          category
        );

        notifiedCustomers.add(sub.email);
      }

      await delay(200);
    }

    page++;
  }
}

async function removeFromQueuedOrders(product) {
  let page = 1;

  while (true) {
    const res = await axios.get(
      "https://api.rechargeapps.com/orders",
      {
        headers: {
          "X-Recharge-Access-Token": RECHARGE_API_KEY,
        },
        params: {
          status: "QUEUED",
          limit: 250,
          page,
        },
      }
    );

    const orders = res.data.orders || [];
    if (!orders.length) break;

    for (const order of orders) {
      let updated = false;

      const newLineItems = order.line_items.filter(item => {
        if (String(item.shopify_product_id) === String(product.id)) {
          updated = true;
          return false; // remove item
        }
        return true;
      });

      if (updated) {
        await axios.put(
          `https://api.rechargeapps.com/orders/${order.id}`,
          { line_items: newLineItems },
          {
            headers: {
              "X-Recharge-Access-Token": RECHARGE_API_KEY,
            },
          }
        );

        console.log(`🗑️ Removed from order ${order.id}`);
        await delay(200);
      }
    }

    page++;
  }
}
// ================= SEND EMAIL =================
async function sendEmailNotification(email, oldProduct, newProduct) {
  try {
    await transporter.sendMail({
      from: `"Farm to Home" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Update to Your Subscription",
      html: `
        <p>Hello,</p>

        <p>We’ve updated one of your subscription item:</p>

        <p><strong>${oldProduct}</strong></p>

        <p>It has been replaced with:</p>

        <p><strong>${newProduct}</strong></p>

        <p>
          You can manage your subscription here:
          <br/>
          <a href="https://farmtohome.pt/account/login">
            Manage your subscription
          </a>
        </p>

        <p>Thanks 💚</p>
      `,
    });

    console.log("📧 Email sent to", email);
  } catch (err) {
    console.error("❌ Email failed:", err.message);
  }
}

async function sendRemovalEmail(email, dishName, category) {
  await transporter.sendMail({
    from: `"Farm to Home" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Update to Your Subscription",
    html: `
      <p>Hello,</p>

      <p>We wanted to inform you that <strong>${dishName}</strong> has been removed from your upcoming subscription orders as it is no longer available in its category (${category}).</p>

      <p>At the moment, we do not have any dish available in this category.</p>

      <p>
        If you would like to add another dish, you can simply log in to your account and update your subscription:
        <br/>
        <a href="https://farmtohome.pt/account/login">
          Manage your subscription
        </a>
      </p>

      <p>Thank you 💚</p>
    `,
  });
}
// ================= PROCESS RECHARGE =================
async function processRecharge(product, replacement) {
  let page = 1;

  if (!replacement) {
    console.log("❌ No replacement found for any subscription");
    return;
  }

  while (true) {
    const res = await axios.get(
      "https://api.rechargeapps.com/subscriptions",
      {
        headers: {
          "X-Recharge-Access-Token": RECHARGE_API_KEY,
        },
        params: {
          shopify_product_id: product.id,
          status: "ACTIVE", // 🔥 filter directly
          limit: 250,
          page,
        }
      }
    );

    const subs = res.data.subscriptions || [];
    if (!subs.length) break;
    for (const sub of subs) {
      if (String(sub.shopify_product_id) !== String(product.id)) {
        continue;
      }
    
      if (sub.status !== "ACTIVE") {
        console.log(`⏭️ Skipping non-active sub ${sub.id} (${sub.status})`);
        continue;
      }
    
      await swapSubscription(sub, replacement);
      // ✅ SEND EMAIL (only once per customer)
      const customerEmail = sub.email;
      console.log("📩 Subscription email:", sub.email);
      if (
        customerEmail &&
        !notifiedCustomers.has(customerEmail)
      ) {
        await sendEmailNotification(
          customerEmail,
          sub.product_title,
          replacement.title
        );

        notifiedCustomers.add(customerEmail);
      }
      await delay(200);
    }
    page++;
  }
}

// ================= UPDATE FUTURE ORDERS =================
async function updateQueuedOrders(product, replacement) {
  try {
    let page = 1;

    while (true) {
      const res = await axios.get(
        "https://api.rechargeapps.com/orders",
        {
          headers: {
            "X-Recharge-Access-Token": RECHARGE_API_KEY,
          },
          params: {
            status: "QUEUED",
            limit: 250,
            page,
          },
        }
      );

      const orders = res.data.orders || [];
      if (!orders.length) break;

      for (const order of orders) {
        let updated = false;
        const targetId = String(product.id);
        const newLineItems = order.line_items.map(item => {
            if (String(item.shopify_product_id) === targetId) {
            updated = true;

            console.log(`🔄 Updating order ${order.id}`);

            return {
              ...item,
              shopify_product_id: replacement.product_id,
              shopify_variant_id: replacement.variant_id,
              quantity: item.quantity, // 🔥 explicit safety
            };
          }
          return item;
        });

        if (updated) {
          await axios.put(
            `https://api.rechargeapps.com/orders/${order.id}`,
            {
              line_items: newLineItems,
            },
            {
              headers: {
                "X-Recharge-Access-Token": RECHARGE_API_KEY,
              },
            }
          );

          await delay(200); // 🔥 add this
          console.log(`✅ Updated queued order ${order.id}`);
        }
      }

      page++;
    }

  } catch (err) {
    console.error("❌ Failed updating queued orders:", err.response?.data || err.message);
  }
}

// ================= SWAP =================
async function swapSubscription(sub, replacement) {
  console.log("🔄 Swapping sub:", sub.id);

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      await axios.put(
        `https://api.rechargeapps.com/subscriptions/${sub.id}`,
        {
          shopify_product_id: replacement.product_id,
          shopify_variant_id: replacement.variant_id,
          quantity: sub.quantity, // 🔥 preserve quantity
        },
        {
          headers: {
            "X-Recharge-Access-Token": RECHARGE_API_KEY,
          },
        }
      );
      await delay(200); // 🔥 add this
      console.log(`✅ Subscription swapped → ${replacement.title}`);
      return;

    } catch (err) {
      const errorMsg = err.response?.data?.error || err.message;

      if (errorMsg?.includes("already in progress")) {
        console.log(`⏳ Retry ${attempts + 1} for sub ${sub.id}`);
        await delay(300);
        attempts++;
      } else {
        console.error("❌ Swap failed:", err.response?.data || err.message);
        return;
      }
    }
  }

  console.error(`❌ Failed after retries for sub ${sub.id}`);
}
// ================= FIND REPLACEMENT =================
async function findReplacementProduct(product) {
  try {
    const products = await getProducts();

    const currentTags = extractTags(product.tags);
    const currentCategory = getPrimaryCategory(currentTags);

    if (!currentCategory) {
      console.log("❌ No valid category tag found");
      return null;
    }

    // ✅ STEP 1: filter SAME CATEGORY
    const sameCategoryProducts = products.filter(p => {
      if (p.status !== "active" || p.id === product.id) return false;

      const tags = extractTags(p.tags);
      const category = getPrimaryCategory(tags);

      return category === currentCategory;
    });

    if (!sameCategoryProducts.length) {
      console.log("❌ No product in same category:", currentCategory);
      return null;
    }

    // ✅ STEP 2: best tag match
    let bestMatch = null;
    let bestScore = -1;

    for (const p of sameCategoryProducts) {
      const tags = extractTags(p.tags);

      const filteredCurrentTags = currentTags.filter(t => t !== currentCategory);
      const filteredTags = tags.filter(t => t !== currentCategory);

      const score = filteredCurrentTags.filter(tag =>
        filteredTags.includes(tag)
      ).length;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = p;
      }
      
      // 🔥 Early exit if perfect match found
      if (bestScore === filteredCurrentTags.length) {
        break;
      }
    }

    if (!bestMatch || !bestMatch.variants?.length) {
      return null;
    }

    return {
      product_id: bestMatch.id,
      variant_id: bestMatch.variants[0].id,
      title: bestMatch.title,
    };

  } catch (err) {
    console.error("❌ Matching error:", err.message);
    return null;
  }
}