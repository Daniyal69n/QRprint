import {config} from 'dotenv';
import {PrismaClient} from '@prisma/client';
import path from 'node:path';
import {rm} from 'node:fs/promises';
import {assertDatabaseTarget} from '../src/database-target.js';
import {canRetainDocumentDelete} from '../src/document-retention.js';

const workspace=process.cwd();
config({path:path.resolve(workspace,'../../.env')});
config({path:path.resolve(workspace,'.env')});
assertDatabaseTarget(process.env.DATABASE_URL,'qr_print');
const retentionDays=Math.max(1,Math.min(3650,Number(process.env.DOCUMENT_RETENTION_DAYS)||30));
const db=new PrismaClient();
try {
  const actual=await db.$queryRaw<Array<{name:string}>>`SELECT current_database() AS name`;
  if(actual[0]?.name!=='qr_print')throw new Error('Refusing PDF cleanup: PostgreSQL did not confirm qr_print.');
  const cutoff=new Date(Date.now()-retentionDays*24*60*60*1000);
  const documents=await db.document.findMany({where:{OR:[{deletedAt:{not:null}},{deletedAt:null,createdAt:{lte:cutoff}}]},include:{orders:{select:{status:true,printJob:{select:{mode:true,status:true,physicalStatus:true,attempt:true,maxAttempts:true}}}}}});
  const storageRoot=path.resolve(process.env.QRPRINT_STORAGE_DIR||path.join(workspace,'storage'));
  let removed=0,retained=0,failed=0;
  for(const doc of documents){
    if(!doc.deletedAt){
      if(!canRetainDocumentDelete(doc)){retained++;continue;}
      const marked=await db.document.updateMany({where:{id:doc.id,deletedAt:null,createdAt:{lte:cutoff}},data:{deletedAt:new Date()}});
      if(!marked.count)continue;
    }
    if(!/^[A-Za-z0-9_-]+\.pdf$/.test(doc.storageKey)){failed++;continue;}
    const file=path.resolve(storageRoot,doc.storageKey);
    if(!file.startsWith(`${storageRoot}${path.sep}`)){failed++;continue;}
    try{await rm(file,{force:true});removed++;}catch{failed++;}
  }
  console.log(JSON.stringify({database:actual[0].name,retentionDays,removed,retained,failed}));
  if(failed)process.exitCode=1;
} finally {await db.$disconnect();}
