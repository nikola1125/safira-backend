
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
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');


const app = express()

app.use(helmet({
    contentSecurityPolicy: false, // Allow inline scripts for admin dashboard
    crossOriginEmbedderPolicy: false, // Allow image loading from R2
}))

// Trust proxy for rate limiting behind reverse proxy (OVH/Cloudflare)
app.set('trust proxy', 1)

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
const loginLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // 5 attempts per hour per IP
    skipSuccessfulRequests: true, // Only count failed attempts
    message: { error: 'Too many login attempts. Please try again in 1 hour.' }
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
    published: { type: Boolean, default: false },
    createdAt: {type: Date, default: Date.now}
});

const Booking = mongoose.model('Booking', bookingSchema);
const Review = mongoose.model('Review', reviewSchema);

const newsletterSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    createdAt: { type: Date, default: Date.now }
});
const Newsletter = mongoose.model('Newsletter', newsletterSchema);

// ─── CMS Models ────────────────────────────────────────────────────────────────

const adminUserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
const AdminUser = mongoose.model('AdminUser', adminUserSchema);

const contentBlockSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedAt: { type: Date, default: Date.now }
});
const ContentBlock = mongoose.model('ContentBlock', contentBlockSchema);

const loginAttemptSchema = new mongoose.Schema({
    email: { type: String, required: true },
    ip: { type: String, required: true },
    userAgent: String,
    success: { type: Boolean, required: true },
    timestamp: { type: Date, default: Date.now }
});
loginAttemptSchema.index({ timestamp: -1 }); // For faster queries
const LoginAttempt = mongoose.model('LoginAttempt', loginAttemptSchema);

const blockedIpSchema = new mongoose.Schema({
    ip: { type: String, required: true, unique: true },
    type: { type: String, enum: ['ip', 'tracker'], default: 'ip' },
    reason: String,
    blockedAt: { type: Date, default: Date.now },
    blockedBy: String,
    expiresAt: { type: Date, default: null }, // null = permanent
    duration: String // "24h", "1w", "permanent"
});
const BlockedIP = mongoose.model('BlockedIP', blockedIpSchema);

const incidentSchema = new mongoose.Schema({
    ip: { type: String, required: true },
    tracker: String, // User identifier/tracker
    actor: String, // Human-readable name
    failedAttempts: { type: Number, default: 0 },
    rateLimit: { type: Number, default: 5 }, // Rate limit threshold
    status: { type: String, enum: ['ongoing', 'resolved', 'muted'], default: 'ongoing' },
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    endpoint: { type: String, default: 'POST /api/admin/login' },
    resolvedAt: Date,
    resolvedBy: String
});
incidentSchema.index({ status: 1, lastSeen: -1 });
const Incident = mongoose.model('Incident', incidentSchema);

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
        const reviews = await Review.find({ published: true })
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

// ─── Public Content API ────────────────────────────────────────────────────────

app.get('/api/content/:key', async (req, res) => {
    try {
        const block = await ContentBlock.findOne({ key: req.params.key });
        if (!block) return res.json({ data: null });
        res.json({ data: block.data, updatedAt: block.updatedAt });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch content' });
    }
});

// ─── Admin Auth ────────────────────────────────────────────────────────────────

// R2 client (S3-compatible)
const r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are allowed'));
    }
});

