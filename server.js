require("dotenv").config();

const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

const PORT =
  process.env.PORT || 10000;


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

    console.error(
      `Variável obrigatória ausente: ${key}`
    );

    process.exit(1);
  }
}


/* =========================
   BANCO DE DADOS
========================= */

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL,

  ssl:
    process.env.DATABASE_URL.includes(
      "localhost"
    )
      ? false
      : {
          rejectUnauthorized: false
        }
});


/* =========================
   MIDDLEWARES
========================= */

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  cookieParser()
);


/* =========================
   NORMALIZAR TELEFONE
========================= */

function normalizePhone(value) {

  return String(value || "")
    .replace(/\D/g, "");

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

    {
      expiresIn: "7d"
    }
  );

}


/* =========================
   AUTENTICAÇÃO
========================= */

function auth(req, res, next) {

  try {

    const token =
      req.cookies.panel_token;

    if (!token) {

      return res.status(401).json({
        error:
          "Não autenticado."
      });

    }


    req.user =
      jwt.verify(
        token,
        process.env.JWT_SECRET
      );


    next();

  } catch (error) {

    return res.status(401).json({
      error:
        "Sessão inválida ou expirada."
    });

  }

}


/* =========================
   SOMENTE ADMIN
========================= */

function adminOnly(
  req,
  res,
  next
) {

  if (
    req.user?.role !==
    "admin"
  ) {

    return res.status(403).json({
      error:
        "Acesso restrito ao administrador."
    });

  }

  next();

}


/* =========================
   VALIDAR URL
========================= */

function isHttpUrl(value) {

  try {

    const parsed =
      new URL(value);

    return (
      parsed.protocol ===
        "http:" ||
      parsed.protocol ===
        "https:"
    );

  } catch (error) {

    return false;

  }

}


/* =========================
   RESOLVER IMAGEM
========================= */

function resolveImageUrl(
  imageUrl,
  pageUrl
) {

  try {

    return new URL(
      imageUrl,
      pageUrl
    ).toString();

  } catch (error) {

    return "";

  }

}


/* =========================
   EXTRAIR IMAGEM DO SITE
========================= */

function extractMetaImage(
  html,
  pageUrl
) {

  const candidates = [];

  let match;


  const metaRegex =
    /<meta[^>]+(?:property|name)\s*=\s*["']([^"']+)["'][^>]+content\s*=\s*["']([^"']+)["'][^>]*>/gi;


  while (
    (match =
      metaRegex.exec(html)) !==
    null
  ) {

    const key =
      String(match[1])
        .toLowerCase()
        .trim();

    const value =
      String(match[2])
        .trim();


    if (
      [
        "og:image",
        "og:image:url",
        "twitter:image",
        "twitter:image:src"
      ].includes(key) &&
      value
    ) {

      candidates.push(value);

    }

  }


  const reverseMetaRegex =
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+(?:property|name)\s*=\s*["']([^"']+)["'][^>]*>/gi;


  while (
    (match =
      reverseMetaRegex.exec(html)) !==
    null
  ) {

    const value =
      String(match[1])
        .trim();

    const key =
      String(match[2])
        .toLowerCase()
        .trim();


    if (
      [
        "og:image",
        "og:image:url",
        "twitter:image",
        "twitter:image:src"
      ].includes(key) &&
      value
    ) {

      candidates.push(value);

    }

  }


  const linkRegex =
    /<link[^>]+rel\s*=\s*["']([^"']+)["'][^>]+href\s*=\s*["']([^"']+)["'][^>]*>/gi;


  while (
    (match =
      linkRegex.exec(html)) !==
    null
  ) {

    const rel =
      String(match[1])
        .toLowerCase();

    const href =
      String(match[2])
        .trim();


    if (
      rel.includes(
        "apple-touch-icon"
      ) ||
      rel === "icon" ||
      rel.includes(
        "shortcut icon"
      )
    ) {

      if (href) {

        candidates.push(href);

      }

    }

  }


  const reverseLinkRegex =
    /<link[^>]+href\s*=\s*["']([^"']+)["'][^>]+rel\s*=\s*["']([^"']+)["'][^>]*>/gi;


  while (
    (match =
      reverseLinkRegex.exec(html)) !==
    null
  ) {

    const href =
      String(match[1])
        .trim();

    const rel =
      String(match[2])
        .toLowerCase();


    if (
      rel.includes(
        "apple-touch-icon"
      ) ||
      rel === "icon" ||
      rel.includes(
        "shortcut icon"
      )
    ) {

      if (href) {

        candidates.push(href);

      }

    }

  }


  for (
    const candidate of candidates
  ) {

    const resolved =
      resolveImageUrl(
        candidate,
        pageUrl
      );


    if (
      resolved &&
      isHttpUrl(resolved)
    ) {

      return resolved;

    }

  }


  return "";

}


