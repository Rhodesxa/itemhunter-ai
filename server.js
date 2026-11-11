const express = require('express');
const nodemailer = require('nodemailer');
const OpenAI = require('openai');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize OpenAI (uses the OPENAI_API_KEY environment variable on Render)
const openai = new OpenAI();

// Configure Nodemailer (uses environment variables for secure email dispatches)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Endpoint to automatically trigger the item hunt and AI search
app.post('/api/hunt-item', async (req, res) => {
    try {
        const { itemQuery, targetPrice, customerPhone, customerEmail } = req.body;

        // Use OpenAI to find real listings, prices, and direct URLs
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are ItemHunter AI, an expert procurement agent. Find real online listings, store names, estimated market prices, and direct clickable web URLs matching the user's target criteria."
                },
                {
                    role: "user",
                    content: `Find live availability and pricing for: "${itemQuery}" with a target max price of $${targetPrice}. Provide results with titles, prices, and direct URLs.`
                }
            ]
        });

        const aiFindings = completion.choices[0].message.content;
        const fallbackLink = `https://www.google.com/search?q=${encodeURIComponent(itemQuery + " buy online")}`;

        // Correct staff notification prompting staff to contact the customer via phone number
        const staffNotificationText = `New ItemHunter AI Match! Please contact the customer directly at phone number: ${customerPhone || 'Not provided'} or email: ${customerEmail || 'Not provided'}.`;

        // Optional email dispatch simulation
        if (process.env.EMAIL_USER && customerEmail) {
            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: customerEmail,
                subject: `ItemHunter AI Update: ${itemQuery}`,
                text: `We found matches for your item! ${aiFindings}`
            });
        }

        res.json({
            success: true,
            results: aiFindings,
            defaultLink: fallbackLink,
            staffNotice: staffNotificationText
        });

    } catch (error) {
        console.error("AI Search Error:", error);
        res.status(500).json({ success: false, error: "Failed to execute AI live search." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`ItemHunter AI Server running on port ${PORT}`);
});
