# Fulus API

Express + TypeScript (ESM) backend for Fulus, using Prisma + MySQL and a controller/service architecture.

## Providers

| Domain | Provider | Notes |
| --- | --- | --- |
| Virtual Visa / gift cards | [Pagocards](https://pagocards.com/documentation) | Visa 493 BIN `us_493_visa_bin` via `/api/v1/cards` |
| Crypto | [Busha](https://docs.busha.co/) | Balances, quotes, payments |
| KYC | [Prembly](https://prembly.com/) | BVN / NIN / face checks |
| Bill payments | [Strowallet](https://strowallet.readme.io/) | Airtime, data, electricity, cable |
| eSIM | [eSIM Go](https://docs.esim-go.com/) | Catalogue + orders v2.5 |

## Stack

- Node.js + Express 5
- TypeScript (`"type": "module"`, NodeNext)
- Prisma + MySQL
- Zod validation
- JWT auth

## Layout

```text
src/
  config/           # env
  lib/              # prisma, errors, http helpers
  middleware/       # auth, error handler
  providers/        # Pagocards, Busha, Prembly, Strowallet, eSIM Go clients
  modules/          # feature modules (controller + service)
  routes/           # /api/v1 router
```

## Docker (recommended)

Requires Docker Desktop running.

```sh
cp .env.example .env
docker compose up -d --build
```

This starts MySQL 8 on `:3306` and the API on `:4000`. On boot the API runs `prisma migrate deploy` and seeds FX rates + bill catalog.

Health: `GET http://localhost:4000/api/v1/health`

Stop: `docker compose down`

## Local setup (without Docker API)

1. Copy env file and fill secrets:

```sh
cp .env.example .env
```

2. Start MySQL only (`docker compose up -d mysql`) or use your own instance. Set `DATABASE_URL=mysql://fulus:fulus@127.0.0.1:3306/fulus`.

3. Install and migrate:

```sh
npm install
npx prisma generate
npx prisma migrate deploy
npm run prisma:seed
npm run dev
```

API base: `http://localhost:4000/api/v1`

Admin FX desk key header: `x-admin-key` (default `fulus-admin-dev-key` / `ADMIN_API_KEY`).

## Key routes

- `POST /auth/register` `POST /auth/login`
- `GET /me`
- `GET /wallets` `GET /transactions` `GET /transactions/:id`
- `GET /fx/rates` `POST /fx/quote` `POST /wallets/swap`
- `GET|PUT /admin/fx/rates`
- `POST /deposits/bank` `GET /wallets/deposit/bank/accounts`
- `GET|POST /beneficiaries` `POST /transfers/fulus` `POST /transfers/bank`
- `POST /kyc/bvn` `POST /kyc/nin`
- `POST /cards` `POST /cards/:id/fund`
- `GET /crypto/rates` `POST /crypto/orders`
- `GET /bills/catalog` `POST /bills/pay`
- `GET /esim/catalogue` `POST /esims/purchase`
- `POST /webhooks/{esim-go|busha|pagocards|strowallet}`