const requireAdmin = (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        req.admin = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// Middleware to check if IP is blocked
const checkBlockedIP = async (req, res, next) => {
    try {
        const blocked = await BlockedIP.findOne({ ip: req.ip });
        if (blocked) {
            // Check if block has expired
            if (blocked.expiresAt && blocked.expiresAt < new Date()) {
                await BlockedIP.deleteOne({ _id: blocked._id });
                console.log(`Expired block removed for IP: ${req.ip}`);
                return next();
            }
            console.warn(`Blocked IP attempted access: ${req.ip}`);
            return res.status(403).json({ error: 'Access denied. Your IP has been blocked.' });
        }
        next();
    } catch (err) {
        next(); // Continue even if check fails
    }
};

// Helper to update or create incident
const trackIncident = async (ip, success) => {
    if (success) return; // Only track failed attempts
    
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentAttempts = await LoginAttempt.countDocuments({
        ip,
        success: false,
        timestamp: { $gte: oneHourAgo }
    });
    
    // Create/update incident if failed attempts >= 3
    if (recentAttempts >= 3) {
        await Incident.findOneAndUpdate(
            { ip, status: 'ongoing' },
            {
                ip,
                tracker: `user:${ip.replace(/\./g, '')}`,
                actor: `User ${ip}`,
                failedAttempts: recentAttempts,
                lastSeen: new Date(),
                endpoint: 'POST /api/admin/login'
            },
            { upsert: true, new: true }
        );
    }
};

app.post('/api/admin/login', checkBlockedIP, /* loginLimiter, */ async (req, res) => {
    const clientIp = req.ip;
    const userAgent = req.headers['user-agent'] || 'Unknown';
    
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        const admin = await AdminUser.findOne({ email: email.toLowerCase().trim() });
        if (!admin) {
            // Log failed attempt
            await LoginAttempt.create({ email, ip: clientIp, userAgent, success: false });
            await trackIncident(clientIp, false);
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
            console.warn(`Failed login attempt for non-existent user: ${email} from IP: ${clientIp}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const valid = await bcrypt.compare(password, admin.passwordHash);
        if (!valid) {
            // Log failed attempt
            await LoginAttempt.create({ email, ip: clientIp, userAgent, success: false });
            await trackIncident(clientIp, false);
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
            console.warn(`Failed login attempt for ${email} from IP: ${clientIp}`);
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Log successful attempt
        await LoginAttempt.create({ email, ip: clientIp, userAgent, success: true });
        await trackIncident(clientIp, true);
        const token = jwt.sign({ id: admin._id, email: admin.email }, process.env.JWT_SECRET, { expiresIn: '24h' });
        console.log(`Successful login: ${email} from IP: ${clientIp}`);
        res.json({ token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Seed the first admin account from env vars (runs once on startup)
async function seedAdmin() {
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return;
    const existing = await AdminUser.findOne({ email: process.env.ADMIN_EMAIL.toLowerCase() });
    if (existing) return;
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await AdminUser.create({ email: process.env.ADMIN_EMAIL.toLowerCase(), passwordHash: hash });
    console.log('Admin account created:', process.env.ADMIN_EMAIL);
}
mongoose.connection.once('open', seedAdmin);

// ─── Admin Content CRUD ────────────────────────────────────────────────────────

const VALID_CONTENT_KEYS = ['hero', 'story', 'highlights', 'rooms', 'amenities', 'gallery', 'cta', 'footer', 'global'];

app.get('/api/admin/content/:key', requireAdmin, async (req, res) => {
    if (!VALID_CONTENT_KEYS.includes(req.params.key)) {
        return res.status(400).json({ error: 'Invalid content key' });
    }
    try {
        const block = await ContentBlock.findOne({ key: req.params.key });
        res.json({ data: block ? block.data : null, updatedAt: block ? block.updatedAt : null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch content' });
    }
});

app.put('/api/admin/content/:key', requireAdmin, async (req, res) => {
    if (!VALID_CONTENT_KEYS.includes(req.params.key)) {
        return res.status(400).json({ error: 'Invalid content key' });
    }
    try {
        const block = await ContentBlock.findOneAndUpdate(
            { key: req.params.key },
            { data: req.body.data, updatedAt: new Date() },
            { upsert: true, new: true }
        );
        res.json({ data: block.data, updatedAt: block.updatedAt });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save content' });
    }
});

// ─── Admin Rooms (convenience wrapper) ───────────────────────────────────────

app.get('/api/admin/rooms', requireAdmin, async (req, res) => {
    try {
        const block = await ContentBlock.findOne({ key: 'rooms' });
        res.json({ rooms: block ? block.data : [] });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch rooms' });
    }
});

app.put('/api/admin/rooms', requireAdmin, async (req, res) => {
    try {
        const { rooms } = req.body;
        if (!Array.isArray(rooms)) return res.status(400).json({ error: 'rooms must be an array' });
        const block = await ContentBlock.findOneAndUpdate(
            { key: 'rooms' },
            { data: rooms, updatedAt: new Date() },
            { upsert: true, new: true }
        );
        res.json({ rooms: block.data });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save rooms' });
    }
});

// ─── Admin Image Upload (R2) ──────────────────────────────────────────────────

app.post('/api/admin/upload', requireAdmin, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided' });
        
        // Get optional roomSlug from query or body
        const roomSlug = req.query.roomSlug || req.body.roomSlug;
        
        const fileName = `${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        
        // Organize into folders: if roomSlug provided, put in rooms/{slug}/, otherwise in root
        const key = roomSlug 
            ? `villa-images/rooms/${roomSlug}/${fileName}`
            : `villa-images/${fileName}`;
        
        const command = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
        });
        
        await r2Client.send(command);
        
        // Return the public URL (requires R2 bucket to have public access enabled)
        const url = `${process.env.R2_PUBLIC_URL}/${key}`;
        res.json({ url, id: key });
    } catch (err) {
        console.error('R2 upload error:', err);
        res.status(500).json({ error: 'Image upload failed' });
    }
});

// Delete image from R2
app.delete('/api/admin/upload/:imageId', requireAdmin, async (req, res) => {
    try {
        // imageId is the full key path
        const key = decodeURIComponent(req.params.imageId);
        
        const command = new DeleteObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
        });
        
        await r2Client.send(command);
        res.json({ success: true });
    } catch (err) {
        console.error('R2 delete error:', err);
        res.status(500).json({ error: 'Failed to delete image' });
    }
});

