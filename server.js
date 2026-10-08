require("dotenv").config();

const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

for (const key of [
  "DATABASE_URL",
  "JWT_SECRET",
  "ADMIN_PHONE",
  "ADMIN_PASSWORD"
]) {
  if (!process.env[key]) {
    console.error(`Variável obrigatória ausente: ${key}`);
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      phone: user.phone,
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  try {
    const token = req.cookies.panel_token;

    if (!token) {
      return res.status(401).json({
        error: "Não autenticado."
      });
    }

    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({
      error: "Sessão inválida ou expirada."
    });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      error: "Acesso restrito ao administrador."
    });
  }

  next();
}

async function initDatabase() {
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
      name VARCHAR(150) NOT NULL,
      url TEXT NOT NULL,
      description TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_platforms_created_at
    ON platforms(created_at DESC);
  `);

  const adminPhone = normalizePhone(process.env.ADMIN_PHONE);
  const adminPassword = String(process.env.ADMIN_PASSWORD);

  const existing = await pool.query(
    "SELECT id FROM users WHERE phone = $1 LIMIT 1",
    [adminPhone]
  );

  if (!existing.rowCount) {
    const passwordHash = await bcrypt.hash(adminPassword, 12);

    await pool.query(
      `INSERT INTO users
       (phone, password_hash, role)
       VALUES ($1, $2, 'admin')`,
      [adminPhone, passwordHash]
    );

    console.log("Administrador criado com sucesso.");
  } else {
    await pool.query(
      "UPDATE users SET role = 'admin' WHERE phone = $1",
      [adminPhone]
    );
  }
}

/* =========================
   TESTE DO SERVIDOR
========================= */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: true
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      database: false
    });
  }
});

/* =========================
   LOGIN
========================= */

app.post("/api/auth/login", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "");

    if (!phone || !password) {
      return res.status(400).json({
        error: "Informe telefone e senha."
      });
    }

    const result = await pool.query(
      `SELECT
        id,
        phone,
        password_hash,
        role
       FROM users
       WHERE phone = $1
       LIMIT 1`,
      [phone]
    );

    if (!result.rowCount) {
      return res.status(401).json({
        error: "Telefone ou senha inválidos."
      });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        error: "Telefone ou senha inválidos."
      });
    }

    const token = createToken(user);

    res.cookie("panel_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role
      }
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro interno no login."
    });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("panel_token");

  res.json({
    ok: true
  });
});

app.get("/api/auth/me", auth, (req, res) => {
  res.json({
    user: req.user
  });
});

/* =========================
   PLATAFORMAS
========================= */

app.get("/api/platforms", auth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        name,
        url,
        description,
        image_url,
        created_at
      FROM platforms
      ORDER BY created_at DESC
    `);

    res.json({
      platforms: result.rows
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Não foi possível carregar as plataformas."
    });
  }
});

app.post("/api/platforms", auth, adminOnly, async (req, res) => {
  try {
    const {
      name,
      url,
      description = "",
      image_url = ""
    } = req.body;

    if (!name?.trim() || !url?.trim()) {
      return res.status(400).json({
        error: "Nome e URL são obrigatórios."
      });
    }

    const result = await pool.query(
      `INSERT INTO platforms
       (name, url, description, image_url)
       VALUES ($1, $2, $3, $4)
       RETURNING
       id,
       name,
       url,
       description,
       image_url,
       created_at`,
      [
        name.trim(),
        url.trim(),
        String(description).trim(),
        String(image_url).trim()
      ]
    );

    res.status(201).json({
      platform: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao adicionar plataforma."
    });
  }
});

app.put("/api/platforms/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const {
      name,
      url,
      description = "",
      image_url = ""
    } = req.body;

    if (!Number.isInteger(id) || !name?.trim() || !url?.trim()) {
      return res.status(400).json({
        error: "Dados inválidos."
      });
    }

    const result = await pool.query(
      `UPDATE platforms
       SET
        name = $1,
        url = $2,
        description = $3,
        image_url = $4
       WHERE id = $5
       RETURNING
        id,
        name,
        url,
        description,
        image_url,
        created_at`,
      [
        name.trim(),
        url.trim(),
        String(description).trim(),
        String(image_url).trim(),
        id
      ]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Plataforma não encontrada."
      });
    }

    res.json({
      platform: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao editar plataforma."
    });
  }
});

app.delete("/api/platforms/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(
      `DELETE FROM platforms
       WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Plataforma não encontrada."
      });
    }

    res.json({
      ok: true
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao excluir plataforma."
    });
  }
});

/* =========================
   CLIENTES
========================= */

app.get("/api/clients", auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id,
        phone,
        created_at
      FROM users
      WHERE role = 'client'
      ORDER BY created_at DESC
    `);

    res.json({
      clients: result.rows
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao carregar clientes."
    });
  }
});

app.post("/api/clients", auth, adminOnly, async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "");

    if (!phone || password.length < 4) {
      return res.status(400).json({
        error: "Telefone e senha com pelo menos 4 caracteres são obrigatórios."
      });
    }

    const exists = await pool.query(
      "SELECT id FROM users WHERE phone = $1",
      [phone]
    );

    if (exists.rowCount) {
      return res.status(409).json({
        error: "Esse telefone já está cadastrado."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users
       (phone, password_hash, role)
       VALUES ($1, $2, 'client')
       RETURNING id, phone, created_at`,
      [phone, passwordHash]
    );

    res.status(201).json({
      client: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao criar cliente."
    });
  }
});

app.put("/api/clients/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "");

    if (!Number.isInteger(id) || !phone) {
      return res.status(400).json({
        error: "Dados inválidos."
      });
    }

    const duplicate = await pool.query(
      `SELECT id
       FROM users
       WHERE phone = $1
       AND id <> $2`,
      [phone, id]
    );

    if (duplicate.rowCount) {
      return res.status(409).json({
        error: "Esse telefone já está em uso."
      });
    }

    let result;

    if (password) {
      const passwordHash = await bcrypt.hash(password, 12);

      result = await pool.query(
        `UPDATE users
         SET
          phone = $1,
          password_hash = $2
         WHERE id = $3
         AND role = 'client'
         RETURNING id, phone, created_at`,
        [phone, passwordHash, id]
      );
    } else {
      result = await pool.query(
        `UPDATE users
         SET phone = $1
         WHERE id = $2
         AND role = 'client'
         RETURNING id, phone, created_at`,
        [phone, id]
      );
    }

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Cliente não encontrado."
      });
    }

    res.json({
      client: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao editar cliente."
    });
  }
});

app.delete("/api/clients/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(
      `DELETE FROM users
       WHERE id = $1
       AND role = 'client'
       RETURNING id`,
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: "Cliente não encontrado."
      });
    }

    res.json({
      ok: true
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erro ao excluir cliente."
    });
  }
});

/* =========================
   ARQUIVOS DO PAINEL
========================= */

app.use(
  express.static(__dirname, {
    index: "index.html"
  })
);

/*
  IMPORTANTE:
  Express 5 não deve usar app.get("*").
  Este fallback evita o erro:
  PathError: Missing parameter name
*/
app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    !req.path.startsWith("/api/")
  ) {
    return res.sendFile(
      path.join(__dirname, "index.html")
    );
  }

  next();
});

/* =========================
   INICIAR SERVIDOR
========================= */

initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Servidor rodando na porta ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Erro ao iniciar banco:", error);
    process.exit(1);
  });
