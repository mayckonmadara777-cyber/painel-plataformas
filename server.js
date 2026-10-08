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

async function findPlatformImage(platformUrl) {
  if (!isHttpUrl(platformUrl)) {
    return "";
  }

  let finalUrl = platformUrl;

  try {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 12000);

    let response;

    try {
      response = await fetch(platformUrl, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
          "Accept":
            "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
          "Accept-Language":
            "pt-BR,pt;q=0.9,en;q=0.8"
        }
      });
    } finally {
      clearTimeout(timeout);
    }

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

    if (!contentType.includes("text/html")) {
      return "";
    }

    const html = await response.text();

/* TENTAR PRIMEIRO A IMAGEM PRINCIPAL DO SITE */
const metaImage = extractMetaImage(
  html,
  finalUrl
);

if (metaImage) {
  const downloadedImage =
    await downloadImageAsDataUrl(metaImage);

  if (downloadedImage) {
    console.log(
      "Imagem principal do site encontrada:",
      metaImage
    );

    return downloadedImage;
  }
}

const candidates = [];

    function addCandidate(value, priority = 0) {
      if (!value) return;

      value = value.trim();

      if (
        !value ||
        /^(data:|blob:|javascript:)/i.test(value)
      ) {
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

      if (
        candidates.some(item => item.url === imageUrl)
      ) {
        return;
      }

      candidates.push({
        url: imageUrl,
        priority
      });
    }

    /*
      1. PROCURAR IMAGENS NAS TAGS IMG
    */

    const imgTags =
      html.match(/<img\b[^>]*>/gi) || [];

    for (const tag of imgTags) {
      function getAttribute(name) {
        const regex = new RegExp(
          "\\b" + name + "\\s*=\\s*[\"']([^\"']+)[\"']",
          "i"
        );

        const match = tag.match(regex);

        return match ? match[1].trim() : "";
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

      const gameKeywords =
        /slot|game|jogo|games|casino|cassino|pgsoft|ppsoft|pragmatic|fortune|dragon|tiger|fish|gold|jackpot|thumbnail|cover|provider/i;

      let priority = 10;

      if (
        gameKeywords.test(description + " " + source)
      ) {
        priority = 100;
      }

      if (/logo|brand|favicon|icon/i.test(description)) {
        priority = 2;
      }

      addCandidate(source, priority);

      /*
        IMAGENS RESPONSIVAS SRCSET
      */

      const srcset = getAttribute("srcset");

      if (srcset) {
        for (const entry of srcset.split(",")) {
          const responsiveSource =
            entry.trim().split(/\s+/)[0];

          addCandidate(
            responsiveSource,
            gameKeywords.test(
              description + " " + responsiveSource
            ) ? 90 : 5
          );
        }
      }
    }

    /*
      2. PROCURAR IMAGENS OG E TWITTER
    */

    const metaTags =
      html.match(/<meta\b[^>]*>/gi) || [];

    for (const tag of metaTags) {
      if (!/(og:image|twitter:image)/i.test(tag)) {
        continue;
      }

      const match = tag.match(
        /\bcontent\s*=\s*["']([^"']+)["']/i
      );

      if (match) {
        addCandidate(match[1], 20);
      }
    }

    /*
      3. PROCURAR LINKS DE IMAGENS NO HTML
    */

    const imageRegex =
      /(?:https?:)?\/\/[^"'()\s<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^"'()\s<>]*)?|(?:\/|\.\/|\.\.\/)[^"'()\s<>]+?\.(?:png|jpe?g|webp|gif)(?:\?[^"'()\s<>]*)?/gi;

    let match;

    while ((match = imageRegex.exec(html)) !== null) {
      const source = match[0];

      addCandidate(
        source,
        /slot|game|jogo|casino|fortune|dragon|tiger|pgsoft|pragmatic/i.test(
          source
        ) ? 80 : 4
      );
    }

    /*
      4. TESTAR AS MELHORES IMAGENS
    */

    candidates.sort(
      (a, b) => b.priority - a.priority
    );

    for (const candidate of candidates.slice(0, 12)) {
      try {
        const image =
          await downloadImageAsDataUrl(candidate.url);

        if (image) {
          console.log(
            "Imagem encontrada:",
            candidate.url
          );

          return image;
        }
      } catch (error) {
        console.log(
          "Imagem não acessível:",
          candidate.url
        );
      }
    }

    /*
      5. TENTAR O FAVICON DO SITE
    */

    try {
      const origin = new URL(finalUrl).origin;

      const favicon =
        await downloadImageAsDataUrl(
          origin + "/favicon.ico"
        );

      if (favicon) {
        return favicon;
      }
    } catch (error) {
      console.log(
        "Favicon indisponível:",
        error.message
      );
    }

    console.log(
      "Nenhuma imagem encontrada:",
      platformUrl
    );

    return "";
  } catch (error) {
    console.log(
      "Erro na busca automática:",
      error.message
    );

    return "";
  }
}



/* =========================
   BAIXAR IMAGEM
   E TRANSFORMAR EM DATA URL
========================= */

async function downloadImageAsDataUrl(
  imageUrl
) {

  if (
    !isHttpUrl(imageUrl)
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
        imageUrl,
        {
          method: "GET",

          redirect: "follow",

          signal:
            controller.signal,

          headers: {
            "User-Agent":
              "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36",

            "Accept":
              "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8"
          }
        }
      );


    clearTimeout(timeout);


    if (
      !response.ok
    ) {

      return "";

    }


    const contentType =
      response.headers.get(
        "content-type"
      ) || "";


    /*
      ACEITAR SOMENTE IMAGENS
    */

    if (
      !contentType.startsWith(
        "image/"
      )
    ) {

      return "";

    }


    /*
      EVITAR IMAGENS GIGANTES
    */

    const contentLength =
      Number(
        response.headers.get(
          "content-length"
        ) || 0
      );


    if (
      contentLength >
      2 * 1024 * 1024
    ) {

      return "";

    }


    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );


    /*
      SEGURANÇA CONTRA DOWNLOAD GRANDE
    */

    if (
      buffer.length >
      2 * 1024 * 1024
    ) {

      return "";

    }


    /*
      NORMALIZAR O TIPO
    */

    let mime =
      contentType
        .split(";")[0]
        .trim()
        .toLowerCase();


    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/avif",
      "image/x-icon",
      "image/vnd.microsoft.icon"
    ];


    if (
      !allowedTypes.includes(mime)
    ) {

      return "";

    }


    /*
      TRANSFORMAR EM BASE64
    */

    const base64 =
      buffer.toString(
        "base64"
      );


    return (
      `data:${mime};base64,${base64}`
    );


  } catch (error) {

    console.log(
      "Não foi possível baixar imagem:",
      error.message
    );


    return "";

  }

  } 


