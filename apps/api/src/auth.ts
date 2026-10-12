import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@qr-print/shared';
import type { PrismaClient } from '@prisma/client';
const secret = () => process.env.JWT_SECRET || 'local-development-secret-change-me';
export interface AuthRequest extends Request { user?: { id:string; role:Role } }
export async function authenticate(req:AuthRequest,res:Response,next:NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({error:'Authentication required'});
  try {
    const claim=jwt.verify(token,secret()) as {id:string;role:Role};
    const db=req.app.locals.db as PrismaClient|undefined;
    if(!db)return next(new Error('Authentication database is unavailable.'));
    const user=await db.user.findUnique({where:{id:claim.id},select:{role:true,isActive:true}});
    if(!user?.isActive||user.role!==claim.role)return res.status(401).json({error:'Account is inactive or no longer available'});
    req.user={id:claim.id,role:claim.role};
    next();
  } catch (error) {
    if(error instanceof jwt.JsonWebTokenError)return res.status(401).json({error:'Invalid or expired token'});
    next(error);
  }
}
export const requireRole = (...roles:Role[]) => (req:AuthRequest,res:Response,next:NextFunction) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({error:'Insufficient role'});
  next();
};
export const issueToken = (id:string,role:Role,expiresIn:jwt.SignOptions['expiresIn']='12h') => jwt.sign({id,role},secret(),{expiresIn});
