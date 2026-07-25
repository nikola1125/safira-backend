
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const ical = require('node-ical');
const {differenceInDays, parseISO, isValid} = require('date-fns');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');


const app = express()

app.use(helmet())

const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:5173'];

const corsOptions = {
    origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) cb(null, true);
        else cb(Object.assign(new Error('Not allowed by CORS'), { status: 403 }));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(bodyParser.json({ limit: '10kb' }))

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
});
const reviewLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Review limit reached. Please wait before submitting again.' }
});
app.use('/api/', apiLimiter);

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => { console.error('MongoDB connection error:', err); process.exit(1); })

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
    paymentStatus: {type: String, enum: ['pending', 'paid'], default: 'pending'},
    paymentDate: Date,
    bookingReference: String
}, {timestamps: true});

const reviewSchema = new mongoose.Schema({
    name: String,
    country: String,
    comment: String,
    rating: {type: Number, min: 1, max: 5},
    createdAt: {type: Date, default: Date.now}
});

const Booking = mongoose.model('Booking', bookingSchema);
const Review = mongoose.model('Review', reviewSchema);

const newsletterSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    createdAt: { type: Date, default: Date.now }
});
const Newsletter = mongoose.model('Newsletter', newsletterSchema);

// Configure email transporter
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

const ROOM_TYPES = {
    'room_type_1': {
        name: 'Deluxe Double Room',
        capacities: [2],
        rates: {
            2: {withoutBreakfast: 50, withBreakfast: 55}
        }
    },
    'room_type_2': {
        name: 'Deluxe Double Room With Balcony',
        capacities: [2, 3],
        rates: {
            2: {withoutBreakfast: 60, withBreakfast: 65},
            3: {withoutBreakfast: 75, withBreakfast: 80}
        }
    },
    'room_type_3': {
        name: 'Triple Room with garden view',
        capacities: [2, 3],
        rates: {
            2: {withoutBreakfast: 60, withBreakfast: 65},
            3: {withoutBreakfast: 75, withBreakfast: 80}
        }
    },
    'room_type_4': {
        name: 'Deluxe Family Suite',
        capacities: [3, 4],
        rates: {
            3: {withoutBreakfast: 80, withBreakfast: 85},
            4: {withoutBreakfast: 95, withBreakfast: 100}
        }
    }
};

// Function to sync with Booking.com
async function syncWithBookingDotCom() {
    try {
        const response = await axios.get(`${process.env.BOOKING_CALENDAR_URL}/availability`, {
            headers: {
                'Authorization': `Bearer ${process.env.BOOKING_DOT_COM_API_KEY}`
            },
            params: {
                hotel_id: process.env.HOTEL_ID,
                // Add other required parameters
            }
        });

        // Process the availability response
        const availableRooms = response.data.rooms.map(room => ({
            id: room.room_type_id,
            name: room.room_name,
            available: room.available,
            rates: room.rates
        }));

        return availableRooms;
    } catch (error) {
        console.error('Error syncing with Booking.com:', error);
        return [];
    }
}

// Get all booked dates from both our system and Booking.com
async function getBookedDates() {
    try {
        // Get bookings from our database
        const ourBookings = await Booking.find({
            paymentStatus: 'paid'
        }).select('checkIn checkOut');

        // Get bookings from Booking.com
        const bookingDotComBookings = await syncWithBookingDotCom();

        // Combine both sources
        const allBookings = [
            ...ourBookings.map(b => ({
                start: b.checkIn,
                end: b.checkOut
            })),
            ...bookingDotComBookings.map(b => ({
                start: b.start,
                end: b.end
            }))
        ];

        return allBookings;
    } catch (error) {
        console.error('Error fetching booked dates:', error);
        return [];
    }
}

// Check if dates are available
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