/* =========================
   TENTAR IMAGEM AUTOMATICAMENTE
========================= */

async function retryPlatformImage(
  platformId,
  platformUrl
) {

  const delays = [
    8000,
    20000,
    40000
  ];

  for (const delay of delays) {

    await new Promise(resolve =>
      setTimeout(resolve, delay)
    );

    try {

      const result = await pool.query(
        `SELECT image_url
         FROM platforms
         WHERE id = $1`,
        [platformId]
      );

      if (!result.rowCount) {
        return;
      }

      if (result.rows[0].image_url) {
        return;
      }

      console.log(
        "Tentando buscar imagem novamente:",
        platformUrl
      );

      const imageUrl =
        await findPlatformImage(platformUrl);

      if (
        !imageUrl ||
        !imageUrl.startsWith("data:image/")
      ) {
        continue;
      }

      await pool.query(
        `UPDATE platforms
         SET image_url = $1
         WHERE id = $2
           AND (image_url IS NULL OR image_url = '')`,
        [imageUrl, platformId]
      );

      console.log(
        "Imagem salva automaticamente para a plataforma:",
        platformId
      );

      return;

    } catch (error) {

      console.error(
        "Erro ao tentar novamente a imagem:",
        error.message
      );

    }

  }

  console.log(
    "Não foi possível encontrar uma imagem após as tentativas:",
    platformUrl
  );

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


      
const savedPlatform = result.rows[0];

if (!savedPlatform.image_url) {

  setImmediate(() => {
    retryPlatformImage(
      savedPlatform.id,
      savedPlatform.url
    );
  });

}

res.status(201).json({
  platform: savedPlatform
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

app.use(
  (req, res, next) => {

    if (
      req.method === "GET" &&
      !req.path.startsWith("/api/")
    ) {

      return res.sendFile(
        path.join(
          __dirname,
          "index.html"
        )
      );

    }

    next();

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
