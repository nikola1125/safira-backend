// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const ical = require('node-ical');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());

mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

const Booking = mongoose.model('Booking', new mongoose.Schema({
    roomType: String,
    checkIn: Date,
    checkOut: Date,
    guests: Number,
    breakfast: Boolean,
    totalPrice: Number,
    customerName: String,
    customerEmail: String,
    customerPhone: String,
    paymentStatus: String,
    payseraOrderId: String,
}));

const ROOM_TYPES = {
    'deluxe-double': {
        name: 'Deluxe Double Room',
        capacities: [2],
        rates: { 2: { withoutBreakfast: 50, withBreakfast: 55 } },
    },
    'deluxe-double-balcony': {
        name: 'Deluxe Double Room With Balcony',
        capacities: [2, 3],
        rates: {
            2: { withoutBreakfast: 60, withBreakfast: 65 },
            3: { withoutBreakfast: 75, withBreakfast: 80 }
        }
    },
    'triple-garden': {
        name: 'Triple Room with garden view',
        capacities: [2, 3],
        rates: {
            2: { withoutBreakfast: 60, withBreakfast: 65 },
            3: { withoutBreakfast: 75, withBreakfast: 80 }
        }
    },
    'deluxe-family': {
        name: 'Deluxe Family Suite',
        capacities: [3, 4],
        rates: {
            3: { withoutBreakfast: 80, withBreakfast: 85 },
            4: { withoutBreakfast: 95, withBreakfast: 100 }
        }
    }
};

async function getCalendarData() {
    try {
        const response = await axios.get("https://ical.booking.com/v1/export?t=38bb6782-e96c-4e15-9e0e-763f7aca9ea5", {
            responseType: 'text'
        });
        return ical.parseICS(response.data);
    } catch (e) {
        console.error(e);
        return {};
    }
}

async function checkAvailability(roomType, checkIn, checkOut) {
    const events = await getCalendarData();
    const inDate = new Date(checkIn);
    const outDate = new Date(checkOut);
    for (let d = new Date(inDate); d < outDate; d.setDate(d.getDate() + 1)) {
        for (const eId in events) {
            const e = events[eId];
            if (e.type === 'VEVENT' && new Date(e.start) <= d && d < new Date(e.end)) return false;
        }
    }
    return true;
}

function calculateTotal(roomType, guests, breakfast, nights) {
    const rate = ROOM_TYPES[roomType].rates[guests];
    return (breakfast ? rate.withBreakfast : rate.withoutBreakfast) * nights;
}

app.get('/api/booked-dates', async (req, res) => {
    try {
        const events = await getCalendarData();
        const booked = [];
        for (const key in events) {
            const e = events[key];
            if (e.type === 'VEVENT') {
                booked.push({ start: e.start, end: e.end });
            }
        }
        res.json(booked);
    } catch (e) {
        res.status(500).send('Error');
    }
});

app.post('/api/check-availability', async (req, res) => {
    const { roomType, checkIn, checkOut, guests, breakfast } = req.body;
    const available = await checkAvailability(roomType, checkIn, checkOut);
    if (!available) return res.json({ available: false });

    const nights = Math.ceil((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24));
    const total = calculateTotal(roomType, guests, breakfast, nights);
    res.json({ available: true, nights, total, roomName: ROOM_TYPES[roomType].name });
});

app.post('/api/create-payment', async (req, res) => {
    const { roomType, checkIn, checkOut, guests, breakfast, customerInfo } = req.body;
    const available = await checkAvailability(roomType, checkIn, checkOut);
    if (!available) return res.status(400).json({ error: 'Room no longer available' });

    const nights = Math.ceil((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24));
    const total = calculateTotal(roomType, guests, breakfast, nights);

    const booking = await Booking.create({
        roomType,
        checkIn,
        checkOut,
        guests,
        breakfast,
        totalPrice: total,
        customerName: customerInfo.name,
        customerEmail: customerInfo.email,
        customerPhone: customerInfo.phone,
        paymentStatus: 'pending',
        payseraOrderId: `BOOKING-${Date.now()}`,
    });

    const paymentData = {
        projectid: '123456',
        orderid: booking.payseraOrderId,
        accepturl: `https://yourwebsite.com/payment/success?bookingId=${booking._id}`,
        cancelurl: `https://yourwebsite.com/payment/cancel?bookingId=${booking._id}`,
        callbackurl: `https://yourwebsite.com/api/payment-callback`,
        amount: total * 100,
        currency: 'EUR',
        payment: 'NB,CB',
        lang: 'en',
        test: '1',
        p_firstname: customerInfo.name.split(' ')[0],
        p_lastname: customerInfo.name.split(' ').slice(1).join(' '),
        p_email: customerInfo.email,
        p_phone: customerInfo.phone,
    };

    const signData = Object.entries(paymentData)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
    const ss1 = crypto.createHash('md5').update(signData + 'your_sign_password').digest('hex');
    paymentData.sign = ss1;

    res.json({ paymentUrl: `https://bank.paysera.com/pay/?${new URLSearchParams(paymentData).toString()}` });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
