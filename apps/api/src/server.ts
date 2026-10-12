import {createApp} from './app.js';

const app=createApp();

export default app;

if(process.env.NODE_ENV!=='test'&&process.env.VERCEL!=='1'){
  const port=Number(process.env.API_PORT||4000);
  app.listen(port,()=>console.log(JSON.stringify({time:new Date().toISOString(),level:'info',event:'api.started',port})));
}
