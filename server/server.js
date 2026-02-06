const express = require('express');
const http = require('http');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const connectDB = require('./db');
const User = require('./models/User');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

connectDB();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let room = null;

//auth
app.post('/register', async (req, res) => {
  try {
    let { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'missing fields' });
    username = String(username).trim();
    const existing = await User.findOne({ username });
    if (existing) return res.status(409).json({ error: 'user already exists' });
    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, password: hashedPassword });
    res.json({ ok: true, username });
  } catch (err) { res.status(500).json({ error: 'server error' }); }
});

app.post('/login', async (req, res) => {
  try {
    let { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'missing fields' });
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'invalid credentials' });
    res.json({ ok: true, username });
  } catch (err) { res.status(500).json({ error: 'server error' }); }
});

//socket logic

io.on('connection', socket => {
  const { role, username } = socket.handshake.query;

  //admin
  if (role === 'admin') {
    socket.on('create_room', () => {
      if (room?.timer) clearTimeout(room.timer);
      room = {
        participants: {},
        scores: {},
        question: null,
        submissions: {},
        stats: [],
        revealed: false,
        timer: null
      };
      io.emit('room_created');
    });

    socket.on('open_question', ({ text, options, correctIndex, duration }) => {
      if (!room) return;
      clearTimeout(room.timer);

      room.question = { text, options, correctIndex, endsAt: Date.now() + duration };
      room.submissions = {};
      room.stats = Array(options.length).fill(0);
      room.revealed = false;

      io.emit('question_open', { text, options, endsAt: room.question.endsAt });

      room.timer = setTimeout(() => io.emit('submission_closed'), duration);
    });

    socket.on('reveal', () => {
      if (!room?.question || room.revealed) return;
      room.revealed = true;

      //calculate scores
      const correctIdx = room.question.correctIndex;
      Object.entries(room.submissions).forEach(([socketId, answerIdx]) => {
        if (answerIdx === correctIdx) {
          //if score is 0, add 100 points
          room.scores[socketId] = (room.scores[socketId] || 0) + 100;
        }
      });

      //leaderboard(only top 10)
      const leaderboard = Object.keys(room.participants)
        .map(sid => ({
          username: room.participants[sid],
          score: room.scores[sid] || 0
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

      io.emit('reveal', { 
        correctIndex: correctIdx, 
        stats: room.stats,
        leaderboard
      });
    });
    return;
  }

  //players and host
  if (room) socket.emit('room_created');

  if (room?.question) {
    socket.emit('question_open', {
      text: room.question.text,
      options: room.question.options,
      endsAt: room.question.endsAt
    });
    if (room.revealed) {
      //recalculate leaderboard for late joiners
      const leaderboard = Object.keys(room.participants)
        .map(sid => ({ username: room.participants[sid], score: room.scores[sid] || 0 }))
        .sort((a, b) => b.score - a.score).slice(0, 10);

      socket.emit('reveal', { 
        correctIndex: room.question.correctIndex, 
        stats: room.stats,
        leaderboard 
      });
    }
  }

  if (username && room) {
    room.participants[socket.id] = username;
    //ensure score init
    if (!room.scores[socket.id]) room.scores[socket.id] = 0;

    socket.on('submit', idx => {
      if (!room?.question) return;
      if (Date.now() > room.question.endsAt) return;
      if (room.submissions[socket.id] !== undefined) return;
      if (idx < 0 || idx >= room.stats.length) return;

      room.submissions[socket.id] = idx;
      room.stats[idx]++;
      io.emit('live_stats', room.stats);
    });

    socket.on('disconnect', () => {
      //we keep scores even if disconnected briefly
      if (room?.participants) delete room.participants[socket.id];
    });
  }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`server running on port ${PORT}`);
});
