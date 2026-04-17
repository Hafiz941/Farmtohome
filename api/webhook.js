export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).end();

    const topic = req.headers["x-shopify-topic"];

    // ✅ ONLY orders/create
    if (topic !== "orders/create") {
      console.log("⏭️ Ignored topic:", topic);
      return res.status(200).end();
    }

    console.log("🔥 WEBHOOK HIT:", topic);

    const order = req.body;

    console.log("🧾 Shopify order received:", order.id);

    // ✅ STRICT Recharge only
    const isRecharge =
      order.source_name === "subscription_contract";

    if (!isRecharge) {
      console.log("⏭️ Not a subscription order");
      return res.status(200).send("Not a subscription order");
    }

    // ✅ LOOP PREVENTION
    const alreadyProcessed = order.note_attributes?.some(
      attr => attr.name === "Processed-By"
    );

    if (alreadyProcessed) {
      console.log("⏭️ Already processed order");
      return res.status(200).end();
    }

    // ================= DELIVERY =================
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

    let deliveryDay = "wednesday";
    let deliveryTime = "19:00-21:00";

    if (deliveryString) {
      const extracted = extractDayAndTime(deliveryString);
      if (extracted) {
        deliveryDay = extracted.day;
        deliveryTime = extracted.time;
      }
    }

    const finalDelivery = calculateDeliveryFromOrder(
      order,
      deliveryDay,
      deliveryTime
    );

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

    await fetch(
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

    console.log("✅ Shopify updated:", order.id);

    return res.status(200).send("Updated");

  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).send("Error");
  }
}

// ================= HELPERS =================
function extractDayAndTime(deliveryString) {
  try {
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

function getNextWeekday(date, targetDay) {
  const d = new Date(date);
  const current = d.getDay();

  let diff = (targetDay - current + 7) % 7;
  if (diff === 0) diff = 7;

  d.setDate(d.getDate() + diff);
  return d;
}