/* =========================
   BUSCAR IMAGEM AUTOMÁTICA
========================= */

async function findPlatformImage(
  platformUrl
) {

  if (
    !isHttpUrl(platformUrl)
  ) {

    return "";

  }


  try {

    const controller =
      new AbortController();


    const timeout =
      setTimeout(
        () => controller.abort(),
        10000
      );


    const response =
      await fetch(
        platformUrl,
        {
          method: "GET",

          redirect: "follow",

          signal:
            controller.signal,

          headers: {

            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36",

            "Accept":
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"

          }

        }
      );


    clearTimeout(timeout);


    if (!response.ok) {

      throw new Error(
        `HTTP ${response.status}`
      );

    }


    const contentType =
      response.headers.get(
        "content-type"
      ) || "";


    if (
      !contentType.includes(
        "text/html"
      )
    ) {

      return "";

    }


    const html =
      await response.text();


    const image =
      extractMetaImage(
        html,
        response.url ||
          platformUrl
      );


    if (image) {

      return image;

    }


    try {

      const domain =
        new URL(
          response.url ||
            platformUrl
        ).hostname;


      if (domain) {

        return (
          "https://www.google.com/s2/favicons?domain=" +
          encodeURIComponent(
            domain
          ) +
          "&sz=256"
        );

      }

    } catch (error) {}


    return "";

  } catch (error) {

    console.log(
      "Imagem automática:",
      error.message
    );


    try {

      const domain =
        new URL(
          platformUrl
        ).hostname;


      if (domain) {

        return (
          "https://www.google.com/s2/favicons?domain=" +
          encodeURIComponent(
            domain
          ) +
          "&sz=256"
        );

      }

    } catch (error) {}


    return "";

  }

}