// List images from a room folder (public endpoint)
app.get('/api/rooms/:slug/images', async (req, res) => {
    try {
        const { slug } = req.params;
        const prefix = `villa-images/rooms/${slug}/`;
        
        const command = new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET_NAME,
            Prefix: prefix,
        });
        
        const response = await r2Client.send(command);
        
        // Convert S3 objects to image URLs
        const images = (response.Contents || [])
            .filter(obj => obj.Key && !obj.Key.endsWith('/')) // Exclude folders
            .map(obj => `${process.env.R2_PUBLIC_URL}/${obj.Key}`);
        
        res.json({ images });
    } catch (err) {
        console.error('R2 list error:', err);
        res.status(500).json({ error: 'Failed to list images', images: [] });
    }
});

// ─── Admin Reviews ─────────────────────────────────────────────────────────────

app.get('/api/admin/reviews', requireAdmin, async (req, res) => {
    try {
        const reviews = await Review.find().sort({ createdAt: -1 });
        res.json(reviews);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

app.patch('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
    try {
        const { published } = req.body;
        const review = await Review.findByIdAndUpdate(
            req.params.id,
            { published: Boolean(published) },
            { new: true }
        );
        if (!review) return res.status(404).json({ error: 'Review not found' });
        res.json(review);
    } catch (err) {
        res.status(500).json({ error: 'Failed to update review' });
    }
});

app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
    try {
        await Review.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete review' });
    }
});

// ─── Admin Dashboard Stats ────────────────────────────────────────────────────

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const [reviewCount, pendingReviews, subscribers] = await Promise.all([
            Review.countDocuments(),
            Review.countDocuments({ published: false }),
            Newsletter.countDocuments()
        ]);
        res.json({ reviewCount, pendingReviews, subscribers });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// ─── Admin Security Incidents & IP Blocking ────────────────────────────────────

app.get('/api/admin/incidents', requireAdmin, async (req, res) => {
    try {
        const [ongoing, past] = await Promise.all([
            Incident.find({ status: 'ongoing' }).sort({ lastSeen: -1 }).lean(),
            Incident.find({ status: { $in: ['resolved', 'muted'] } }).sort({ resolvedAt: -1 }).limit(50).lean()
        ]);
        
        res.json({ ongoing, past });
    } catch (err) {
        console.error('Incidents fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch incidents' });
    }
});

app.post('/api/admin/incidents/:id/resolve', requireAdmin, async (req, res) => {
    try {
        const incident = await Incident.findByIdAndUpdate(
            req.params.id,
            { 
                status: 'resolved',
                resolvedAt: new Date(),
                resolvedBy: req.admin.email
            },
            { new: true }
        );
        res.json(incident);
    } catch (err) {
        res.status(500).json({ error: 'Failed to resolve incident' });
    }
});

