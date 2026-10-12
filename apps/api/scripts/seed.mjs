import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { config } from 'dotenv';
import path from 'node:path';
import { assertMongoDatabaseTarget } from './mongodb-target.mjs';

config({ path: path.resolve(process.cwd(), '../../.env') });
config({ path: path.resolve(process.cwd(), '.env') });
assertMongoDatabaseTarget(process.env.MONGODB_URI, 'qr_print');

const db = new PrismaClient();
try {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL;
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!email || !password) throw new Error('Set BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD in .env before seeding.');
  if (password.length < 12) throw new Error('Bootstrap owner password must be at least 12 characters.');
  const owner = await db.user.upsert({
    where: { email },
    create: { email, passwordHash: await bcrypt.hash(password, 12), role: Role.SHOP_OWNER },
    update: { role: Role.SHOP_OWNER, isActive: true },
  });
  const shopName = process.env.BOOTSTRAP_SHOP_NAME || 'My Print Shop';
  const slug = process.env.BOOTSTRAP_SHOP_SLUG || 'my-print-shop';
  const shop = await db.shop.upsert({
    where: { slug },
    create: { slug, name: shopName, ownerId: owner.id },
    update: { name: shopName, ownerId: owner.id },
  });
  if (process.env.BOOTSTRAP_ADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_PASSWORD) {
    const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (adminPassword.length < 12) throw new Error('Bootstrap admin password must be at least 12 characters.');
    await db.user.upsert({
      where: { email: process.env.BOOTSTRAP_ADMIN_EMAIL },
      create: { email: process.env.BOOTSTRAP_ADMIN_EMAIL, passwordHash: await bcrypt.hash(adminPassword, 12), role: Role.SUPER_ADMIN },
      update: { role: Role.SUPER_ADMIN, isActive: true },
    });
  }
  console.log(`Seeded shop owner ${email} and shop ${shop.slug}.`);
} finally {
  await db.$disconnect();
}
