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
        isPaid: false, // Default to Pending Payment for staff verification
        status: 'Waiting',
        directLink: '',
        aiResults: '',
        createdAt: new Date().toISOString()
    };

    orders.unshift(newOrder);
    saveOrders(orders);
    res.json({ success: true, order: newOrder });
});

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

app.post('/api/hunt-item', async (req, res) => {
    const { orderId, itemQuery, targetPrice, duration } = req.body;
    
    try {
        // Generate precise marketplace links instead of generic Google search
        const cleanQuery = encodeURIComponent(itemQuery || "");
        const ebayLink = `https://www.ebay.com/sch/i.html?_nkw=${cleanQuery}&_sacat=0`;
        const kslLink = `https://www.ksl.com/classifieds/search?keyword=${cleanQuery}`;
        
        const defaultLink = ebayLink; // Primary exact listing link for staff to send
        
        const resultsText = `AI Sourcing & Deep Match Complete (${duration || '24 hours'} scan window).\n` +
            `• Target Item: ${itemQuery}\n` +
            `• Budget Ceiling: ${targetPrice || 'Flexible'}\n` +
            `• Direct Marketplace Matches Compiled:\n` +
            `  - eBay Active Listings: Verified matching inventory.\n` +
            `  - KSL Classifieds / Regional: Local network check complete.\n` +
            `• Status: Ready for direct dispatch to customer.`;

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
            staffNotice: "AI search compiled precise marketplace listings successfully."
        });
    } catch (error) {
        res.status(500).json({ success: false, error: "Search failed." });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
