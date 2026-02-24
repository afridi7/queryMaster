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

/* AUTH */

app.post('/register', async (req, res) => {
  try {
    let { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'missing fields' });

    username = String(username).trim();

    const existing = await User.findOne({ username });
    if (existing)
      return res.status(409).json({ error: 'user already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await User.create({ username, password: hashedPassword });

    res.json({ ok: true, username });
  } catch {
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/login', async (req, res) => {
  try {
    let { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'missing fields' });

    const user = await User.findOne({ username });
    if (!user)
      return res.status(401).json({ error: 'invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ error: 'invalid credentials' });

    res.json({ ok: true, username });
  } catch {
    res.status(500).json({ error: 'server error' });
  }
});

/* SOCKET */

io.on('connection', socket => {
  const { role, username } = socket.handshake.query;

  /* ADMIN */

  if (role === 'admin') {

    socket.on('create_room', () => {
      if (room?.timer) clearTimeout(room.timer);

      room = {
        participants: {}, // socket.id -> { username, code }
        scores: {},
        question: null,
        submissions: {},
        stats: [],
        revealed: false,
        timer: null
      };

      io.emit('room_created');
      io.emit('clients', []);
    });

    socket.on('open_question', ({ text, options, correctIndex, duration }) => {
      if (!room) return;

      clearTimeout(room.timer);

      room.question = {
        text,
        options,
        correctIndex,
        endsAt: Date.now() + duration
      };

      room.submissions = {};
      room.stats = Array(options.length).fill(0);
      room.revealed = false;

      io.emit('question_open', {
        text,
        options,
        endsAt: room.question.endsAt
      });

      io.emit('live_stats', {
        total: 0,
        counts: room.stats
      });

      room.timer = setTimeout(() => {
        io.emit('submission_closed');
      }, duration);
    });

    socket.on('reveal', () => {
      if (!room?.question || room.revealed) return;

      room.revealed = true;
      const correctIdx = room.question.correctIndex;

      Object.entries(room.submissions).forEach(([sid, answerIdx]) => {
        if (answerIdx === correctIdx) {
          room.scores[sid] = (room.scores[sid] || 0) + 100;
        }
      });

      const leaderboard = buildLeaderboard(10);

      io.emit('reveal', {
        correctIndex: correctIdx,
        stats: room.stats,
        leaderboard
      });
    });

    socket.on('reveal_winners', () => {
      if (!room) return;
      const top3 = buildLeaderboard(3);
      io.emit('show_winners', top3);
    });

    return;
  }

  /* PLAYERS/HOST */

  if (room) {
    socket.emit('room_created');
  }

  if (room?.question) {
    socket.emit('question_open', {
      text: room.question.text,
      options: room.question.options,
      endsAt: room.question.endsAt
    });

    if (room.revealed) {
      socket.emit('reveal', {
        correctIndex: room.question.correctIndex,
        stats: room.stats,
        leaderboard: buildLeaderboard(10)
      });
    }
  }

  /* PARTICIPANT REGISTRATION */

  if (username && room) {

    // Generate unique 4-char code
    function generateCode() {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let code;

      do {
        code = "";
        for (let i = 0; i < 4; i++) {
          code += chars[Math.floor(Math.random() * chars.length)];
        }
      } while (
        Object.values(room.participants)
          .some(p => p.code === code)
      );

      return code;
    }

    const code = generateCode();

    room.participants[socket.id] = { username, code };
    room.scores[socket.id] = room.scores[socket.id] || 0;

    socket.emit('your_code', code);

    io.emit('clients',
      Object.values(room.participants)
        .map(p => `${p.username} (${p.code})`)
    );

    socket.on('submit', idx => {
      if (!room?.question) return;
      if (Date.now() > room.question.endsAt) return;
      if (room.submissions[socket.id] !== undefined) return;
      if (idx < 0 || idx >= room.stats.length) return;

      room.submissions[socket.id] = idx;
      room.stats[idx]++;

      io.emit('live_stats', {
        total: Object.keys(room.submissions).length,
        counts: room.stats
      });
    });

    socket.on('disconnect', () => {
      if (room?.participants) {
        delete room.participants[socket.id];

        io.emit('clients',
          Object.values(room.participants)
            .map(p => `${p.username} (${p.code})`)
        );
      }
    });
  }

});

/* LEADERBOARD BUILDER */

function buildLeaderboard(limit) {
  return Object.keys(room.participants)
    .map(sid => ({
      username: room.participants[sid].username,
      code: room.participants[sid].code,
      score: room.scores[sid] || 0
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.code.localeCompare(b.code); // tie-breaker
    })
    .slice(0, limit);
}

/* SERVER START */

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`server running on port ${PORT}`);
});