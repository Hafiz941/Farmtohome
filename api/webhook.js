export default async function handler(req, res) {
    try {
      const order = req.body;
  
      console.log("Shopify order received:", order.id);
  
      // ✅ Detect Recharge subscription order
      const isRecharge =
        order.source_name === "subscription_contract" ||
        order.tags?.toLowerCase().includes("subscription");
  
      if (!isRecharge) {
        return res.status(200).send("Not a subscription order");
      }
  
      // ✅ Extract delivery info from original order
      const attributes = order.note_attributes || [];
  
      const deliveryDay =
        attributes.find(a => a.name === "delivery_day")?.value;
  
      const deliveryTime =
        attributes.find(a => a.name === "delivery_time")?.value;
  
      // ✅ Fallback (for old subscriptions)
      const finalDelivery = calculateNextDelivery(
        (deliveryDay || "wednesday").toLowerCase(),
        deliveryTime || "19:00-21:00"
      );
  
      console.log("Final Delivery:", finalDelivery);
  
      // ✅ Update Shopify order
      await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2023-10/orders/${order.id}.json`, {
        method: "PUT",
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          order: {
            id: order.id,
            note_attributes: [
              {
                name: "Delivery date",
                value: finalDelivery
              }
            ]
          }
        })
      });
  
      res.status(200).send("Updated");
  
    } catch (err) {
      console.error("Webhook error:", err);
      res.status(500).send("Error");
    }
  }
  
  
  /* =========================
     DELIVERY LOGIC
  ========================= */
  
  function calculateNextDelivery(day, time) {
    const today = new Date();
    const currentDay = today.getDay(); // 0=Sun ... 6=Sat
  
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
  
    const targetDay = daysMap[day] || 3; // default Wednesday
  
    // ✅ YOUR BUSINESS RULE
    let addWeeks = (currentDay === 2) ? 2 : 1;
  
    // ✅ Get next target weekday
    let deliveryDate = getNextWeekday(today, targetDay);
  
    // ✅ Apply week offset
    deliveryDate.setDate(
      deliveryDate.getDate() + (addWeeks - 1) * 7
    );
  
    const formattedDate = deliveryDate.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "long"
    });
  
    return `${dayNames[day]} (${time}) - ${formattedDate}`;
  }
  
  
  /* =========================
     HELPERS
  ========================= */
  
  function getNextWeekday(date, targetDay) {
    const d = new Date(date);
    const current = d.getDay();
  
    let diff = (targetDay - current + 7) % 7;
  
    if (diff === 0) diff = 7;
  
    d.setDate(d.getDate() + diff);
  
    return d;
  }