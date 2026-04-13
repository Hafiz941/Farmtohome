export default async function handler(req, res) {
    try {
      const order = req.body;
  
      console.log("Shopify order received:", order.id);
  
      // ✅ Better Recharge detection
      const isRecharge =
        order.source_name === "subscription_contract" ||
        order.tags?.toLowerCase().includes("subscription");
  
      if (!isRecharge) {
        return res.status(200).send("Not a subscription order");
      }
  
      // ✅ Calculate delivery date
      const deliveryDate = getDeliveryDate();
  
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
              { name: "Delivery date", value: deliveryDate }
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
     DELIVERY DATE LOGIC
  ========================= */
  
  function getDeliveryDate() {
    const today = new Date();
    const day = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  
    let addWeeks = 0;
  
    // 👉 YOUR RULE
    if (day === 2) {
      // Tuesday → skip next week
      addWeeks = 2;
    } else {
      // Wed → Mon → next week
      addWeeks = 1;
    }
  
    // 👉 Always base from next Wednesday
    const nextWednesday = getNextWeekday(today, 3); // 3 = Wed
  
    nextWednesday.setDate(nextWednesday.getDate() + (addWeeks - 1) * 7);
  
    return formatDate(nextWednesday);
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
  
  function formatDate(d) {
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric"
    });
  }