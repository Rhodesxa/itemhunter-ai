const express = require('express');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI (uses environment variable OPENAI_API_KEY)
const openai = new OpenAI();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Persistent storage file for orders
const ORDERS_FILE = path.join(__dirname, 'orders.json');

function loadOrders() {
    try {
        if (fs.existsSync(ORDERS_FILE)) {
            return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
        }
    } catch (e) {}
    return [];
}

function saveOrders(orders) {
    try {
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    } catch (e) {}
}

// API: Get all orders for the staff portal
app.get('/api/orders', (req, res) => {
    const orders = loadOrders();
    res.json({ success: true, orders });
});

// API: Customer submits an order (saves to server, does NOT run AI yet)
app.post('/api/orders', (req, res) => {
    const { name, contact, query, condition, budget, notes, packageName, fee } = req.body;
    const orders = loadOrders();

    const newOrder = {
        id: Date.now().toString(),
        name: name || "Anonymous",
        contact: contact || "",
        query: query || "",
        condition: condition || "Brand New",
        budget: budget || "Flexible",
        notes: notes || "",
        packageName: packageName || "Standard Search",
        fee: fee || 30,
        isPaid: true, // Marked paid via Venmo flow
        status: 'Waiting',
        directLink: '',
        aiResults: '',
        createdAt: new Date().toISOString()
    };

    orders.unshift(newOrder);
    saveOrders(orders);
    res.json({ success: true, order: newOrder });
});

// API: Update order (payment status, direct link, status, or delete)
app.post('/api/orders/update', (req, res) => {
    const { id, isPaid, status, directLink, action } = req.body;
    let orders = loadOrders();

    if (action === 'delete') {
        orders = orders.filter(o => o.id !== id);
        saveOrders(orders);
        return res.json({ success: true, orders });
    }

    orders = orders.map(o => {
        if (o.id === id) {
            if (isPaid !== undefined) o.isPaid = isPaid;
            if (status !== undefined) o.status = status;
            if (directLink !== undefined) o.directLink = directLink;
        }
        return o;
    });

    saveOrders(orders);
    res.json({ success: true, orders });
});

// API: Staff triggers AI search from dashboard
app.post('/api/hunt-item', async (req, res) => {
    const { orderId, itemQuery, targetPrice, duration } = req.body;
    
    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are ItemHunter AI, an elite sourcing concierge. Provide direct live marketplace search strategies, estimated market pricing, and realistic direct purchase query links (formatted as markdown links) across Amazon, Facebook Marketplace, KSL Classifieds, and eBay for the requested item."
                },
                {
                    role: "user",
                    content: `Find this item with a search duration of ${duration || '24 hours'}: ${itemQuery}. Target budget: ${targetPrice}.`
                }
            ],
            max_tokens: 500
        });

        const resultsText = completion.choices[0].message.content;
        const defaultLink = `https://www.google.com/search?q=${encodeURIComponent(itemQuery + " buy online")}`;

        // Update stored order with results and link
        let orders = loadOrders();
        orders = orders.map(o => {
            if (o.id === orderId) {
                o.directLink = defaultLink;
                o.aiResults = resultsText;
            }
            return o;
        });
        saveOrders(orders);

        res.json({
            success: true,
            results: resultsText,
            defaultLink: defaultLink,
            staffNotice: "AI search compiled successfully. Direct purchasing link is now ready."
        });
    } catch (error) {
        console.error("OpenAI Error:", error);
        res.status(500).json({ success: false, error: "AI search execution failed." });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
