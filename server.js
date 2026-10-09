
require("dotenv").config();

const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 10000;

/* =========================
   VARIÁVEIS OBRIGATÓRIAS
========================= */

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

/* =========================
   BANCO DE DADOS
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

/* =========================
   MIDDLEWARES
========================= */

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* =========================
   NORMALIZAR TELEFONE
========================= */

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

/* =========================
   CRIAR TOKEN
========================= */

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

/* =========================
   AUTENTICAÇÃO
========================= */

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
  } catch (error) {
    return res.status(401).json({
      error: "Sessão inválida ou expirada."
    });
  }
}

/* =========================
   SOMENTE ADMIN
========================= */

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      error: "Acesso restrito ao administrador."
    });
  }

  next();
}

/* =========================
   VALIDAR URL
========================= */

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:"
    );
  } catch (error) {
    return false;
  }
}

/* =========================
   RESOLVER IMAGEM
========================= */

function resolveImageUrl(imageUrl, pageUrl) {
  try {
    return new URL(imageUrl, pageUrl).toString();
  } catch (error) {
    return "";
  }
}


/* =========================
   EXTRAIR IMAGEM DO SITE
========================= */

function extractMetaImage(html, pageUrl) {
  const candidates = [];
  let match;

  const metaRegex =
    /<meta\b[^>]*(?:property|name)\s*=\s*["']([^"']+)["'][^>]*>/gi;

  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const keyMatch = tag.match(
      /(?:property|name)\s*=\s*["']([^"']+)["']/i
    );
    const valueMatch = tag.match(
      /\bcontent\s*=\s*["']([^"']+)["']/i
    );

    if (!keyMatch || !valueMatch) continue;

    const key = keyMatch[1].toLowerCase();
    const value = valueMatch[1].trim();

    if (
      ["og:image", "og:image:url", "twitter:image",
       "twitter:image:src"].includes(key) &&
      value
    ) {
      candidates.push(value);
    }
  }

  const linkRegex = /<link\b[^>]*>/gi;

  while ((match = linkRegex.exec(html)) !== null) {
    const tag = match[0];
    const relMatch = tag.match(
      /\brel\s*=\s*["']([^"']+)["']/i
    );
    const hrefMatch = tag.match(
      /\bhref\s*=\s*["']([^"']+)["']/i
    );

    if (!relMatch || !hrefMatch) continue;

    const rel = relMatch[1].toLowerCase();
    const href = hrefMatch[1].trim();

    if (
      rel.includes("icon") ||
      rel.includes("apple-touch-icon")
    ) {
      candidates.push(href);
    }
  }

  for (const candidate of candidates) {
    const resolved = resolveImageUrl(candidate, pageUrl);

    if (resolved && isHttpUrl(resolved)) {
      return resolved;
    }
  }

  return "";
}

/* =========================
   BAIXAR IMAGEM E SALVAR
   COMO DATA URL
========================= */

async function downloadImageAsDataUrl(imageUrl) {
  if (!isHttpUrl(imageUrl)) return "";

  let timeout;

  try {
    const controller = new AbortController();

    timeout = setTimeout(
      () => controller.abort(),
      10000
    );

    const response = await fetch(imageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
        "Accept":
          "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8"
      }
    });

    if (!response.ok) return "";

    const contentType =
      response.headers.get("content-type") || "";

    if (!contentType.toLowerCase().startsWith("image/")) {
      return "";
    }

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/avif",
      "image/x-icon",
      "image/vnd.microsoft.icon"
    ];

    const mime = contentType
      .split(";")[0]
      .trim()
      .toLowerCase();

    if (!allowedTypes.includes(mime)) return "";

    const declaredSize = Number(
      response.headers.get("content-length") || 0
    );

    if (declaredSize > 2 * 1024 * 1024) return "";

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
      return "";
    }

    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.log(
      "Não foi possível baixar imagem:",
      error.message
    );

    return "";
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/* =========================
   BUSCAR IMAGEM AUTOMÁTICA
========================= */