// Generate a unique booking reference
function generateBookingReference() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Send confirmation email
async function sendConfirmationEmail(booking) {
    try {
        const roomType = ROOM_TYPES[booking.roomType];

        const mailOptions = {
            from: `"Villa Safira" <${process.env.EMAIL_FROM}>`,
            to: booking.customerEmail,
            subject: 'Your Booking Confirmation',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h1 style="color: #b45309;">Booking Confirmation</h1>
                    <p>Dear ${booking.customerName},</p>
                    <p>Thank you for your booking at Villa Safira. Here are your booking details:</p>
                    
                    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                        <tr>
                            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Booking Reference</td>
                            <td style="padding: 8px; border: 1px solid #ddd;">${booking.bookingReference}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Room Type</td>
                            <td style="padding: 8px; border: 1px solid #ddd;">${roomType.name}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Check-in</td>
                            <td style="padding: 8px; border: 1px solid #ddd;">${new Date(booking.checkIn).toLocaleDateString()}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Check-out</td>
                            <td style="padding: 8px; border: 1px solid #ddd;">${new Date(booking.checkOut).toLocaleDateString()}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Guests</td>
                            <td style="padding: 8px; border: 1px solid #ddd;">${booking.guests}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Breakfast</td>
                            <td style="padding: 8px; border: 1px solid #ddd;">${booking.breakfast ? 'Included' : 'Not included'}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Total Paid</td>
                            <td style="padding: 8px; border: 1px solid #ddd;">€${booking.totalPrice.toFixed(2)}</td>
                        </tr>
                    </table>
                    
                    <p>We look forward to welcoming you!</p>
                    <p>Best regards,<br>The Villa Safira Team</p>
                </div>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log('Confirmation email sent to:', booking.customerEmail);
    } catch (error) {
        console.error('Error sending confirmation email:', error);
    }
}

// API Endpoints
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
        const { checkIn, checkOut, guests, breakfast } = req.body;

        // Get availability from Booking.com
        const bookingDotComAvailability = await syncWithBookingDotCom();

        // Combine with our local room types
        const allRooms = Object.entries(ROOM_TYPES).map(([id, room]) => {
            const bookingDotComRoom = bookingDotComAvailability.find(r => r.id === id);
            return {
                ...room,
                id,
                available: bookingDotComRoom ? bookingDotComRoom.available : false
            };
        });

        // Filter available rooms that can accommodate the guests
        const availableRooms = allRooms.filter(room =>
            room.available &&
            room.capacities.includes(Number(guests))
        );

        if (availableRooms.length === 0) {
            return res.json({ available: false });
        }

        // Calculate prices for available rooms
        const roomsWithPrices = availableRooms.map(room => {
            const nights = differenceInDays(parseISO(checkOut), parseISO(checkIn));
            const rate = room.rates[guests];
            const total = (breakfast ? rate.withBreakfast : rate.withoutBreakfast) * nights;

            return {
                ...room,
                nights,
                total
            };
        });

        res.json({
            available: true,
            rooms: roomsWithPrices
        });
    } catch (error) {
        console.error('Availability check error:', error);
        res.status(500).json({ error: 'Internal server error' });
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

        const bookingReference = generateBookingReference();

        const booking = new Booking({
            roomType,
            checkIn: parseISO(checkIn),
            checkOut: parseISO(checkOut),
            guests,
            breakfast,
            totalPrice: total,
            customerName: customerInfo.name,
            customerEmail: customerInfo.email,
            customerPhone: customerInfo.phone,
            paymentStatus: 'pending',
            bookingReference
        });

        await booking.save();

        res.json({
            booking,
            paymentUrl: `${process.env.PAYMENT_URL}?amount=${total}&bookingId=${booking._id}`
        });
    } catch (error) {
        res.status(500).json({error: 'Failed to create payment'});
    }
});

app.get('/api/booking-status/:id', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) {
            return res.status(404).json({error: 'Booking not found'});
        }
        res.json(booking);
    } catch (error) {
        res.status(500).json({error: 'Failed to fetch booking status'});
    }
});

app.post('/api/confirm-payment', async (req, res) => {
    try {
        const {bookingId} = req.body;
        const booking = await Booking.findByIdAndUpdate(bookingId, {
            paymentStatus: 'paid',
            paymentDate: new Date()
        }, {new: true});

        if (!booking) {
            return res.status(404).json({error: 'Booking not found'});
        }

        // Send confirmation email
        await sendConfirmationEmail(booking);

        res.json(booking);
    } catch (error) {
        res.status(500).json({error: 'Failed to confirm payment'});
    }
});

app.post('/api/send-confirmation', async (req, res) => {
    try {
        const {bookingId} = req.body;
        const booking = await Booking.findById(bookingId);

        if (!booking) {
            return res.status(404).json({error: 'Booking not found'});
        }

        await sendConfirmationEmail(booking);
        res.json({success: true});
    } catch (error) {
        res.status(500).json({error: 'Failed to send confirmation'});
    }
});

app.post('/api/reviews', reviewLimiter, async (req, res) => {
    try {
        const {name, country, comment, rating} = req.body;

        if (!name || !comment || !rating) {
            return res.status(400).json({error: 'Name, comment and rating are required'});
        }
        if (typeof name !== 'string' || name.length > 100) {
            return res.status(400).json({error: 'Invalid name'});
        }
        if (typeof comment !== 'string' || comment.length > 2000) {
            return res.status(400).json({error: 'Comment too long'});
        }
        if (typeof rating !== 'number' || rating < 1 || rating > 5) {
            return res.status(400).json({error: 'Rating must be between 1 and 5'});
        }

        const review = new Review({
            name,
            country,
            comment,
            rating
        });

        await review.save();
        res.json(review);
    } catch (error) {
        console.error('Error saving review:', error);
        res.status(500).json({error: 'Failed to save review'});
    }
});

app.get('/api/reviews', async (req, res) => {
    try {
        const reviews = await Review.find()
            .sort({createdAt: -1})
            .select('name country comment rating createdAt');

        res.json(reviews);
    } catch (error) {
        console.error('Error fetching reviews:', error);
        res.status(500).json({error: 'Failed to fetch reviews'});
    }
});

app.post('/api/newsletter', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || typeof email !== 'string' || !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        await Newsletter.create({ email: email.toLowerCase().trim() });
        res.json({ success: true });
    } catch (error) {
        if (error.code === 11000) {
            return res.json({ success: true });
        }
        res.status(500).json({ error: 'Failed to subscribe' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`));