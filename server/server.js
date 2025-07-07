// const express = require('express');
// const mongoose = require('mongoose');
// const cors = require('cors');
// const path = require('path');
// const app = express();
//
// require('dotenv').config();
//
// app.use(cors({
//     origin: [
//         'https://villasafira.space',
//         'https://www.villasafira.space',
//         'http://localhost:5000' // For development
//     ]
// }));
// app.use(express.json());
// // app.use(express.static(path.join(__dirname, 'dist')));
//
// // Connect to MongoDB
// mongoose.connect(process.env.MONGODB_URI)
//     .then(() => console.log('Connected to MongoDB'))
//     .catch(err => console.error('MongoDB connection error:', err));
//
// // Review Model
// const reviewSchema = new mongoose.Schema({
//     name: {type: String, required: true},
//     country: {type: String, required: true},
//     comment: {type: String, required: true},
//     rating: {type: Number, required: true, min: 1, max: 5},
//     date: {type: Date, default: Date.now}
// });
// const Review = mongoose.model('Review', reviewSchema);
//
// // Routes
//
// app.post('/api/reviews', async (req, res) => {
//     try {
//         const review = new Review(req.body);
//         await review.save();
//         res.status(201).json(review);
//     } catch (err) {
//         res.status(400).json({error: err.message});
//     }
// });
//
// app.get('/api/reviews', async (req, res) => {
//     try {
//         const reviews = await Review.find({}).sort({date: -1});
//         res.json(reviews);
//     } catch (err) {
//         res.status(500).json({error: err.message});
//     }
// });
//
// // app.get('*', (req, res) => {
// //     res.sendFile(path.join(__dirname, 'dist', 'index.html'));
// // });
// // Fetch from Booking.com API
//
//
// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// const express = require('express');
// const mongoose = require('mongoose');
// const cors = require('cors');
// const axios = require('axios');
// const path = require('path');
// const app = express();
//
// require('dotenv').config();
//
// app.use(cors({
//     origin: [
//         'https://villasafira.space',
//         'https://www.villasafira.space',
//         'http://localhost:5000',
//         'http://localhost:5173' // For Vite development
//     ]
// }));
// app.use(express.json());
//
// // Connect to MongoDB
// mongoose.connect(process.env.MONGODB_URI)
//     .then(() => console.log('Connected to MongoDB'))
//     .catch(err => console.error('MongoDB connection error:', err));
//
// // Review Model
// const reviewSchema = new mongoose.Schema({
//     name: { type: String, required: true },
//     country: { type: String, required: true },
//     comment: { type: String, required: true },
//     rating: { type: Number, required: true, min: 1, max: 5 },
//     date: { type: Date, default: Date.now }
// });
// const Review = mongoose.model('Review', reviewSchema);
//
// // Booking Model
// const bookingSchema = new mongoose.Schema({
//     startDate: { type: Date, required: true },
//     endDate: { type: Date, required: true },
//     guests: { type: Number, required: true },
//     status: { type: String, default: 'pending' }
// });
// const Booking = mongoose.model('Booking', bookingSchema);
//
// // Routes
//
// // Review routes
// app.post('/api/reviews', async (req, res) => {
//     try {
//         const review = new Review(req.body);
//         await review.save();
//         res.status(201).json(review);
//     } catch (err) {
//         res.status(400).json({ error: err.message });
//     }
// });
//
// app.get('/api/reviews', async (req, res) => {
//     try {
//         const reviews = await Review.find({}).sort({ date: -1 });
//         res.json(reviews);
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });
//
// // Booking routes
// app.get('/api/booking/availability', async (req, res) => {
//     try {
//         // Get all booked dates from database
//         const bookings = await Booking.find({
//             status: { $ne: 'cancelled' },
//             endDate: { $gte: new Date() } // Only future bookings
//         });
//
//         // Mock some bookings for testing if none exist
//         if (bookings.length === 0) {
//             const mockBookings = [
//                 { startDate: new Date(Date.now() + 86400000 * 5), endDate: new Date(Date.now() + 86400000 * 7) },
//                 { startDate: new Date(Date.now() + 86400000 * 10), endDate: new Date(Date.now() + 86400000 * 12) }
//             ];
//
//             const blockedDates = [];
//             mockBookings.forEach(booking => {
//                 let currentDate = new Date(booking.startDate);
//                 while (currentDate <= booking.endDate) {
//                     blockedDates.push(currentDate.toISOString().split('T')[0]);
//                     currentDate.setDate(currentDate.getDate() + 1);
//                 }
//             });
//
//             return res.json({ blockedDates });
//         }
//
//         // Convert bookings to date strings
//         const blockedDates = [];
//         bookings.forEach(booking => {
//             let currentDate = new Date(booking.startDate);
//             while (currentDate <= booking.endDate) {
//                 blockedDates.push(currentDate.toISOString().split('T')[0]);
//                 currentDate.setDate(currentDate.getDate() + 1);
//             }
//         });
//
//         res.json({ blockedDates });
//     } catch (error) {
//         console.error('Error fetching availability:', error);
//         res.status(500).json({ error: 'Failed to fetch availability' });
//     }
// });
//
// app.post('/api/booking/reserve', async (req, res) => {
//     try {
//         const { startDate, endDate, guests } = req.body;
//
//         // Create a new booking
//         const booking = new Booking({
//             startDate,
//             endDate,
//             guests,
//             status: 'confirmed'
//         });
//
//         await booking.save();
//
//         res.json({
//             success: true,
//             message: 'Booking confirmed! We look forward to hosting you.',
//             booking
//         });
//     } catch (error) {
//         console.error('Booking failed:', error);
//         res.status(500).json({ error: 'Booking failed. Please try again.' });
//     }
// });
//
// const PORT = process.env.PORT || 5000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const ical = require('node-ical');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// MongoDB Models
const Booking = mongoose.model('Booking', new mongoose.Schema({
    roomType: String,
    roomName: String,
    checkIn: Date,
    checkOut: Date,
    guests: Number,
    breakfast: Boolean,
    nights: Number,
    totalPrice: Number,
    customerName: String,
    customerEmail: String,
    customerPhone: String,
    paymentStatus: {type: String, default: 'pending'},
    payseraOrderId: String,
    createdAt: {type: Date, default: Date.now}
}));

