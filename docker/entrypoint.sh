#!/bin/sh
set -e
echo "Waiting for MySQL..."
sleep 5
npx prisma migrate deploy
npx tsx prisma/seed.ts || true
exec node dist/index.js
