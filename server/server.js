require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const ical = require('node-ical');
const { differenceInDays, parseISO, isValid } = require('date-fns');
const nodemailer = require('nodemailer');

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
    paymentStatus: { type: String, enum: ['pending', 'paid'], default: 'pending' },
    paymentDate: Date,
    bookingReference: String
}, { timestamps: true });

const reviewSchema = new mongoose.Schema({
    name: String,
    country: String,
    comment: String,
    rating: { type: Number, min: 1, max: 5 },
    createdAt: { type: Date, default: Date.now }
});

const Booking = mongoose.model('Booking', bookingSchema);
const Review = mongoose.model('Review', reviewSchema);

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
    'deluxe-double': {
        name: 'Deluxe Double Room',
        capacities: [2],
        rates: {
            2: { withoutBreakfast: 50, withBreakfast: 55 }
        }
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

// Function to sync with Booking.com
async function syncWithBookingDotCom() {
    try {
        const response = await axios.get(process.env.BOOKING_DOT_COM_API_URL, {
            headers: {
                'Authorization': `Bearer ${process.env.BOOKING_DOT_COM_API_KEY}`
            }
        });

        // Process the response and update our database
        const bookings = response.data.bookings.map(booking => ({
            start: new Date(booking.start_date),
            end: new Date(booking.end_date),
            roomType: booking.room_type,
            status: booking.status
        }));

        // Here you would typically update your database with the new bookings
        console.log('Synced with Booking.com:', bookings.length, 'bookings fetched');

        return bookings;
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
        res.status(500).json({ error: 'Failed to fetch booked dates' });
    }
});

app.post('/api/check-availability', async (req, res) => {
    try {
        const { roomType, checkIn, checkOut, guests, breakfast } = req.body;

        if (!ROOM_TYPES[roomType]) {
            return res.status(400).json({ error: 'Invalid room type' });
        }

        if (!ROOM_TYPES[roomType].capacities.includes(Number(guests))) {
            return res.status(400).json({ error: 'Invalid guest count for this room' });
        }

        const parsedCheckIn = parseISO(checkIn);
        const parsedCheckOut = parseISO(checkOut);

        if (!isValid(parsedCheckIn) || !isValid(parsedCheckOut)) {
            return res.status(400).json({ error: 'Invalid dates' });
        }

        const available = await isDateAvailable(parsedCheckIn, parsedCheckOut);
        if (!available) {
            return res.json({ available: false });
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
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/create-payment', async (req, res) => {
    try {
        const { roomType, checkIn, checkOut, guests, breakfast, customerInfo } = req.body;

        const available = await isDateAvailable(parseISO(checkIn), parseISO(checkOut));
        if (!available) {
            return res.status(400).json({ error: 'Selected dates are no longer available' });
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
        res.status(500).json({ error: 'Failed to create payment' });
    }
});

app.get('/api/booking-status/:id', async (req, res) => {
    try {
        const booking = await Booking.findById(req.params.id);
        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }
        res.json(booking);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch booking status' });
    }
});

app.post('/api/confirm-payment', async (req, res) => {
    try {
        const { bookingId } = req.body;
        const booking = await Booking.findByIdAndUpdate(bookingId, {
            paymentStatus: 'paid',
            paymentDate: new Date()
        }, { new: true });

        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        // Send confirmation email
        await sendConfirmationEmail(booking);

        res.json(booking);
    } catch (error) {
        res.status(500).json({ error: 'Failed to confirm payment' });
    }
});

app.post('/api/send-confirmation', async (req, res) => {
    try {
        const { bookingId } = req.body;
        const booking = await Booking.findById(bookingId);

        if (!booking) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        await sendConfirmationEmail(booking);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send confirmation' });
    }
});

app.post('/api/reviews', async (req, res) => {
    try {
        const { name, country, comment, rating } = req.body;

        // Validate the rating
        if (rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be between 1 and 5' });
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
        res.status(500).json({ error: 'Failed to save review' });
    }
});

app.get('/api/reviews', async (req, res) => {
    try {
        const reviews = await Review.find()
            .sort({ createdAt: -1 })
            .select('name country comment rating createdAt');

        res.json(reviews);
    } catch (error) {
        console.error('Error fetching reviews:', error);
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));