// Room types and pricing
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

// Fetch and parse iCal data
async function getCalendarData() {
    try {
        const response = await axios.get('https://ical.booking.com/v1/export?t=38bb6782-e96c-4e15-9e0e-763f7aca9ea5');
        return ical.parseICS(response.data);
    } catch (error) {
        console.error('Error fetching iCal data:', error);
        return {};
    }
}

// Check room availability from iCal
async function checkAvailability(roomType, checkIn, checkOut) {
    const events = await getCalendarData();
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);

    // Check each day in the date range
    for (let d = new Date(checkInDate); d < checkOutDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];

        // Check if any event overlaps with this date
        for (const eventId in events) {
            const event = events[eventId];
            if (event.type === 'VEVENT') {
                const eventStart = new Date(event.start);
                const eventEnd = new Date(event.end);

                if (d >= eventStart && d < eventEnd) {
                    return false; // Room is booked for this date
                }
            }
        }
    }

    return true; // No conflicts found
}

// Calculate total price
function calculateTotal(roomType, guests, breakfast, nights) {
    const room = ROOM_TYPES[roomType];
    if (!room || !room.rates[guests]) {
        throw new Error('Invalid room type or guest count');
    }

    const rate = breakfast ? room.rates[guests].withBreakfast : room.rates[guests].withoutBreakfast;
    return rate * nights;
}