app.post('/api/admin/incidents/:id/mute', requireAdmin, async (req, res) => {
    try {
        const incident = await Incident.findByIdAndUpdate(
            req.params.id,
            { 
                status: 'muted',
                resolvedAt: new Date(),
                resolvedBy: req.admin.email
            },
            { new: true }
        );
        res.json(incident);
    } catch (err) {
        res.status(500).json({ error: 'Failed to mute incident' });
    }
});

app.post('/api/admin/incidents/:id/blacklist', requireAdmin, async (req, res) => {
    try {
        const incident = await Incident.findById(req.params.id);
        if (!incident) return res.status(404).json({ error: 'Incident not found' });
        
        const { duration = '24h', reason } = req.body;
        
        let expiresAt = null;
        let durationLabel = 'permanent';
        
        if (duration !== 'permanent') {
            const durationMap = {
                '24h': 24 * 60 * 60 * 1000,
                '1w': 7 * 24 * 60 * 60 * 1000,
                '1m': 30 * 24 * 60 * 60 * 1000
            };
            if (durationMap[duration]) {
                expiresAt = new Date(Date.now() + durationMap[duration]);
                durationLabel = duration;
            }
        }
        
        const blocked = await BlockedIP.findOneAndUpdate(
            { ip: incident.ip },
            { 
                ip: incident.ip,
                type: 'ip',
                reason: reason || `Incident #${incident._id} - ${incident.failedAttempts} failed attempts`,
                blockedBy: req.admin.email,
                blockedAt: new Date(),
                expiresAt,
                duration: durationLabel
            },
            { upsert: true, new: true }
        );
        
        // Mark incident as resolved
        await Incident.findByIdAndUpdate(req.params.id, {
            status: 'resolved',
            resolvedAt: new Date(),
            resolvedBy: req.admin.email
        });
        
        console.log(`IP ${incident.ip} blacklisted by ${req.admin.email} (${durationLabel})`);
        res.json(blocked);
    } catch (err) {
        console.error('Blacklist error:', err);
        res.status(500).json({ error: 'Failed to blacklist' });
    }
});

app.get('/api/admin/blocked-ips', requireAdmin, async (req, res) => {
    try {
        // Clean up expired blocks first
        await BlockedIP.deleteMany({
            expiresAt: { $ne: null, $lt: new Date() }
        });
        
        const blocked = await BlockedIP.find().sort({ blockedAt: -1 });
        res.json(blocked);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch blocked IPs' });
    }
});

app.post('/api/admin/block-ip', requireAdmin, async (req, res) => {
    try {
        const { ip, reason, duration = 'permanent' } = req.body;
        if (!ip) return res.status(400).json({ error: 'IP address required' });
        
        let expiresAt = null;
        let durationLabel = 'permanent';
        
        if (duration !== 'permanent') {
            const durationMap = {
                '24h': 24 * 60 * 60 * 1000,
                '1w': 7 * 24 * 60 * 60 * 1000,
                '1m': 30 * 24 * 60 * 60 * 1000
            };
            if (durationMap[duration]) {
                expiresAt = new Date(Date.now() + durationMap[duration]);
                durationLabel = duration;
            }
        }
        
        const blocked = await BlockedIP.findOneAndUpdate(
            { ip },
            { 
                ip,
                type: 'ip',
                reason: reason || 'Blocked by admin',
                blockedBy: req.admin.email,
                blockedAt: new Date(),
                expiresAt,
                duration: durationLabel
            },
            { upsert: true, new: true }
        );
        
        console.log(`IP ${ip} blocked by ${req.admin.email} (${durationLabel}). Reason: ${reason || 'None'}`);
        res.json(blocked);
    } catch (err) {
        console.error('Block IP error:', err);
        res.status(500).json({ error: 'Failed to block IP' });
    }
});

app.delete('/api/admin/block-ip/:ip', requireAdmin, async (req, res) => {
    try {
        const ip = req.params.ip;
        await BlockedIP.deleteOne({ ip });
        console.log(`IP ${ip} unblocked by ${req.admin.email}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to unblock IP' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`));