import {z} from 'zod';

export const shopOwnerRegistrationSchema=z.object({
  ownerName:z.string().trim().min(2).max(120),
  email:z.string().trim().email().max(254).transform(value=>value.toLowerCase()),
  password:z.string().min(12).max(72).refine(value=>Buffer.byteLength(value,'utf8')<=72,'Password must be no more than 72 UTF-8 bytes.'),
  shopName:z.string().trim().min(2).max(120),
  slug:z.string().trim().min(3).max(60).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
}).strict();