// API endpoint to check availability and get price
app.post('/api/check-availability', async (req, res) => {
    const {roomType, checkIn, checkOut, guests, breakfast} = req.body;

    try {
        const available = await checkAvailability(roomType, checkIn, checkOut);
        if (!available) {
            return res.json({available: false});
        }

        const checkInDate = new Date(checkIn);
        const checkOutDate = new Date(checkOut);
        const nights = Math.ceil((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));

        const total = calculateTotal(roomType, guests, breakfast, nights);

        res.json({
            available: true,
            nights,
            total,
            roomName: ROOM_TYPES[roomType].name
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({error: 'Server error'});
    }
});

// Paysera payment integration
app.post('/api/create-payment', async (req, res) => {
    const {roomType, checkIn, checkOut, guests, breakfast, customerInfo} = req.body;

    try {
        // Verify availability again before payment
        const available = await checkAvailability(roomType, checkIn, checkOut);
        if (!available) {
            return res.status(400).json({error: 'Room no longer available'});
        }

        const checkInDate = new Date(checkIn);
        const checkOutDate = new Date(checkOut);
        const nights = Math.ceil((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));
        const amount = calculateTotal(roomType, guests, breakfast, nights);

        // Create booking in database
        const booking = new Booking({
            roomType,
            roomName: ROOM_TYPES[roomType].name,
            checkIn: checkInDate,
            checkOut: checkOutDate,
            guests,
            breakfast,
            nights,
            totalPrice: amount,
            customerName: customerInfo.name,
            customerEmail: customerInfo.email,
            customerPhone: customerInfo.phone,
            paymentStatus: 'pending'
        });

        await booking.save();

        // Paysera payment parameters
        const orderId = `BOOKING-${Date.now()}`;
        const projectId = process.env.PAYSERA_PROJECT_ID; // Replace with your Paysera project ID
        const signPassword = process.env.PAYSERA_SIGN_PASSWORD; // Replace with your Paysera sign password

        const paymentData = {
            projectid: projectId,
            orderid: orderId,
            accepturl: `${process.env.BASE_URL}/payment/success?bookingId=${booking._id}`,
            cancelurl: `${process.env.BASE_URL}/payment/cancel?bookingId=${booking._id}`,
            callbackurl: `${process.env.BASE_URL}/api/payment-callback`,
            amount: amount * 100, // Paysera uses cents
            currency: 'EUR',
            payment: 'NB,CB,VW,EP,MP', // Payment methods
            country: 'LT',
            lang: 'en',
            test: process.env.PAYSERA_TEST_MODE === '1' ? '1' : '0',
            p_firstname: customerInfo.name.split(' ')[0],
            p_lastname: customerInfo.name.split(' ').slice(1).join(' '),
            p_email: customerInfo.email,
            p_phone: customerInfo.phone
        };

        // Generate Paysera SS1 signature
        const dataToSign = Object.entries(paymentData)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
            .join('&');

        const ss1 = crypto.createHash('md5')
            .update(dataToSign + signPassword)
            .digest('hex');

        paymentData.sign = ss1;

        // Update booking with order ID
        booking.payseraOrderId = orderId;
        await booking.save();

        res.json({
            paymentUrl: `https://bank.paysera.com/pay/?${new URLSearchParams(paymentData).toString()}`
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({error: 'Server error'});
    }
});

// Paysera callback handler
app.post('/api/payment-callback', async (req, res) => {
    const {data, ss1} = req.body;

    try {
        // Verify the callback signature
        const calculatedSs1 = crypto.createHash('md5')
            .update(data + process.env.PAYSERA_SIGN_PASSWORD)
            .digest('hex');

        if (calculatedSs1 !== ss1) {
            console.error('Invalid Paysera callback signature');
            return res.status(400).send('Invalid signature');
        }

        // Parse the data
        const params = new URLSearchParams(data);
        const orderId = params.get('orderid');
        const status = params.get('status');

        // Update booking status
        const booking = await Booking.findOne({payseraOrderId: orderId});
        if (booking) {
            booking.paymentStatus = status === '1' ? 'completed' : 'failed';
            await booking.save();
        }

        res.send('OK');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error processing callback');
    }
});

// API endpoint to check booking status
app.get('/api/booking/:id', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) {
            return res.status(404).json({error: 'Booking not found'});
        }
        res.json(booking);
    } catch (error) {
        console.error(error);
        res.status(500).json({error: 'Server error'});
    }
});
app.get('/api/booked-dates', async (req, res) => {
    try {
        const events = await getCalendarData();
        const bookedDates = [];

        for (const eventId in events) {
            const event = events[eventId];
            if (event.type === 'VEVENT') {
                bookedDates.push({
                    start: new Date(event.start),
                    end: new Date(event.end)
                });
            }
        }

        res.json(bookedDates);
    } catch (error) {
        console.error(error);
        res.status(500).json({error: 'Server error'});
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));