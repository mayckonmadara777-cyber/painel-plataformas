# Painel de Plataformas

Projeto único: o mesmo endereço possui login, ADM e área do cliente.

## Recursos
- Login por número e senha.
- O número definido em `ADMIN_PHONE` entra automaticamente no ADM.
- ADM cadastra/remove clientes.
- ADM cadastra/edita/exclui plataformas.
- Plataforma possui nome, link, descrição e imagem por URL.
- Cliente vê "Adicionadas recentemente" (últimos 7 dias).
- Plataformas antigas continuam em "Todas as plataformas".
- Botão ACESSAR abre o link cadastrado.
- Não existe saldo, compra, depósito ou pagamento.

## Render
Build Command:
`npm install`

Start Command:
`npm start`

Variáveis:
- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_PHONE`
- `ADMIN_PASSWORD`

O banco pode receber o `schema.sql` pelo SQL Shell/cliente PostgreSQL. O servidor também tenta criar as tabelas automaticamente ao iniciar.

## Observação
As imagens das plataformas são cadastradas como URL para manter o projeto simples e compatível com armazenamento efêmero do Render.
