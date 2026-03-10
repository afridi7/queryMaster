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

// seed admin and host users if they don't exist
async function seedPrivilegedUsers() {
  try {
    const adminExists = await User.findOne({ role: 'admin' });
    if (!adminExists) {
      const hashedAdmin = await bcrypt.hash('admin', 6); //changable
      await User.create({ username: 'admin', password: hashedAdmin, role: 'admin' });
      console.log('admin user created in database');
    }

    const hostExists = await User.findOne({ role: 'host' });
    if (!hostExists) {
      const hashedHost = await bcrypt.hash('host', 9); //changable
      await User.create({ username: 'host', password: hashedHost, role: 'host' });
      console.log('host user created in database');
    }
  } catch (err) {
    console.error('failed to seed users:', err);
  }
}

connectDB().then(seedPrivilegedUsers);

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
    // explicitly force role to 'user' so someone cannot inject an admin role
    await User.create({ username, password: hashedPassword, role: 'user' });

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

    // return the role back to the client
    res.json({ ok: true, username: user.username, role: user.role });
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
      // record the exact start time for time-based scoring
      room.questionStartedAt = Date.now();
      room.question = {
        text,
        options,
        correctIndex,
        duration,
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
      const maxTime = room.question.duration || 15000;

      Object.entries(room.submissions).forEach(([sid, sub]) => {
        if (sub.choice === correctIdx) {
          // calculate speed bonus points
          const timeBonus = Math.round(500 * (1 - (sub.timeTaken / maxTime)));
          const pointsEarned = 500 + Math.max(0, timeBonus);
          
          room.scores[sid] = (room.scores[sid] || 0) + pointsEarned;
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

    socket.on('close_room', () => {
      if (!room) return;
      if (room.timer) clearTimeout(room.timer);
      
      // notify all clients
      io.emit('room_closed');

      // reset everything
      room = null;
      io.emit('clients', []);
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

      // capture the exact time taken to submit
      const timeTaken = Date.now() - room.questionStartedAt;

      room.submissions[socket.id] = { choice: idx, timeTaken };
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