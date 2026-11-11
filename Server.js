// server.js - Node.js Backend for ItemHunter AI
const express = require('express');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

let adminSettings = {
    venmoHandle: '@ItemHunterAI',
    senderEmail: 'notifications@itemhunter.ai',
    smtpPass: 'your-email-app-password'
};

let staffUsers = [
    { id: '1', username: 'XRhodes', password: '141500', title: 'Lead Broker / Owner', control: 'Full Access (Admin)' },
    { id: '2', username: 'SupportAgent', password: 'password123', title: 'Customer Support Lead', control: 'Order Management Only' }
];

let orders = [];

// Settings Endpoints
app.get('/api/admin/settings', (req, res) => {
    res.json(adminSettings);
});

app.post('/api/admin/settings', (req, res) => {
    const { venmoHandle, senderEmail } = req.body;
    if (venmoHandle) adminSettings.venmoHandle = venmoHandle;
    if (senderEmail) adminSettings.senderEmail = senderEmail;
    res.json({ success: true, message: 'Settings updated successfully!', settings: adminSettings });
});

// Staff Login Authentication Endpoint
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const user = staffUsers.find(s => s.username === username && s.password === password);
    if (user) {
        res.json({ success: true, user });
    } else {
        res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
});

// Staff Management Endpoints
app.get('/api/admin/staff', (req, res) => {
    res.json(staffUsers);
});

app.post('/api/admin/staff', (req, res) => {
    const { username, password, title, control } = req.body;
    const newStaff = {
        id: Date.now().toString(),
        username,
        password,
        title: title || 'Staff Member',
        control: control || 'Standard Control'
    };
    staffUsers.push(newStaff);
    res.json({ success: true, staff: newStaff });
});

app.delete('/api/admin/staff/:id', (req, res) => {
    staffUsers = staffUsers.filter(s => s.id !== req.params.id);
    res.json({ success: true });
});

// Order Endpoints
app.get('/api/orders', (req, res) => {
    res.json(orders);
});

app.post('/api/orders', (req, res) => {
    const { clientName, clientContact, itemName, specifics, condition, budget, tier, hours } = req.body;
    const orderId = 'ORD-' + Math.floor(1000 + Math.random() * 9000);
    const newOrder = {
        id: orderId,
        clientName,
        clientContact,
        itemName,
        specifics,
        condition,
        budget,
        tier,
        hours,
        date: new Date().toISOString().replace('T', ' ').substring(0, 16),
        status: `Multi-AI Scraping Active (${hours}-Hour Deep Search)`,
        paid: false,
        matches: []
    };
    orders.unshift(newOrder);
    simulateAISearch(newOrder);
    res.json({ success: true, order: newOrder, venmoHandle: adminSettings.venmoHandle });
});

app.patch('/api/orders/:id/pay', (req, res) => {
    const order = orders.find(o => o.id === req.params.id);
    if (order) {
        order.paid = !order.paid;
        res.json({ success: true, order });
    } else {
        res.status(404).json({ success: false });
    }
});

app.delete('/api/orders/:id', (req, res) => {
    orders = orders.filter(o => o.id !== req.params.id);
    res.json({ success: true });
});

function simulateAISearch(order) {
    setTimeout(() => {
        const targetOrder = orders.find(o => o.id === order.id);
        if (!targetOrder) return;
        targetOrder.status = 'Scraped & Verified by AI';
        targetOrder.matches = [
            { source: 'KSL Classifieds', title: `${targetOrder.itemName} (${targetOrder.specifics})`, price: '$125', contact: '(801) 555-0199', flag: 'FLAG: Needs Human Staff Member to Text This Number Directly', location: 'Salt Lake City, UT' }
        ];
    }, 10000);
}

app.listen(PORT, () => {
    console.log(`ItemHunter AI Server running on http://localhost:${PORT}`);
});