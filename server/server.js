require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const ical = require('node-ical');
const {differenceInDays, parseISO, isValid} = require('date-fns');

const app = express();
app.use(cors());
app.use(bodyParser.json());

mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

const bookingSchema = new mongoose.Schema({
    roomType: String,
    checkIn: Date,
    checkOut: Date,
    guests: Number,
    breakfast: Boolean,
    totalPrice: Number,
    customerName: String,
    customerEmail: String,
    customerPhone: String,
    paymentStatus: String
});

const reviewSchema = new mongoose.Schema({
    name: String,
    email: String,
    rating: Number,
    comment: String,
    createdAt: {type: Date, default: Date.now}
});

const Booking = mongoose.model('Booking', bookingSchema);
const Review = mongoose.model('Review', reviewSchema);

const ROOM_TYPES = {
    'deluxe-double': {
        name: 'Deluxe Double Room',
        capacities: [2],
        rates: {
            2: {withoutBreakfast: 50, withBreakfast: 55}
        }
    },
    'deluxe-double-balcony': {
        name: 'Deluxe Double Room With Balcony',
        capacities: [2, 3],
        rates: {
            2: {withoutBreakfast: 60, withBreakfast: 65},
            3: {withoutBreakfast: 75, withBreakfast: 80}
        }
    },
    'triple-garden': {
        name: 'Triple Room with garden view',
        capacities: [2, 3],
        rates: {
            2: {withoutBreakfast: 60, withBreakfast: 65},
            3: {withoutBreakfast: 75, withBreakfast: 80}
        }
    },
    'deluxe-family': {
        name: 'Deluxe Family Suite',
        capacities: [3, 4],
        rates: {
            3: {withoutBreakfast: 80, withBreakfast: 85},
            4: {withoutBreakfast: 95, withBreakfast: 100}
        }
    }
};

async function getBookedDates() {
    try {
        const response = await axios.get(process.env.BOOKING_CALENDAR_URL, {
            responseType: 'text',
            timeout: 5000
        });
        const events = ical.parseICS(response.data);
        const bookedDates = [];

        for (const key in events) {
            const event = events[key];
            if (event.type === 'VEVENT') {
                bookedDates.push({
                    start: event.start,
                    end: event.end
                });
            }
        }
        return bookedDates;
    } catch (error) {
        console.error('Error fetching booked dates:', error);
        return [];
    }
}

async function isDateAvailable(checkIn, checkOut) {
    const bookedDates = await getBookedDates();
    for (const booking of bookedDates) {
        if (
            (checkIn >= booking.start && checkIn < booking.end) ||
            (checkOut > booking.start && checkOut <= booking.end) ||
            (checkIn <= booking.start && checkOut >= booking.end)
        ) {
            return false;
        }
    }
    return true;
}

app.get('/api/booked-dates', async (req, res) => {
    try {
        const bookedDates = await getBookedDates();
        res.json(bookedDates);
    } catch (error) {
        res.status(500).json({error: 'Failed to fetch booked dates'});
    }
});

app.post('/api/check-availability', async (req, res) => {
    try {
        const {roomType, checkIn, checkOut, guests, breakfast} = req.body;

        if (!ROOM_TYPES[roomType]) {
            return res.status(400).json({error: 'Invalid room type'});
        }

        if (!ROOM_TYPES[roomType].capacities.includes(Number(guests))) {
            return res.status(400).json({error: 'Invalid guest count for this room'});
        }

        const parsedCheckIn = parseISO(checkIn);
        const parsedCheckOut = parseISO(checkOut);

        if (!isValid(parsedCheckIn) || !isValid(parsedCheckOut)) {
            return res.status(400).json({error: 'Invalid dates'});
        }

        const available = await isDateAvailable(parsedCheckIn, parsedCheckOut);
        if (!available) {
            return res.json({available: false});
        }

        const nights = differenceInDays(parsedCheckOut, parsedCheckIn);
        const rate = ROOM_TYPES[roomType].rates[guests];
        const total = (breakfast ? rate.withBreakfast : rate.withoutBreakfast) * nights;

        res.json({
            available: true,
            nights,
            total,
            roomName: ROOM_TYPES[roomType].name
        });
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.post('/api/create-payment', async (req, res) => {
    try {
        const {roomType, checkIn, checkOut, guests, breakfast, customerInfo} = req.body;

        const available = await isDateAvailable(parseISO(checkIn), parseISO(checkOut));
        if (!available) {
            return res.status(400).json({error: 'Selected dates are no longer available'});
        }

        const nights = differenceInDays(parseISO(checkOut), parseISO(checkIn));
        const rate = ROOM_TYPES[roomType].rates[guests];
        const total = (breakfast ? rate.withBreakfast : rate.withoutBreakfast) * nights;

        const booking = new Booking({
            roomType,
            checkIn: parseISO(checkIn),
            checkOut: parseISO(checkOut),
            guests,
            breakfast,
            totalPrice: total,
            ...customerInfo,
            paymentStatus: 'pending'
        });

        await booking.save();

        res.json({
            paymentUrl: `${process.env.PAYMENT_URL}?amount=${total}&bookingId=${booking._id}`
        });
    } catch (error) {
        res.status(500).json({error: 'Failed to create payment'});
    }
});

app.post('/api/reviews', async (req, res) => {
    try {
        const {name, email, rating, comment} = req.body;
        const review = new Review({name, email, rating, comment});
        await review.save();
        res.json(review);
    } catch (error) {
        res.status(500).json({error: 'Failed to save review'});
    }
});

app.get('/api/reviews', async (req, res) => {
    try {
        const reviews = await Review.find().sort({createdAt: -1});
        res.json(reviews);
    } catch (error) {
        res.status(500).json({error: 'Failed to fetch reviews'});
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));