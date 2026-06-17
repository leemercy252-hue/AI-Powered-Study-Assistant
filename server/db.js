const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(()=>{
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    email TEXT,
    provider TEXT,
    plan TEXT,
    status TEXT,
    tx_ref TEXT,
    created_at INTEGER,
    raw TEXT
  )`);
});

module.exports = db;