async function findPlatformImage(platformUrl) {
  if (!isHttpUrl(platformUrl)) return "";

  let finalUrl = platformUrl;
  let timeout;

  try {
    const controller = new AbortController();

    timeout = setTimeout(
      () => controller.abort(),
      12000
    );

    const response = await fetch(platformUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
      }
    });

    if (!response.ok) {
      console.log(
        "Busca automática de imagem:",
        response.status
      );
      return "";
    }

    finalUrl = response.url || platformUrl;

    const contentType =
      response.headers.get("content-type") || "";

    if (contentType.startsWith("image/")) {
      return await downloadImageAsDataUrl(finalUrl);
    }

    if (!contentType.toLowerCase().includes("text/html")) {
      return "";
    }

    const html = await response.text();
    const candidates = [];

    function addCandidate(value, priority = 0) {
      if (!value) return;

      value = value.trim();

      if (/^(data:|blob:|javascript:)/i.test(value)) {
        return;
      }

      let imageUrl;

      try {
        imageUrl = new URL(value, finalUrl).href;
      } catch {
        return;
      }

      if (!isHttpUrl(imageUrl)) return;

      if (
        /pixel|tracking|spacer|placeholder|transparent|1x1/i.test(
          imageUrl
        )
      ) {
        return;
      }

      if (candidates.some(item => item.url === imageUrl)) {
        return;
      }

      candidates.push({ url: imageUrl, priority });
    }

    /* IMAGEM PRINCIPAL DO SITE */

    const metaImage = extractMetaImage(html, finalUrl);

    if (metaImage) {
      addCandidate(metaImage, 100);
    }

    /* IMAGENS DAS TAGS IMG */

    const imgTags = html.match(/<img\b[^>]*>/gi) || [];

    for (const tag of imgTags) {
      function getAttribute(name) {
        const regex = new RegExp(
          "\\b" + name + "\\s*=\\s*[\"']([^\"']+)[\"']",
          "i"
        );

        const found = tag.match(regex);
        return found ? found[1].trim() : "";
      }

      const description = [
        getAttribute("alt"),
        getAttribute("title"),
        getAttribute("class"),
        getAttribute("id"),
        getAttribute("data-testid")
      ].join(" ").toLowerCase();

      const source =
        getAttribute("data-src") ||
        getAttribute("data-lazy-src") ||
        getAttribute("data-original") ||
        getAttribute("data-image") ||
        getAttribute("src");

      let priority = 10;

      if (/logo|brand|favicon|icon/i.test(description)) {
        priority = 30;
      }

      addCandidate(source, priority);

      const srcset = getAttribute("srcset");

      if (srcset) {
        for (const entry of srcset.split(",")) {
          const responsiveSource =
            entry.trim().split(/\s+/)[0];

          addCandidate(responsiveSource, 8);
        }
      }
    }

    /* OUTRAS IMAGENS DEFINIDAS EM METADADOS */

    const metaTags = html.match(/<meta\b[^>]*>/gi) || [];

    for (const tag of metaTags) {
      if (!/(og:image|twitter:image)/i.test(tag)) continue;

      const found = tag.match(
        /\bcontent\s*=\s*["']([^"']+)["']/i
      );

      if (found) addCandidate(found[1], 40);
    }

    /* LINKS DIRETOS PARA ARQUIVOS DE IMAGEM */

    const imageRegex =
      /(?:https?:)?\/\/[^"'()\s<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^"'()\s<>]*)?|(?:\/|\.\/|\.\.\/)[^"'()\s<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^"'()\s<>]*)?/gi;

    let match;

    while ((match = imageRegex.exec(html)) !== null) {
      addCandidate(match[0], 5);
    }

    /* TENTAR BAIXAR AS MELHORES CANDIDATAS */

    candidates.sort((a, b) => b.priority - a.priority);

    for (const candidate of candidates.slice(0, 15)) {
      const image = await downloadImageAsDataUrl(candidate.url);

      if (image) {
        console.log("Imagem encontrada:", candidate.url);
        return image;
      }
    }

    /* ÚLTIMA TENTATIVA: FAVICON */

    try {
      const origin = new URL(finalUrl).origin;

      const favicon = await downloadImageAsDataUrl(
        origin + "/favicon.ico"
      );

      if (favicon) return favicon;
    } catch (error) {
      console.log("Favicon indisponível:", error.message);
    }

    console.log("Nenhuma imagem encontrada:", platformUrl);
    return "";
  } catch (error) {
    console.log(
      "Erro na busca automática:",
      error.message
    );

    return "";
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}



