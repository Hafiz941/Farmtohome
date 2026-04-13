import axios from "axios";
import crypto from "crypto";

// 🔐 ENV VARIABLES (set in Vercel)
const RECHARGE_API_KEY = process.env.RECHARGE_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// 🛑 Disable default body parser (needed for HMAC verification)
export const config = {
  api: {
    bodyParser: false,
  },
};

// 🔧 Helper: get raw body
async function getRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

// 🔐 Verify Shopify webhook
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const generatedHash = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  return generatedHash === hmacHeader;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end("Method Not Allowed");
  }

  try {
    // 🧾 Read raw body
    const rawBody = await getRawBody(req);

    const hmacHeader = req.headers["x-shopify-hmac-sha256"];

    // 🔐 Verify request
    const isValid = verifyShopifyWebhook(rawBody, hmacHeader);

    if (!isValid) {
      console.error("❌ Invalid Shopify webhook");
      return res.status(401).send("Unauthorized");
    }

    // 📦 Parse JSON
    const product = JSON.parse(rawBody.toString());

    console.log("📦 Product update received:", product.id);

    // 🔍 Check if product is inactive
    const isInactive =
      product.status === "archived" ||
      product.status === "draft";

    if (!isInactive) {
      console.log("✅ Product still active, skipping...");
      return res.status(200).json({ message: "Product active" });
    }

    console.log("🚨 Inactive product detected:", product.id);

    // 🔁 Process Recharge
    await processRecharge(product);

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("🔥 ERROR:", error.response?.data || error.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

// 🔁 MAIN LOGIC
async function processRecharge(product) {
  let hasNext = true;
  let page = 1;

  while (hasNext) {
    const response = await axios.get(
      "https://api.rechargeapps.com/subscriptions",
      {
        headers: {
          "X-Recharge-Access-Token": RECHARGE_API_KEY,
        },
        params: {
          shopify_product_id: product.id,
          limit: 250,
          page: page,
        },
      }
    );

    const subscriptions = response.data.subscriptions || [];

    console.log(`📊 Page ${page}: ${subscriptions.length} subscriptions`);

    if (subscriptions.length === 0) {
      hasNext = false;
      break;
    }

    for (const sub of subscriptions) {
      await handleSubscription(sub, product);
    }

    page++;
  }
}

// ⚙️ HANDLE EACH SUBSCRIPTION
async function handleSubscription(sub, product) {
  const subscriptionId = sub.id;
  const email = sub.customer_email;

  console.log("🔄 Processing subscription:", subscriptionId);

  try {
    // 🔴 OPTION: Remove subscription
    await axios.delete(
      `https://api.rechargeapps.com/subscriptions/${subscriptionId}`,
      {
        headers: {
          "X-Recharge-Access-Token": RECHARGE_API_KEY,
        },
      }
    );

    console.log(`❌ Removed subscription ${subscriptionId}`);

    // 📩 Notify customer
    await sendEmail(email, product.title);

  } catch (err) {
    console.error(
      `⚠️ Failed for sub ${subscriptionId}:`,
      err.response?.data || err.message
    );
  }
}

// 📩 EMAIL (Replace with Klaviyo / Mailchimp)
async function sendEmail(email, productName) {
  console.log(`📧 Email sent to ${email} for product "${productName}"`);

  // 👉 Example: integrate Klaviyo here
  /*
  await axios.post("https://a.klaviyo.com/api/events", {
    data: {
      type: "event",
      attributes: {
        profile: { email },
        metric: { name: "Subscription Product Removed" },
        properties: {
          product_name: productName,
        },
      },
    },
  });
  */
}