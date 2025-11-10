// prismaClient.js
const { PrismaClient } = require('@prisma/client');

let prisma;

// In dev, reuse the client across reloads to avoid too many connections
if (process.env.NODE_ENV === 'production') {
  prisma = new PrismaClient();
} else {
  if (!global.__prisma) {
    global.__prisma = new PrismaClient();
  }
  prisma = global.__prisma;
}

module.exports = { prisma };