/* =========================
   TENTAR IMAGEM NOVAMENTE
========================= */

async function retryPlatformImage(platformId, platformUrl) {
  const delays = [8000, 20000, 40000];

  for (const delay of delays) {
    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      const check = await pool.query(
        `SELECT image_url
         FROM platforms
         WHERE id = $1`,
        [platformId]
      );

      if (!check.rows.length) return;

      if (check.rows[0].image_url) return;

      const image = await findPlatformImage(platformUrl);

      if (!image) continue;

      const saved = await pool.query(
        `UPDATE platforms
         SET image_url = $1
         WHERE id = $2
           AND (image_url IS NULL OR image_url = '')
         RETURNING id`,
        [image, platformId]
      );

      if (saved.rows.length) {
        console.log(
          "Imagem salva para plataforma:",
          platformId
        );
      }

      return;
    } catch (error) {
      console.error(
        "Erro ao tentar novamente imagem:",
        error.message
      );
    }
  }

  console.log(
    "Não foi possível obter imagem para plataforma:",
    platformId
  );
}

/* =========================
   INICIALIZAR BANCO
========================= */

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(30) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'client',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platforms (
      id SERIAL PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      url TEXT NOT NULL,
      description TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    platforms_created_at_idx
    ON platforms (created_at DESC)
  `);

  const adminPhone = normalizePhone(
    process.env.ADMIN_PHONE
  );

  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPhone || !adminPassword) {
    throw new Error(
      "ADMIN_PHONE e ADMIN_PASSWORD precisam estar configurados."
    );
  }

  const existingAdmin = await pool.query(
    `SELECT id
     FROM users
     WHERE phone = $1`,
    [adminPhone]
  );

  if (!existingAdmin.rows.length) {
    const passwordHash = await bcrypt.hash(
      adminPassword,
      12
    );

    await pool.query(
      `INSERT INTO users
       (phone, password_hash, role)
       VALUES ($1, $2, 'admin')`,
      [adminPhone, passwordHash]
    );

    console.log("Administrador inicial criado.");
  } else {
    await pool.query(
      `UPDATE users
       SET role = 'admin'
       WHERE phone = $1`,
      [adminPhone]
    );
  }

  console.log("Banco de dados inicializado.");
}

/* =========================
   LOGIN
========================= */

app.post("/api/login", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const password = String(req.body.password || "");

    if (!phone || !password) {
      return res.status(400).json({
        error: "Informe telefone e senha."
      });
    }

    const result = await pool.query(
      `SELECT id, phone, password_hash, role
       FROM users
       WHERE phone = $1
       LIMIT 1`,
      [phone]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Telefone ou senha incorretos."
      });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        error: "Telefone ou senha incorretos."
      });
    }

    const token = createToken(user);

    res.cookie("panel_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: "/"
    });

    return res.json({
      success: true,
      user: {
        id: user.id,
        phone: user.phone,
        role: user.role
      }
    });
  } catch (error) {
    console.error("Erro no login:", error);

    return res.status(500).json({
      error: "Erro interno ao realizar login."
    });
  }
});

/* =========================
   VER USUÁRIO LOGADO
========================= */

app.get("/api/me", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, phone, role
       FROM users
       WHERE id = $1
       LIMIT 1`,
      [req.user.id]
    );

    if (!result.rows.length) {
      return res.status(401).json({
        error: "Usuário não encontrado."
      });
    }

    return res.json({
      user: result.rows[0]
    });
  } catch (error) {
    console.error("Erro ao consultar usuário:", error);

    return res.status(500).json({
      error: "Erro ao consultar sessão."
    });
  }
});

