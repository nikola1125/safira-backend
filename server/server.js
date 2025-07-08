require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const ical = require('node-ical');
const { format, parseISO, isValid, differenceInDays } = require('date-fns');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Enhanced MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    retryWrites: true,
    w: 'majority'
}).catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
});

// Room types configuration
const ROOM_TYPES = {
    'deluxe-double': {
        name: 'Deluxe Double Room',
        capacities: [2],
        rates: { 2: { withoutBreakfast: 50, withBreakfast: 55 } }
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

// Enhanced Booking Schema
const bookingSchema = new mongoose.Schema({
    roomType: { type: String, required: true, enum: Object.keys(ROOM_TYPES) },
    checkIn: { type: Date, required: true, validate: [isValid, 'Invalid check-in date'] },
    checkOut: { type: Date, required: true, validate: [isValid, 'Invalid check-out date'] },
    guests: { type: Number, min: 1, max: 4, required: true },
    breakfast: { type: Boolean, required: true },
    totalPrice: { type: Number, min: 0, required: true },
    customerInfo: {
        name: { type: String, required: true },
        email: { type: String, required: true },
        phone: { type: String, required: true }
    },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' }
}, { timestamps: true });

const Booking = mongoose.model('Booking', bookingSchema);

// Date validation middleware
const validateDates = (req, res, next) => {
    try {
        const checkIn = parseISO(req.body.checkIn);
        const checkOut = parseISO(req.body.checkOut);

        if (!isValid(checkIn)) throw new Error('Invalid check-in date');
        if (!isValid(checkOut)) throw new Error('Invalid check-out date');
        if (checkOut <= checkIn) throw new Error('Check-out must be after check-in');

        req.validDates = { checkIn, checkOut };
        next();
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
};

// Get booked dates from external calendar
async function getCalendarData() {
    try {
        const response = await axios.get(process.env.BOOKING_CALENDAR_URL || "https://ical.booking.com/v1/export?t=38bb6782-e96c-4e15-9e0e-763f7aca9ea5", {
            responseType: 'text',
            timeout: 5000
        });
        return ical.parseICS(response.data);
    } catch (e) {
        console.error('Calendar fetch error:', e);
        return {};
    }
}

// Check room availability
async function checkAvailability(roomType, checkIn, checkOut) {
    try {
        const events = await getCalendarData();
        for (let d = new Date(checkIn); d < checkOut; d.setDate(d.getDate() + 1)) {
            for (const eId in events) {
                const e = events[eId];
                if (e.type === 'VEVENT' && new Date(e.start) <= d && d < new Date(e.end)) {
                    return false;
                }
            }
        }
        return true;
    } catch (e) {
        console.error('Availability check error:', e);
        return false;
    }
}

// API Endpoints
app.get('/api/booked-dates', async (req, res) => {
    try {
        const events = await getCalendarData();
        const booked = [];
        for (const key in events) {
            const e = events[key];
            if (e.type === 'VEVENT') {
                booked.push({
                    start: e.start,
                    end: e.end
                });
            }
        }
        res.json(booked);
    } catch (e) {
        console.error('Booked dates error:', e);
        res.status(500).json({ error: 'Failed to fetch booked dates' });
    }
});

app.post('/api/check-availability', validateDates, async (req, res) => {
    try {
        const { roomType, guests, breakfast } = req.body;
        const { checkIn, checkOut } = req.validDates;

        if (!ROOM_TYPES[roomType]) {
            return res.status(400).json({ error: 'Invalid room type' });
        }

        if (!ROOM_TYPES[roomType].capacities.includes(Number(guests))) {
            return res.status(400).json({ error: 'Invalid guest count for this room' });
        }

        const isAvailable = await checkAvailability(roomType, checkIn, checkOut);
        if (!isAvailable) {
            return res.json({ available: false });
        }

        const nights = differenceInDays(checkOut, checkIn);
        const rate = ROOM_TYPES[roomType].rates[guests];
        const total = (breakfast ? rate.withBreakfast : rate.withoutBreakfast) * nights;

        res.json({
            available: true,
            nights,
            total,
            roomName: ROOM_TYPES[roomType].name
        });
    } catch (error) {
        console.error('Availability check error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/create-payment', validateDates, async (req, res) => {
    try {
        const { roomType, guests, breakfast, customerInfo } = req.body;
        const { checkIn, checkOut } = req.validDates;

        // Verify availability again
        const isAvailable = await checkAvailability(roomType, checkIn, checkOut);
        if (!isAvailable) {
            return res.status(400).json({ error: 'Room no longer available' });
        }

        // Calculate total
        const nights = differenceInDays(checkOut, checkIn);
        const rate = ROOM_TYPES[roomType].rates[guests];
        const total = (breakfast ? rate.withBreakfast : rate.withoutBreakfast) * nights;

        // Create booking record
        const booking = await Booking.create({
            roomType,
            checkIn,
            checkOut,
            guests,
            breakfast,
            totalPrice: total,
            customerInfo,
            paymentStatus: 'pending'
        });

        // Generate payment URL (replace with your actual payment integration)
        const paymentUrl = `https://payment-provider.com/pay?amount=${total}&bookingId=${booking._id}`;

        res.json({ paymentUrl });
    } catch (error) {
        console.error('Payment creation error:', error);
        res.status(500).json({ error: 'Failed to create payment' });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Database:', mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected');
});