const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true, trim: true },
  password: { type: String, required: true }
}, { versionKey: false });

module.exports = mongoose.model('User', userSchema);