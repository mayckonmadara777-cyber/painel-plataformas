require("dotenv").config();

const express = require("express");
const pg = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const path = require("path");

const app = express();
const { Pool } = pg;

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

if (!process.env.DATABASE_URL || !JWT_SECRET || !ADMIN_PHONE || !ADMIN_PASSWORD) {
  console.warn("ATENÇÃO: configure DATABASE_URL, JWT_SECRET, ADMIN_PHONE e ADMIN_PASSWORD no Render.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function signUser(user) {
  return jwt.sign(
    { id: user.id, phone: user.phone, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  try {
    const token = req.cookies.panel_token;
    if (!token) return res.status(401).json({ error: "Não autenticado." });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Sessão expirada." });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Acesso somente para administrador." });
  }
  next();
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(30) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'client',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS platforms (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      url TEXT NOT NULL,
      description TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_platforms_created_at
    ON platforms(created_at DESC);
  `);

  const existing = await pool.query(
    "SELECT id FROM users WHERE phone = $1 LIMIT 1",
    [ADMIN_PHONE]
  );

  if (existing.rowCount === 0 && ADMIN_PHONE && ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    await pool.query(
      "INSERT INTO users (phone, password_hash, role) VALUES ($1, $2, 'admin')",
      [ADMIN_PHONE, hash]
    );
    console.log("Administrador criado:", ADMIN_PHONE);
  }
}

app.post("/api/login", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "");

    if (!phone || !password) {
      return res.status(400).json({ error: "Informe número e senha." });
    }

    const result = await pool.query(
      "SELECT id, phone, password_hash, role FROM users WHERE phone = $1 LIMIT 1",
      [phone]
    );

    if (!result.rowCount) {
      return res.status(401).json({ error: "Número ou senha incorretos." });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: "Número ou senha incorretos." });
    }

    const token = signUser(user);

    res.cookie("panel_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      user: { id: user.id, phone: user.phone, role: user.role }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro interno ao entrar." });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("panel_token");
  res.json({ ok: true });
});

app.get("/api/me", auth, async (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/platforms", auth, async (req, res) => {
  const result = await pool.query(`
    SELECT id, name, url, description, image_url, created_at
    FROM platforms
    ORDER BY created_at DESC
  `);
  res.json({ platforms: result.rows });
});

app.post("/api/admin/users", auth, adminOnly, async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "");

    if (!phone || password.length < 4) {
      return res.status(400).json({ error: "Número e senha são obrigatórios. A senha deve ter pelo menos 4 caracteres." });
    }

    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (phone, password_hash, role)
       VALUES ($1, $2, 'client')
       RETURNING id, phone, role, created_at`,
      [phone, hash]
    );

    res.status(201).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Esse número já está cadastrado." });
    }
    console.error(error);
    res.status(500).json({ error: "Não foi possível cadastrar o cliente." });
  }
});

app.get("/api/admin/users", auth, adminOnly, async (req, res) => {
  const result = await pool.query(`
    SELECT id, phone, role, created_at
    FROM users
    WHERE role = 'client'
    ORDER BY created_at DESC
  `);
  res.json({ users: result.rows });
});

app.delete("/api/admin/users/:id", auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Cliente inválido." });

  await pool.query("DELETE FROM users WHERE id = $1 AND role = 'client'", [id]);
  res.json({ ok: true });
});

app.post("/api/admin/platforms", auth, adminOnly, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const url = String(req.body.url || "").trim();
    const description = String(req.body.description || "").trim();
    const imageUrl = String(req.body.image_url || "").trim();

    if (!name || !url) {
      return res.status(400).json({ error: "Nome e link são obrigatórios." });
    }

    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "O link precisa começar com http:// ou https://." });
    }

    if (imageUrl) {
      const imageParsed = new URL(imageUrl);
      if (!["http:", "https:"].includes(imageParsed.protocol)) {
        return res.status(400).json({ error: "A imagem precisa ser uma URL http/https." });
      }
    }

    const result = await pool.query(
      `INSERT INTO platforms (name, url, description, image_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, url, description, image_url, created_at`,
      [name, url, description, imageUrl]
    );

    res.status(201).json({ platform: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Não foi possível cadastrar a plataforma." });
  }
});

app.put("/api/admin/platforms/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body.name || "").trim();
    const url = String(req.body.url || "").trim();
    const description = String(req.body.description || "").trim();
    const imageUrl = String(req.body.image_url || "").trim();

    if (!Number.isInteger(id) || !name || !url) {
      return res.status(400).json({ error: "Dados inválidos." });
    }

    new URL(url);
    if (imageUrl) new URL(imageUrl);

    const result = await pool.query(
      `UPDATE platforms
       SET name = $1, url = $2, description = $3, image_url = $4
       WHERE id = $5
       RETURNING id, name, url, description, image_url, created_at`,
      [name, url, description, imageUrl, id]
    );

    if (!result.rowCount) return res.status(404).json({ error: "Plataforma não encontrada." });
    res.json({ platform: result.rows[0] });
  } catch {
    res.status(400).json({ error: "Confira os dados da plataforma." });
  }
});

app.delete("/api/admin/platforms/:id", auth, adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Plataforma inválida." });

  await pool.query("DELETE FROM platforms WHERE id = $1", [id]);
  res.json({ ok: true });
});

// Fallback da SPA sem usar app.get("*"), evitando o erro PathError do Express 5.
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/")) {
    return res.sendFile(path.join(__dirname, "public", "index.html"));
  }
  next();
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Painel rodando na porta ${PORT}`));
  })
  .catch((error) => {
    console.error("Falha ao iniciar banco:", error);
    process.exit(1);
  });
