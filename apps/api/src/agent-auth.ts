import type {NextFunction,Request,Response} from 'express';
import type {PrismaClient} from '@prisma/client';
import {canAgentUseShop,hashSecret,isAgentCredential} from './agent-core.js';
export interface AgentRequest extends Request { agent?:{id:string;shopId:string;printerId:string;mode:'SIMULATED'|'REAL';name:string} }
export function authenticateAgent(db:PrismaClient){return async(req:AgentRequest,res:Response,next:NextFunction)=>{try{
  const token=req.headers.authorization?.replace(/^Bearer\s+/i,'')||'';
  if(!isAgentCredential(token))return res.status(401).json({error:{code:'AGENT_UNAUTHORIZED',message:'A provisioned agent credential is required.'}});
  const hash=hashSecret(token);const row=await db.agentDevice.findUnique({where:{deviceKeyHash:hash},include:{printer:true,shop:true,user:{select:{isActive:true}}}});
  if(!row||!row.user.isActive||!row.printerId||!row.printer||!canAgentUseShop(row.shopId,row.printer.shopId)||!row.shop.isActive)return res.status(401).json({error:{code:'AGENT_UNAUTHORIZED',message:'Agent credential is invalid, revoked, or unbound.'}});
  req.agent={id:row.id,shopId:row.shopId,printerId:row.printerId!,mode:row.mode,name:row.name};next();
}catch(e){next(e);}};}