/* =========================
   BANCO DE DADOS
========================= */

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

    CREATE INDEX IF NOT EXISTS
    idx_platforms_created_at
    ON platforms(created_at DESC);
  `);


  const adminPhone =
    normalizePhone(
      process.env.ADMIN_PHONE
    );

  const adminPassword =
    String(
      process.env.ADMIN_PASSWORD
    );


  const existing =
    await pool.query(
      `SELECT id
       FROM users
       WHERE phone = $1
       LIMIT 1`,
      [adminPhone]
    );


  if (!existing.rowCount) {

    const passwordHash =
      await bcrypt.hash(
        adminPassword,
        12
      );


    await pool.query(
      `INSERT INTO users
       (
         phone,
         password_hash,
         role
       )
       VALUES
       (
         $1,
         $2,
         'admin'
       )`,
      [
        adminPhone,
        passwordHash
      ]
    );


    console.log(
      "Administrador criado com sucesso."
    );

  } else {

    await pool.query(
      `UPDATE users
       SET role = 'admin'
       WHERE phone = $1`,
      [adminPhone]
    );

  }

}


/* =========================
   HEALTH
========================= */

app.get(
  "/api/health",
  async (req, res) => {

    try {

      await pool.query(
        "SELECT 1"
      );


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

  }
);


/* =========================
   LOGIN
========================= */

app.post(
  "/api/auth/login",
  async (req, res) => {

    try {

      const phone =
        normalizePhone(
          req.body.phone
        );


      const password =
        String(
          req.body.password || ""
        );


      if (
        !phone ||
        !password
      ) {

        return res.status(400).json({
          error:
            "Informe telefone e senha."
        });

      }


      /* =====================
         ADMIN
      ===================== */

      const adminPhone =
        normalizePhone(
          process.env.ADMIN_PHONE
        );


      if (
        phone === adminPhone
      ) {

        const adminPassword =
          String(
            process.env.ADMIN_PASSWORD
          );


        if (
          password !==
          adminPassword
        ) {

          return res.status(401).json({
            error:
              "Senha incorreta."
          });

        }


        const adminResult =
          await pool.query(
            `SELECT
              id,
              phone,
              role
             FROM users
             WHERE phone = $1
             LIMIT 1`,
            [adminPhone]
          );


        if (
          !adminResult.rowCount
        ) {

          return res.status(500).json({
            error:
              "Administrador não encontrado."
          });

        }


        const admin =
          adminResult.rows[0];


        const token =
          createToken({
            id: admin.id,
            phone: admin.phone,
            role: "admin"
          });


        res.cookie(
          "panel_token",
          token,
          {
            httpOnly: true,
            sameSite: "lax",

            secure:
              process.env.NODE_ENV ===
              "production",

            maxAge:
              7 *
              24 *
              60 *
              60 *
              1000
          }
        );


        return res.json({
          ok: true,

          user: {
            id: admin.id,
            phone: admin.phone,
            role: "admin"
          }
        });

      }


      /* =====================
         CLIENTE EXISTENTE
      ===================== */

      const result =
        await pool.query(
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


      if (
        result.rowCount
      ) {

        const user =
          result.rows[0];


        const validPassword =
          await bcrypt.compare(
            password,
            user.password_hash
          );


        if (
          !validPassword
        ) {

          return res.status(401).json({
            error:
              "Senha incorreta."
          });

        }


        const token =
          createToken(user);


        res.cookie(
          "panel_token",
          token,
          {
            httpOnly: true,
            sameSite: "lax",

            secure:
              process.env.NODE_ENV ===
              "production",

            maxAge:
              7 *
              24 *
              60 *
              60 *
              1000
          }
        );


        return res.json({
          ok: true,

          user: {
            id: user.id,
            phone: user.phone,
            role: user.role
          }
        });

      }


      /* =====================
         CLIENTE NOVO
      ===================== */

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );


      const newUser =
        await pool.query(
          `INSERT INTO users
           (
             phone,
             password_hash,
             role
           )
           VALUES
           (
             $1,
             $2,
             'client'
           )
           RETURNING
             id,
             phone,
             role`,
          [
            phone,
            passwordHash
          ]
        );


      const user =
        newUser.rows[0];


      const token =
        createToken(user);


      res.cookie(
        "panel_token",
        token,
        {
          httpOnly: true,
          sameSite: "lax",

          secure:
            process.env.NODE_ENV ===
            "production",

          maxAge:
            7 *
            24 *
            60 *
            60 *
            1000
        }
      );


      return res.status(201).json({
        ok: true,
        created: true,

        user: {
          id: user.id,
          phone: user.phone,
          role: user.role
        }
      });


    } catch (error) {

      console.error(
        "Erro no login:",
        error
      );


      res.status(500).json({
        error:
          "Erro interno no login."
      });

    }

  }
);


/* =========================
   LOGOUT
========================= */

app.post(
  "/api/auth/logout",
  (req, res) => {

    res.clearCookie(
      "panel_token"
    );


    res.json({
      ok: true
    });

  }
);


/* =========================
   USUÁRIO LOGADO
========================= */

app.get(
  "/api/auth/me",
  auth,
  (req, res) => {

    res.json({
      user: req.user
    });

  }
);


/* =========================
   LISTAR PLATAFORMAS
========================= */

app.get(
  "/api/platforms",
  auth,
  async (req, res) => {

    try {

      const result =
        await pool.query(`
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
        platforms:
          result.rows
      });

    } catch (error) {

      console.error(
        "Erro ao carregar plataformas:",
        error
      );


      res.status(500).json({
        error:
          "Não foi possível carregar as plataformas."
      });

    }

  }
);

