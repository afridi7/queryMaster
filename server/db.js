const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('mongo uri missing');
    process.exit(1);
  }
  try {
    await mongoose.connect(uri);
    console.log('mongodb connected');
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
module.exports = connectDB;