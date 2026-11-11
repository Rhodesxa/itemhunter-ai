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

// API: Staff triggers AI Search with automatic background timer (10 mins for Standard, 30 mins for Priority)
app.post('/api/hunt-item', async (req, res) => {
    const { orderId, itemQuery, targetPrice, packageName } = req.body;
    
    // Determine scan duration based on package tier ($30 = 10 mins, $50 = 30 mins)
    const isPriority = packageName && packageName.includes('Priority');
    const scanDurationMs = isPriority ? 30 * 60 * 1000 : 10 * 60 * 1000;
    const durationLabel = isPriority ? '30 Minutes (Priority Deep Hunt)' : '10 Minutes (Standard Scan)';

    try {
        const cleanQuery = encodeURIComponent(itemQuery || "");
        
        const links = [
            { label: '1. eBay Active Listings', url: `https://www.ebay.com/sch/i.html?_nkw=${cleanQuery}&_sacat=0` },
            { label: '2. KSL Classifieds', url: `https://www.ksl.com/classifieds/search?keyword=${cleanQuery}` },
            { label: '3. Facebook Marketplace', url: `https://www.facebook.com/marketplace/search/?query=${cleanQuery}` }
        ];

        let orders = loadOrders();
        
        // Mark order as currently scanning in the background
        orders = orders.map(o => {
            if (o.id === orderId) {
                o.status = 'AI Scanning...';
                o.aiResults = `AI scan in progress (${durationLabel})...`;
            }
            return o;
        });
        saveOrders(orders);

        // Respond immediately that the timer has started
        res.json({
            success: true,
            staffNotice: `AI background hunt deployed for ${durationLabel}. Links will unlock automatically when the scan completes.`
        });

        // Background timer simulating the deep AI hunt duration
        setTimeout(() => {
            let currentOrders = loadOrders();
            currentOrders = currentOrders.map(o => {
                if (o.id === orderId) {
                    o.status = 'Waiting';
                    o.directLinks = links;
                    o.aiResults = `AI Sourcing Scan Complete (${durationLabel} elapsed).\n• Compiled 3 direct platform links.`;
                }
                return o;
            });
            saveOrders(currentOrders);
        }, scanDurationMs);

    } catch (error) {
        res.status(500).json({ success: false, error: "Search failed." });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