/* =========================
   SAIR DA CONTA
========================= */

app.post("/api/logout", (req, res) => {
  res.clearCookie("panel_token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  });

  return res.json({
    success: true,
    message: "Sessão encerrada."
  });
});



/* =========================
   LISTAR USUÁRIOS
========================= */

app.get(
  "/api/users",
  auth,
  adminOnly,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, phone, role, created_at
         FROM users
         ORDER BY id DESC`
      );

      return res.json({
        users: result.rows
      });
    } catch (error) {
      console.error("Erro ao listar usuários:", error);

      return res.status(500).json({
        error: "Não foi possível listar usuários."
      });
    }
  }
);

/* =========================
   CRIAR USUÁRIO
========================= */

app.post(
  "/api/users",
  auth,
  adminOnly,
  async (req, res) => {
    try {
      const phone = normalizePhone(req.body.phone);
      const password = String(req.body.password || "");

      if (!phone || password.length < 6) {
        return res.status(400).json({
          error: "Informe telefone e senha com pelo menos 6 caracteres."
        });
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const result = await pool.query(
        `INSERT INTO users
         (phone, password_hash, role)
         VALUES ($1, $2, 'client')
         RETURNING id, phone, role, created_at`,
        [phone, passwordHash]
      );

      return res.status(201).json({
        user: result.rows[0]
      });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({
          error: "Esse telefone já está cadastrado."
        });
      }

      console.error("Erro ao criar usuário:", error);

      return res.status(500).json({
        error: "Não foi possível criar usuário."
      });
    }
  }
);

/* =========================
   EXCLUIR USUÁRIO
========================= */

app.delete(
  "/api/users/:id",
  auth,
  adminOnly,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          error: "ID de usuário inválido."
        });
      }

      if (id === Number(req.user.id)) {
        return res.status(400).json({
          error: "Você não pode excluir sua própria conta."
        });
      }

      const result = await pool.query(
        `DELETE FROM users
         WHERE id = $1
           AND role <> 'admin'
         RETURNING id`,
        [id]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          error: "Usuário não encontrado ou não pode ser excluído."
        });
      }

      return res.json({
        success: true
      });
    } catch (error) {
      console.error("Erro ao excluir usuário:", error);

      return res.status(500).json({
        error: "Não foi possível excluir usuário."
      });
    }
  }
);

/* =========================
   LISTAR PLATAFORMAS
========================= */

app.get("/api/platforms", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         id,
         name,
         url,
         description,
         image_url,
         created_at
       FROM platforms
       ORDER BY created_at DESC, id DESC`
    );

    const platforms = result.rows.map(platform => ({
      ...platform,
      is_recent:
        Date.now() - new Date(platform.created_at).getTime()
        < 7 * 24 * 60 * 60 * 1000
    }));

    return res.json({
      platforms
    });
  } catch (error) {
    console.error("Erro ao listar plataformas:", error);

    return res.status(500).json({
      error: "Não foi possível carregar as plataformas."
    });
  }
});

/* =========================
   CADASTRAR PLATAFORMA
========================= */

app.post(
  "/api/platforms",
  auth,
  adminOnly,
  async (req, res) => {
    try {
      const name = String(req.body.name || "").trim();
      const url = String(req.body.url || "").trim();
      const description = String(
        req.body.description || ""
      ).trim();

      if (!name || !url) {
        return res.status(400).json({
          error: "Informe o nome e o link da plataforma."
        });
      }

      if (!isHttpUrl(url)) {
        return res.status(400).json({
          error: "Informe um link válido começando com http:// ou https://."
        });
      }

      let imageUrl = String(
        req.body.image_url || ""
      ).trim();

      if (imageUrl && !isHttpUrl(imageUrl) &&
          !imageUrl.startsWith("data:image/")) {
        imageUrl = "";
      }

      const result = await pool.query(
        `INSERT INTO platforms
         (name, url, description, image_url)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, url, description, image_url, created_at`,
        [name, url, description, imageUrl]
      );

      const platform = result.rows[0];

      if (!platform.image_url) {
        setImmediate(() => {
          retryPlatformImage(platform.id, platform.url);
        });
      }

      return res.status(201).json({
        success: true,
        platform
      });
    } catch (error) {
      console.error("Erro ao cadastrar plataforma:", error);

      return res.status(500).json({
        error: "Não foi possível cadastrar a plataforma."
      });
    }
  }
);

