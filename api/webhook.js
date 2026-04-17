export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).end();
    }

    // =========================
    // ✅ TOPIC CHECK
    // =========================
    const topic = req.headers["x-shopify-topic"];
    console.log("📢 Webhook topic:", topic);

    const allowedTopics = ["orders/create", "orders/paid"];

    if (!allowedTopics.includes(topic)) {
      console.log("⏭️ Ignored topic:", topic);
      return res.status(200).end();
    }

    // =========================
    // ✅ GET ORDER
    // =========================
    const order = req.body;

    if (!order?.id) {
      console.log("⏭️ Invalid order payload");
      return res.status(200).end();
    }

    console.log("🧾 Shopify order received:", order.id);

    // =========================
    // ✅ PREVENT DUPLICATES
    // =========================
    const alreadyProcessed = order.note_attributes?.some(
      attr => attr.name === "Processed-By"
    );

    if (alreadyProcessed) {
      console.log("⏭️ Already processed order:", order.id);
      return res.status(200).end();
    }

    // =========================
    // ✅ CHECK RECHARGE ORDER
    // =========================
    const isRecharge =
      order.source_name === "subscription_contract" ||
      order.tags?.toLowerCase().includes("subscription") ||
      order.line_items?.some(item => item.selling_plan_allocation);

    if (!isRecharge) {
      console.log("⏭️ Not a subscription order");
      return res.status(200).end();
    }

    // =========================
    // ✅ GET DELIVERY STRING
    // =========================
    let deliveryString = null;

    if (order.note_attributes?.length) {
      deliveryString = order.note_attributes.find(
        a => a.name?.toLowerCase() === "delivery date"
      )?.value;
    }

    if (!deliveryString) {
      for (const item of order.line_items || []) {
        for (const prop of item.properties || []) {
          if (prop.name?.toLowerCase() === "delivery date") {
            deliveryString = prop.value;
          }
        }
      }
    }

    if (!deliveryString) {
      console.log("❌ No delivery string found");
      return res.status(200).end();
    }

    console.log("📦 Delivery string:", deliveryString);

    // =========================
    // ✅ EXTRACT DELIVERY INFO
    // =========================
    const extracted = extractDeliveryInfo(deliveryString);

    if (!extracted) {
      console.log("❌ Failed to parse delivery string");
      return res.status(200).end();
    }

    console.log("📊 Extracted:", extracted);

    // =========================
    // ✅ CALCULATE NEXT DELIVERY DATE (KEY FIX)
    // =========================
    const nextDate = getNextWeekday(
      new Date(order.created_at),
      extracted.day.toLowerCase()
    );

    const formattedDate = nextDate.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    });

    const finalDelivery = `${extracted.day} (${extracted.time}) - ${formattedDate}`;

    console.log("📅 Final delivery:", finalDelivery);

    // =========================
    // ✅ UPDATE ATTRIBUTES
    // =========================
    const existingAttributes = order.note_attributes || [];

    const updatedAttributes = [
      ...existingAttributes.filter(
        a => a.name?.toLowerCase() !== "delivery date"
      ),
      {
        name: "Delivery date",
        value: finalDelivery
      },
      {
        name: "Processed-By",
        value: "middleware"
      }
    ];

    // =========================
    // ✅ UPDATE SHOPIFY ORDER
    // =========================
    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/orders/${order.id}.json`,
      {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          order: {
            id: order.id,
            note_attributes: updatedAttributes
          }
        })
      }
    );

    const data = await response.json();
    console.log("✅ Shopify updated:", data);

    return res.status(200).send("Updated");

  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).send("Error");
  }
}

// =========================
// ✅ EXTRACT DELIVERY INFO
// =========================
function extractDeliveryInfo(deliveryString) {
  try {
    const [dayTime, datePart] = deliveryString.split(" - ");

    const dayMatch = dayTime.match(/^(.*?) \(/);
    const timeMatch = dayTime.match(/\((.*?)\)/);

    const day = dayMatch?.[1]?.trim();
    const time = timeMatch?.[1]?.trim();
    const date = datePart?.trim();

    if (!day || !time || !date) return null;

    return { day, time, date };

  } catch (err) {
    console.error("❌ Extraction failed:", err);
    return null;
  }
}

// =========================
// ✅ GET NEXT WEEKDAY
// =========================
function getNextWeekday(date, targetDayName) {
  const daysMap = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };

  const targetDay = daysMap[targetDayName];
  const d = new Date(date);

  let diff = (targetDay - d.getDay() + 7) % 7;
  if (diff === 0) diff = 7;

  d.setDate(d.getDate() + diff);
  return d;
}