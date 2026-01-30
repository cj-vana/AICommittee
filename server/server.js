const { readFileSync } = require('fs');
const path = require('path');

// Load .env file (no extra dependency)
try {
  const envPath = path.join(__dirname, '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch {}

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const http = require('http');
const ngrok = require('@ngrok/ngrok');

const app = express();
app.use(cors());
app.use(express.json());

// ── SQLite setup ──
const db = new Database(path.join(__dirname, 'votes.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(poll_id, voter_id)
  )
`);

const upsertVote = db.prepare(`
  INSERT INTO votes (poll_id, voter_id, value)
  VALUES (@poll_id, @voter_id, @value)
  ON CONFLICT(poll_id, voter_id) DO UPDATE SET value = @value, created_at = CURRENT_TIMESTAMP
`);

const getVotes = db.prepare(`SELECT value FROM votes WHERE poll_id = ?`);
const clearAll = db.prepare(`DELETE FROM votes`);

// ── Poll configuration ──
const POLLS = {
  '1': {
    question: 'Have you used AI for work in the past month?',
    type: 'mc',
    options: ['Yes, regularly', 'Yes, a few times', 'No, but I\'m curious', 'What\'s AI?']
  },
  '2': {
    question: 'What GS/production task would you want AI to help with?',
    type: 'open',
    options: []
  },
  '3': {
    question: 'How confident are you in using AI for work?',
    type: 'likert',
    options: ['1 — Not at all', '2 — A little nervous', '3 — Somewhat confident', '4 — Pretty confident', '5 — I\'m already an AI pro']
  },
  '4': {
    question: 'What AI tools have you heard of?',
    type: 'multi',
    options: ['ChatGPT', 'Microsoft Copilot', 'Google Gemini', 'Claude', 'ElevenLabs', 'Midjourney / DALL-E', 'None of these']
  },
  '5': {
    question: 'What\'s your biggest concern about using AI?',
    type: 'open',
    options: []
  },
  '6': {
    question: 'How many of you have clients that use AI?',
    type: 'mc',
    options: ['Yes, several clients', 'Yes, a few', 'Not that I know of', 'I\'m not sure']
  }
};

// ── Aggregate results for a poll ──
function aggregateResults(pollId) {
  const rows = getVotes.all(pollId);
  const poll = POLLS[pollId];
  if (!poll) return { total: 0, results: [] };

  if (poll.type === 'open') {
    return {
      total: rows.length,
      results: rows.map(r => r.value).reverse()
    };
  }

  if (poll.type === 'multi') {
    // Each vote value is JSON array of selected options
    const counts = {};
    poll.options.forEach(o => { counts[o] = 0; });
    let totalVoters = rows.length;
    rows.forEach(r => {
      try {
        const selected = JSON.parse(r.value);
        selected.forEach(s => {
          counts[s] = (counts[s] || 0) + 1;
        });
      } catch { /* ignore bad data */ }
    });
    return {
      total: totalVoters,
      results: Object.entries(counts).map(([label, count]) => ({ label, count }))
    };
  }

  if (poll.type === 'mc-writein') {
    const counts = {};
    const writeIns = [];
    poll.options.forEach(o => { counts[o] = 0; });
    counts['Other'] = 0;
    rows.forEach(r => {
      if (poll.options.includes(r.value)) {
        counts[r.value]++;
      } else {
        counts['Other']++;
        writeIns.push(r.value);
      }
    });
    return {
      total: rows.length,
      results: Object.entries(counts).map(([label, count]) => ({ label, count })),
      writeIns: writeIns.reverse()
    };
  }

  // mc or likert — simple count per option
  const counts = {};
  (poll.options || []).forEach(o => { counts[o] = 0; });
  rows.forEach(r => {
    counts[r.value] = (counts[r.value] || 0) + 1;
  });

  const results = Object.entries(counts).map(([label, count]) => ({ label, count }));

  if (poll.type === 'likert') {
    let sum = 0, n = 0;
    rows.forEach(r => {
      const num = parseInt(r.value);
      if (!isNaN(num)) { sum += num; n++; }
    });
    return { total: rows.length, results, average: n > 0 ? (sum / n).toFixed(1) : '0.0' };
  }

  return { total: rows.length, results };
}

// ── API routes ──

app.post('/api/vote', (req, res) => {
  const { poll, value, voterId } = req.body;
  if (!poll || !value || !voterId) {
    return res.status(400).json({ error: 'Missing poll, value, or voterId' });
  }
  if (!POLLS[poll]) {
    return res.status(400).json({ error: 'Invalid poll ID' });
  }
  try {
    upsertVote.run({ poll_id: poll, voter_id: voterId, value: typeof value === 'string' ? value : JSON.stringify(value) });
    const results = aggregateResults(poll);
    // Broadcast to all WebSocket clients
    broadcast({ type: 'vote', poll, results });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/results/:pollId', (req, res) => {
  const { pollId } = req.params;
  if (!POLLS[pollId]) return res.status(404).json({ error: 'Poll not found' });
  res.json(aggregateResults(pollId));
});

app.get('/api/reset', (req, res) => {
  clearAll.run();
  // Broadcast reset to all clients
  Object.keys(POLLS).forEach(pid => {
    broadcast({ type: 'vote', poll: pid, results: aggregateResults(pid) });
  });
  res.json({ ok: true, message: 'All votes cleared' });
});

app.get('/api/polls', (req, res) => {
  res.json(POLLS);
});

// ── Public tunnel URL (set once ngrok connects) ──
let publicUrl = '';

app.get('/api/tunnel', (req, res) => {
  res.json({ url: publicUrl });
});

// ── Serve presentation files from parent directory ──
// (API and /vote routes take priority since they're defined first)
app.use(express.static(path.join(__dirname, '..')));

// ── Vote page ──
app.get('/vote', (req, res) => {
  const pollId = req.query.poll;
  res.send(votePage(pollId));
});

function votePage(pollId) {
  const poll = POLLS[pollId];
  const pollJSON = poll ? JSON.stringify(poll) : 'null';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>Vote — AI Committee</title>
<style>
  :root { --bg: #0a0a0a; --surface: #141414; --red: #e10600; --white: #f0f0f0; --gray: #888; --dim: #444; --green: #00ff87; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--white); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; min-height: 100dvh; display: flex; flex-direction: column; align-items: center; padding: 24px 16px; }
  .container { max-width: 480px; width: 100%; }
  h1 { font-size: 1.1rem; color: var(--red); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px; font-weight: 700; }
  h2 { font-size: 1.3rem; line-height: 1.3; margin-bottom: 24px; font-weight: 600; }
  .option-card { display: block; width: 100%; padding: 16px 20px; margin-bottom: 10px; background: var(--surface); border: 2px solid var(--dim); border-radius: 12px; color: var(--white); font-size: 1.05rem; text-align: left; cursor: pointer; transition: all 0.15s; -webkit-tap-highlight-color: transparent; min-height: 56px; display: flex; align-items: center; }
  .option-card:active, .option-card.selected { border-color: var(--red); background: rgba(225,6,0,0.12); }
  .option-card.selected::before { content: '✓ '; color: var(--red); font-weight: 700; margin-right: 8px; }
  .likert-row { display: flex; gap: 8px; margin-bottom: 24px; }
  .likert-btn { flex: 1; aspect-ratio: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; background: var(--surface); border: 2px solid var(--dim); border-radius: 12px; color: var(--white); font-size: 1.5rem; font-weight: 700; cursor: pointer; transition: all 0.15s; -webkit-tap-highlight-color: transparent; min-height: 56px; }
  .likert-btn span { font-size: 0.6rem; color: var(--gray); margin-top: 2px; font-weight: 400; }
  .likert-btn:active, .likert-btn.selected { border-color: var(--red); background: rgba(225,6,0,0.15); }
  textarea, input[type="text"] { width: 100%; padding: 16px; background: var(--surface); border: 2px solid var(--dim); border-radius: 12px; color: var(--white); font-size: 1.05rem; font-family: inherit; resize: none; margin-bottom: 16px; }
  textarea:focus, input[type="text"]:focus { outline: none; border-color: var(--red); }
  .submit-btn { width: 100%; padding: 18px; background: var(--red); color: #fff; border: none; border-radius: 12px; font-size: 1.1rem; font-weight: 700; cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em; transition: opacity 0.15s; }
  .submit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .submit-btn:active:not(:disabled) { opacity: 0.8; }
  .confirmation { text-align: center; padding: 40px 20px; }
  .confirmation .check { font-size: 3rem; margin-bottom: 16px; }
  .confirmation h2 { color: var(--green); }
  .confirmation p { color: var(--gray); margin-top: 12px; }
  .change-btn { margin-top: 20px; padding: 12px 24px; background: var(--surface); border: 1px solid var(--dim); border-radius: 8px; color: var(--gray); font-size: 0.9rem; cursor: pointer; }
  .error-msg { color: var(--red); text-align: center; padding: 40px; }
  .writein-input { margin-top: 10px; }
</style>
</head>
<body>
<div class="container" id="app"></div>
<script>
(function() {
  const POLL_ID = ${JSON.stringify(pollId)};
  const POLL = ${pollJSON};
  const app = document.getElementById('app');

  if (!POLL_ID || !POLL) {
    app.innerHTML = '<div class="error-msg"><h2>Poll not found</h2><p>Check the QR code and try again.</p></div>';
    return;
  }

  // Voter ID — persistent per device
  let voterId = localStorage.getItem('poll_voter_id');
  if (!voterId) {
    voterId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('poll_voter_id', voterId);
  }

  const voteKey = 'poll_vote_' + POLL_ID;
  const previousVote = localStorage.getItem(voteKey);

  if (previousVote) {
    showConfirmation(previousVote);
    return;
  }

  renderPoll();

  function renderPoll() {
    let html = '<h1>Audience Poll</h1><h2>' + escapeHtml(POLL.question) + '</h2>';

    if (POLL.type === 'mc') {
      html += '<div id="options">';
      POLL.options.forEach((opt, i) => {
        html += '<button class="option-card" data-idx="' + i + '" data-value="' + escapeAttr(opt) + '">' + escapeHtml(opt) + '</button>';
      });
      html += '</div>';
      app.innerHTML = html;
      let selected = null;
      app.querySelectorAll('.option-card').forEach(btn => {
        btn.addEventListener('click', () => {
          app.querySelectorAll('.option-card').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          selected = btn.dataset.value;
          submitVote(selected);
        });
      });

    } else if (POLL.type === 'likert') {
      const labels = ['Not at all', 'A little', 'Somewhat', 'Pretty', 'Pro'];
      html += '<div class="likert-row">';
      for (let i = 1; i <= 5; i++) {
        html += '<button class="likert-btn" data-value="' + i + '">' + i + '<span>' + labels[i-1] + '</span></button>';
      }
      html += '</div>';
      app.innerHTML = html;
      app.querySelectorAll('.likert-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          app.querySelectorAll('.likert-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          submitVote(btn.dataset.value);
        });
      });

    } else if (POLL.type === 'open') {
      html += '<textarea id="text-input" rows="3" placeholder="Type your answer..."></textarea>';
      html += '<button class="submit-btn" id="submit-btn" disabled>Submit</button>';
      app.innerHTML = html;
      const inp = document.getElementById('text-input');
      const btn = document.getElementById('submit-btn');
      inp.addEventListener('input', () => { btn.disabled = !inp.value.trim(); });
      btn.addEventListener('click', () => { if (inp.value.trim()) submitVote(inp.value.trim()); });

    } else if (POLL.type === 'multi') {
      html += '<div id="options">';
      POLL.options.forEach((opt, i) => {
        html += '<button class="option-card" data-value="' + escapeAttr(opt) + '">' + escapeHtml(opt) + '</button>';
      });
      html += '</div>';
      html += '<button class="submit-btn" id="submit-btn" disabled style="margin-top:16px">Submit</button>';
      app.innerHTML = html;
      const selected = new Set();
      const btn = document.getElementById('submit-btn');
      app.querySelectorAll('.option-card').forEach(card => {
        card.addEventListener('click', () => {
          const val = card.dataset.value;
          if (selected.has(val)) { selected.delete(val); card.classList.remove('selected'); }
          else { selected.add(val); card.classList.add('selected'); }
          btn.disabled = selected.size === 0;
        });
      });
      btn.addEventListener('click', () => {
        if (selected.size > 0) submitVote(JSON.stringify([...selected]));
      });

    } else if (POLL.type === 'mc-writein') {
      html += '<div id="options">';
      POLL.options.forEach((opt, i) => {
        html += '<button class="option-card" data-value="' + escapeAttr(opt) + '">' + escapeHtml(opt) + '</button>';
      });
      html += '</div>';
      html += '<div class="writein-input"><input type="text" id="writein" placeholder="Or write your own suggestion..."></div>';
      html += '<button class="submit-btn" id="submit-btn" disabled style="margin-top:16px">Submit</button>';
      app.innerHTML = html;
      let selectedVal = null;
      const btn = document.getElementById('submit-btn');
      const writein = document.getElementById('writein');
      app.querySelectorAll('.option-card').forEach(card => {
        card.addEventListener('click', () => {
          app.querySelectorAll('.option-card').forEach(b => b.classList.remove('selected'));
          card.classList.add('selected');
          selectedVal = card.dataset.value;
          writein.value = '';
          btn.disabled = false;
        });
      });
      writein.addEventListener('input', () => {
        if (writein.value.trim()) {
          app.querySelectorAll('.option-card').forEach(b => b.classList.remove('selected'));
          selectedVal = null;
          btn.disabled = false;
        } else if (!selectedVal) {
          btn.disabled = true;
        }
      });
      btn.addEventListener('click', () => {
        const val = writein.value.trim() || selectedVal;
        if (val) submitVote(val);
      });
    }
  }

  function submitVote(value) {
    fetch(window.location.origin + '/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poll: POLL_ID, value: value, voterId: voterId })
    })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        localStorage.setItem(voteKey, value);
        showConfirmation(value);
      }
    })
    .catch(() => {
      showConfirmation(value);
      localStorage.setItem(voteKey, value);
    });
  }

  function showConfirmation(value) {
    let display = value;
    try { const arr = JSON.parse(value); if (Array.isArray(arr)) display = arr.join(', '); } catch {}
    app.innerHTML =
      '<div class="confirmation">' +
      '<div class="check">&#10003;</div>' +
      '<h2>Vote Recorded!</h2>' +
      '<p>Your answer: ' + escapeHtml(display) + '</p>' +
      '<button class="change-btn" id="change-btn">Change my answer</button>' +
      '</div>';
    document.getElementById('change-btn').addEventListener('click', () => {
      localStorage.removeItem(voteKey);
      renderPoll();
    });
  }

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function escapeAttr(s) { return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
})();
</script>
</body>
</html>`;
}

// ── HTTP server + WebSocket ──
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();
wss.on('connection', ws => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    try { ws.send(msg); } catch { /* ignore */ }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  const localUrl = `http://localhost:${PORT}`;
  console.log(`Poll server running on ${localUrl}`);

  // Auto-start ngrok tunnel
  try {
    const listener = await ngrok.forward({ addr: PORT, authtoken_from_env: true });
    publicUrl = listener.url();
    console.log(`\nngrok tunnel:  ${publicUrl}`);
    console.log(`Vote page:     ${publicUrl}/vote?poll=1`);
    console.log(`Reset:         ${publicUrl}/api/reset`);
    // Tell all connected presentation clients about the tunnel URL
    broadcast({ type: 'tunnel', url: publicUrl });
  } catch (err) {
    console.error(`\nngrok failed: ${err.message}`);
    console.log('Set NGROK_AUTHTOKEN or run "ngrok http 3000" manually and use Ctrl+Shift+P in the presentation.');
  }

  // Auto-open presentation in default browser
  const { exec } = require('child_process');
  const cmd = process.platform === 'darwin' ? 'open' :
              process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${cmd} ${localUrl}`);
});
