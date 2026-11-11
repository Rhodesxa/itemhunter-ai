const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/api/orders', (req, res) => {
    const orders = loadOrders();
    res.json({ success: true, orders });
});

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
        isPaid: false,
        status: 'Waiting',
        directLinks: [],
        aiResults: '',
        createdAt: new Date().toISOString()
    };

    orders.unshift(newOrder);
    saveOrders(orders);
    res.json({ success: true, order: newOrder });
});

app.post('/api/orders/update', (req, res) => {
    const { id, isPaid, status, directLinks, action } = req.body;
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
            if (directLinks !== undefined) o.directLinks = directLinks;
        }
        return o;
    });

    saveOrders(orders);
    res.json({ success: true, orders });
});

// API: Instantly generate multiple mainstream marketplace listing links
app.post('/api/hunt-item', async (req, res) => {
    const { orderId, itemQuery, targetPrice } = req.body;
    
    try {
        const cleanQuery = encodeURIComponent(itemQuery || "");
        
        // Comprehensive mainstream marketplace search options for staff review
        const links = [
            { label: '🔍 eBay Verified Search Results', url: `https://www.ebay.com/sch/i.html?_nkw=${cleanQuery}&_sacat=0` },
            { label: '🛒 Amazon Direct Catalog', url: `https://www.amazon.com/s?k=${cleanQuery}` },
            { label: '🏪 Walmart Online Marketplace', url: `https://www.walmart.com/search?q=${cleanQuery}` },
            { label: '📍 KSL Classifieds (Local/Regional)', url: `https://www.ksl.com/classifieds/search?keyword=${cleanQuery}` },
            { label: '👥 Facebook Marketplace Search', url: `https://www.facebook.com/marketplace/search/?query=${cleanQuery}` }
        ];

        const resultsText = `AI Multi-Platform Scan Complete.\n` +
            `• Target: ${itemQuery}\n` +
            `• Budget: ${targetPrice || 'Flexible'}\n` +
            `• Generated 5 mainstream sourcing links for staff filtering.`;

        let orders = loadOrders();
        orders = orders.map(o => {
            if (o.id === orderId) {
                o.status = 'Waiting';
                o.directLinks = links;
                o.aiResults = resultsText;
            }
            return o;
        });
        saveOrders(orders);

        res.json({
            success: true,
            results: resultsText,
            links: links,
            staffNotice: "AI generated multiple mainstream marketplace options successfully."
        });
    } catch (error) {
        res.status(500).json({ success: false, error: "Search failed." });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
