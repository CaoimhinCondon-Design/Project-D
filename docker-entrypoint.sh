#!/bin/sh
set -e

echo "Waiting for Postgres..."
# simple wait loop – you can swap for pg_isready if you like
until nc -z db 5432; do
  echo "Postgres is unavailable - sleeping"
  sleep 1
done

echo "Running Prisma migrations..."
npx prisma migrate deploy

echo "Starting app..."
npm start