/* =========================
   ADICIONAR PLATAFORMA
========================= */

app.post(
  "/api/platforms",
  auth,
  adminOnly,
  async (req, res) => {

    try {

      const {
        name,
        url,
        description = ""
      } = req.body;


      if (
        !name?.trim() ||
        !url?.trim()
      ) {

        return res.status(400).json({
          error:
            "Nome e URL são obrigatórios."
        });

      }


      if (
        !isHttpUrl(
          url.trim()
        )
      ) {

        return res.status(400).json({
          error:
            "A URL precisa começar com http:// ou https://."
        });

      }


      const imageUrl =
        await findPlatformImage(
          url.trim()
        );


      const result =
        await pool.query(
          `INSERT INTO platforms
           (
             name,
             url,
             description,
             image_url
           )
           VALUES
           (
             $1,
             $2,
             $3,
             $4
           )
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
            String(
              description
            ).trim(),
            imageUrl
          ]
        );


      res.status(201).json({
        platform:
          result.rows[0]
      });


    } catch (error) {

      console.error(
        "Erro ao adicionar plataforma:",
        error
      );


      res.status(500).json({
        error:
          "Erro ao adicionar plataforma."
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

      const id =
        Number(
          req.params.id
        );


      const {
        name,
        url,
        description = ""
      } = req.body;


      if (
        !Number.isInteger(id) ||
        !name?.trim() ||
        !url?.trim()
      ) {

        return res.status(400).json({
          error:
            "Dados inválidos."
        });

      }


      if (
        !isHttpUrl(
          url.trim()
        )
      ) {

        return res.status(400).json({
          error:
            "A URL precisa começar com http:// ou https://."
        });

      }


      const imageUrl =
        await findPlatformImage(
          url.trim()
        );


      const result =
        await pool.query(
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
            String(
              description
            ).trim(),
            imageUrl,
            id
          ]
        );


      if (
        !result.rowCount
      ) {

        return res.status(404).json({
          error:
            "Plataforma não encontrada."
        });

      }


      res.json({
        platform:
          result.rows[0]
      });


    } catch (error) {

      console.error(
        "Erro ao editar plataforma:",
        error
      );


      res.status(500).json({
        error:
          "Erro ao editar plataforma."
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

      const id =
        Number(
          req.params.id
        );


      const result =
        await pool.query(
          `DELETE FROM platforms
           WHERE id = $1
           RETURNING id`,
          [id]
        );


      if (
        !result.rowCount
      ) {

        return res.status(404).json({
          error:
            "Plataforma não encontrada."
        });

      }


      res.json({
        ok: true
      });


    } catch (error) {

      console.error(
        "Erro ao excluir plataforma:",
        error
      );


      res.status(500).json({
        error:
          "Erro ao excluir plataforma."
      });

    }

  }
);


/* =========================
   CLIENTES - LISTAR
========================= */

app.get(
  "/api/clients",
  auth,
  adminOnly,
  async (req, res) => {

    try {

      const result =
        await pool.query(`
          SELECT
            id,
            phone,
            created_at
          FROM users
          WHERE role = 'client'
          ORDER BY created_at DESC
        `);


      res.json({
        clients:
          result.rows
      });


    } catch (error) {

      console.error(
        "Erro ao carregar clientes:",
        error
      );


      res.status(500).json({
        error:
          "Erro ao carregar clientes."
      });

    }

  }
);


/* =========================
   CLIENTES - CRIAR
========================= */

app.post(
  "/api/clients",
  auth,
  adminOnly,
  async (req, res) => {

    try {

      const phone =
        normalizePhone(
          req.body.phone
        );


      const password =
        String(
          req.body.password || ""
        );


      if (
        !phone ||
        password.length < 4
      ) {

        return res.status(400).json({
          error:
            "Telefone e senha com pelo menos 4 caracteres são obrigatórios."
        });

      }


      const exists =
        await pool.query(
          `SELECT id
           FROM users
           WHERE phone = $1
           LIMIT 1`,
          [phone]
        );


      if (
        exists.rowCount
      ) {

        return res.status(409).json({
          error:
            "Esse telefone já está cadastrado."
        });

      }


      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );


      const result =
        await pool.query(
          `INSERT INTO users
           (
             phone,
             password_hash,
             role
           )
           VALUES
           (
             $1,
             $2,
             'client'
           )
           RETURNING
             id,
             phone,
             created_at`,
          [
            phone,
            passwordHash
          ]
        );


      res.status(201).json({
        client:
          result.rows[0]
      });


    } catch (error) {

      console.error(
        "Erro ao criar cliente:",
        error
      );


      res.status(500).json({
        error:
          "Erro ao criar cliente."
      });

    }

  }
);


/* =========================
   CLIENTES - EDITAR
========================= */

app.put(
  "/api/clients/:id",
  auth,
  adminOnly,
  async (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );


      const phone =
        normalizePhone(
          req.body.phone
        );


      const password =
        String(
          req.body.password || ""
        );


      if (
        !Number.isInteger(id) ||
        !phone
      ) {

        return res.status(400).json({
          error:
            "Dados inválidos."
        });

      }


      const duplicate =
        await pool.query(
          `SELECT id
           FROM users
           WHERE phone = $1
           AND id <> $2`,
          [
            phone,
            id
          ]
        );


      if (
        duplicate.rowCount
      ) {

        return res.status(409).json({
          error:
            "Esse telefone já está em uso."
        });

      }


      let result;


      if (password) {

        const passwordHash =
          await bcrypt.hash(
            password,
            12
          );


        result =
          await pool.query(
            `UPDATE users
             SET
               phone = $1,
               password_hash = $2
             WHERE
               id = $3
               AND role = 'client'
             RETURNING
               id,
               phone,
               created_at`,
            [
              phone,
              passwordHash,
              id
            ]
          );

      } else {

        result =
          await pool.query(
            `UPDATE users
             SET phone = $1
             WHERE
               id = $2
               AND role = 'client'
             RETURNING
               id,
               phone,
               created_at`,
            [
              phone,
              id
            ]
          );

      }


      if (
        !result.rowCount
      ) {

        return res.status(404).json({
          error:
            "Cliente não encontrado."
        });

      }


      res.json({
        client:
          result.rows[0]
      });


    } catch (error) {

      console.error(
        "Erro ao editar cliente:",
        error
      );


      res.status(500).json({
        error:
          "Erro ao editar cliente."
      });

    }

  }
);


/* =========================
   CLIENTES - EXCLUIR
========================= */

app.delete(
  "/api/clients/:id",
  auth,
  adminOnly,
  async (req, res) => {

    try {

      const id =
        Number(
          req.params.id
        );


      const result =
        await pool.query(
          `DELETE FROM users
           WHERE
             id = $1
             AND role = 'client'
           RETURNING id`,
          [id]
        );


      if (
        !result.rowCount
      ) {

        return res.status(404).json({
          error:
            "Cliente não encontrado."
        });

      }


      res.json({
        ok: true
      });


    } catch (error) {

      console.error(
        "Erro ao excluir cliente:",
        error
      );


      res.status(500).json({
        error:
          "Erro ao excluir cliente."
      });

    }

  }
);

/* =========================
   ARQUIVOS DO PAINEL
========================= */

app.use(
  express.static(
    __dirname,
    {
      index: "index.html"
    }
  )
);


/* =========================
   ROTA PRINCIPAL
========================= */

app.get(
  "*",
  (req, res) => {

    if (
      req.path.startsWith(
        "/api/"
      )
    ) {

      return res.status(404).json({
        error:
          "Rota não encontrada."
      });

    }


    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );

  }
);


/* =========================
   INICIAR BANCO E SERVIDOR
========================= */

initDatabase()
  .then(() => {

    app.listen(
      PORT,
      "0.0.0.0",
      () => {

        console.log(
          `Servidor rodando na porta ${PORT}`
        );

      }
    );

  })
  .catch(error => {

    console.error(
      "Erro ao iniciar banco:",
      error
    );

    process.exit(1);

  });
