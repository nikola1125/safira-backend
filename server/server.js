const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const app = express();

require('dotenv').config();

app.use(cors({
    origin: [
        'https://villasafira.space',
        'https://www.villasafira.space',
        'http://localhost:5000' // For development
    ]
}));
app.use(express.json());
// app.use(express.static(path.join(__dirname, 'dist')));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Review Model
const reviewSchema = new mongoose.Schema({
    name: {type: String, required: true},
    country: {type: String, required: true},
    comment: {type: String, required: true},
    rating: {type: Number, required: true, min: 1, max: 5},
    date: {type: Date, default: Date.now}
});
const Review = mongoose.model('Review', reviewSchema);

// Routes

app.post('/api/reviews', async (req, res) => {
    try {
        const review = new Review(req.body);
        await review.save();
        res.status(201).json(review);
    } catch (err) {
        res.status(400).json({error: err.message});
    }
});

app.get('/api/reviews', async (req, res) => {
    try {
        const reviews = await Review.find({}).sort({date: -1});
        res.json(reviews);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// app.get('*', (req, res) => {
//     res.sendFile(path.join(__dirname, 'dist', 'index.html'));
// });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));