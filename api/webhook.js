export default async function handler(req, res) {
  try {
    const order = req.body;

    console.log("🧾 Shopify order received:", order.id);

    // =========================
    // ✅ CHECK RECHARGE ORDER
    // =========================
    const isRecharge =
      order.source_name === "subscription_contract" ||
      order.tags?.toLowerCase().includes("subscription");

    if (!isRecharge) {
      console.log("⏭️ Not a subscription order");
      return res.status(200).send("Not a subscription order");
    }

    // =========================
    // ✅ GET DELIVERY STRING (SHOPIFY ONLY)
    // =========================
    let deliveryString = null;

    // 1️⃣ From note_attributes
    if (order.note_attributes?.length) {
      deliveryString = order.note_attributes.find(
        a => a.name?.toLowerCase() === "delivery date"
      )?.value;
    }

    // 2️⃣ 🔥 Fallback → line item properties (Recharge safe)
    if (!deliveryString) {
      for (const item of order.line_items || []) {
        for (const prop of item.properties || []) {
          if (prop.name?.toLowerCase() === "delivery date") {
            deliveryString = prop.value;
          }
        }
      }
    }

    console.log("📦 Delivery string:", deliveryString);

    // =========================
    // ✅ EXTRACT DAY + TIME
    // =========================
    let deliveryDay = "wednesday";
    let deliveryTime = "19:00-21:00";

    if (deliveryString) {
      const extracted = extractDayAndTime(deliveryString);

      if (extracted) {
        deliveryDay = extracted.day;
        deliveryTime = extracted.time;
      }
    }

    console.log("📊 Extracted:", { deliveryDay, deliveryTime });

    // =========================
    // ✅ CALCULATE DELIVERY
    // =========================
    const finalDelivery = calculateDeliveryFromOrder(
      order,
      deliveryDay,
      deliveryTime
    );

    console.log("📅 Final delivery:", finalDelivery);

    // =========================
    // ✅ PRESERVE EXISTING ATTRIBUTES
    // =========================
    const existingAttributes = order.note_attributes || [];

    const updatedAttributes = [
      ...existingAttributes.filter(
        a => a.name?.toLowerCase() !== "delivery date"
      ),
      {
        name: "Delivery date",
        value: finalDelivery
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

//
// =========================
// ✅ EXTRACT DAY + TIME
// =========================
//

function extractDayAndTime(deliveryString) {
  try {
    // Example:
    // "Friday (19:00-21:00) - 09 April"

    const [dayTime] = deliveryString.split(" - ");

    const dayMatch = dayTime.match(/^(.*?) \(/);
    const timeMatch = dayTime.match(/\((.*?)\)/);

    const day = dayMatch?.[1]?.toLowerCase();
    const time = timeMatch?.[1];

    if (!day || !time) return null;

    return { day, time };

  } catch (err) {
    console.error("❌ Extraction failed:", err);
    return null;
  }
}

//
// =========================
// ✅ CALCULATE DELIVERY
// =========================
//

function calculateDeliveryFromOrder(order, deliveryDay, deliveryTime) {
  const createdAt = new Date(order.created_at);

  const daysMap = {
    wednesday: 3,
    thursday: 4,
    friday: 5
  };

  const dayNames = {
    wednesday: "Wednesday",
    thursday: "Thursday",
    friday: "Friday"
  };

  const targetDay = daysMap[deliveryDay] || 3;

  const deliveryDate = getNextWeekday(createdAt, targetDay);

  const formattedDate = deliveryDate.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "long"
  });

  return `${dayNames[deliveryDay]} (${deliveryTime}) - ${formattedDate}`;
}

//
// =========================
// ✅ HELPER
// =========================
//

function getNextWeekday(date, targetDay) {
  const d = new Date(date);
  const current = d.getDay();

  let diff = (targetDay - current + 7) % 7;
  if (diff === 0) diff = 7;

  d.setDate(d.getDate() + diff);
  return d;
}