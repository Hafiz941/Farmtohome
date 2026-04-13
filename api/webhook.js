export default async function handler(req, res) {
    if (req.method !== "POST") {
      return res.status(405).end();
    }
  
    const charge = req.body;
  
    // ✅ Extract data
    const chargeDate = charge.scheduled_at;
  
    const deliveryDay =
      charge.line_items?.[0]?.properties?.delivery_day;
  
    const deliveryTime =
      charge.line_items?.[0]?.properties?.delivery_time;
  
    if (!deliveryDay || !deliveryTime) {
      return res.status(200).end();
    }
  
    // ✅ YOUR LOGIC
    function getDeliveryDate(orderDate, selectedDay) {
      const date = new Date(orderDate);
      const day = date.getDay();
  
      const daysMap = {
        wednesday: 3,
        thursday: 4,
        friday: 5
      };
  
      const targetDay = daysMap[selectedDay];
  
      let delivery = new Date(date);
      const diff = (targetDay - day + 7) % 7;
  
      delivery.setDate(date.getDate() + diff);
  
      // Always next week
      delivery.setDate(delivery.getDate() + 7);
  
      // Tuesday rule
      if (day === 2) {
        delivery.setDate(delivery.getDate() + 7);
      }
  
      return delivery;
    }
  
    const finalDate = getDeliveryDate(chargeDate, deliveryDay);
  
    // ✅ Format string
    const dayNames = {
      wednesday: "Wednesday",
      thursday: "Thursday",
      friday: "Friday"
    };
  
    const formattedDate = finalDate.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "long"
    });
  
    const finalDelivery =
      `${dayNames[deliveryDay]} (${deliveryTime}) - ${formattedDate}`;
  
    console.log("Final:", finalDelivery);
  
    // ✅ UPDATE SHOPIFY ORDER
    await fetch(`https://YOUR-STORE.myshopify.com/admin/api/2024-01/orders/${charge.shopify_order_id}.json`, {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": "YOUR_ADMIN_API_TOKEN",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        order: {
          id: charge.shopify_order_id,
          note_attributes: [
            {
              name: "Delivery date",
              value: finalDelivery
            }
          ]
        }
      })
    });
  
    res.status(200).json({ success: true });
  }