/* =========================
   EDITAR PLATAFORMA
========================= */

app.put(
  "/api/platforms/:id",
  auth,
  adminOnly,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          error: "ID de plataforma inválido."
        });
      }

      const name = String(req.body.name || "").trim();
      const url = String(req.body.url || "").trim();
      const description = String(
        req.body.description || ""
      ).trim();

      if (!name || !url || !isHttpUrl(url)) {
        return res.status(400).json({
          error: "Informe nome e link válido."
        });
      }

      const imageUrl = String(
        req.body.image_url || ""
      ).trim();

      const safeImage = (
        isHttpUrl(imageUrl) ||
        imageUrl.startsWith("data:image/")
      ) ? imageUrl : "";

      const result = await pool.query(
        `UPDATE platforms
         SET name = $1,
             url = $2,
             description = $3,
             image_url = $4
         WHERE id = $5
         RETURNING id, name, url, description, image_url, created_at`,
        [name, url, description, safeImage, id]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          error: "Plataforma não encontrada."
        });
      }

      const platform = result.rows[0];

      if (!platform.image_url) {
        setImmediate(() => {
          retryPlatformImage(platform.id, platform.url);
        });
      }

      return res.json({
        success: true,
        platform
      });
    } catch (error) {
      console.error("Erro ao editar plataforma:", error);

      return res.status(500).json({
        error: "Não foi possível editar a plataforma."
      });
    }
  }
);

/* =========================
   EXCLUIR PLATAFORMA
========================= */

app.delete(
  "/api/platforms/:id",
  auth,
  adminOnly,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          error: "ID de plataforma inválido."
        });
      }

      const result = await pool.query(
        `DELETE FROM platforms
         WHERE id = $1
         RETURNING id`,
        [id]
      );

      if (!result.rows.length) {
        return res.status(404).json({
          error: "Plataforma não encontrada."
        });
      }

      return res.json({
        success: true
      });
    } catch (error) {
      console.error("Erro ao excluir plataforma:", error);

      return res.status(500).json({
        error: "Não foi possível excluir a plataforma."
      });
    }
  }
);



/* =========================
   VERIFICAR SAÚDE DO SERVIDOR
========================= */

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    return res.json({
      success: true,
      status: "online",
      database: "connected"
    });
  } catch (error) {
    console.error("Erro na verificação:", error.message);

    return res.status(503).json({
      success: false,
      status: "degraded",
      database: "disconnected"
    });
  }
});

/* =========================
   ARQUIVOS PÚBLICOS
========================= */

app.use(express.static(path.join(__dirname, "public")));

/* =========================
   PÁGINA PRINCIPAL
========================= */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html"),
    error => {
      if (error && !res.headersSent) {
        res.status(404).send(
          "Arquivo index.html não encontrado na pasta public."
        );
      }
    }
  );
});

/* =========================
   ROTA NÃO ENCONTRADA
========================= */

app.use("/api", (req, res) => {
  return res.status(404).json({
    error: "Rota da API não encontrada."
  });
});

/* =========================
   ERROS DO SERVIDOR
========================= */

app.use((error, req, res, next) => {
  console.error("Erro inesperado:", error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: "Erro interno do servidor."
  });
});

/* =========================
   INICIAR APLICAÇÃO
========================= */

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `Servidor iniciado na porta ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Não foi possível iniciar o servidor:",
      error
    );

    process.exit(1);
  }
}

startServer();

/* =========================
   ENCERRAMENTO SEGURO
========================= */

async function shutdown(signal) {
  console.log(`Recebido ${signal}. Encerrando servidor...`);

  try {
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error("Erro ao encerrar banco:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
