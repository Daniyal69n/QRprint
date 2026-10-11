function isPrivateIPv4(host: string) {
  const octets=host.split('.').map(Number);
  if(octets.length!==4||octets.some(x=>!Number.isInteger(x)||x<0||x>255))return false;
  return octets[0]===10||octets[0]===127||octets[0]===0||octets[0]===169&&octets[1]===254||octets[0]===192&&octets[1]===168||octets[0]===172&&octets[1]>=16&&octets[1]<=31;
}

export function apiUrl(path: string) {
  const configured=process.env.NEXT_PUBLIC_API_URL;
  if(!configured){
    if(process.env.NODE_ENV==='production')throw new Error('NEXT_PUBLIC_API_URL must be set to the deployed public HTTPS API before building QR Print for production.');
    return `http://localhost:4000${path}`;
  }
  if(configured==='/api')return `/api${path}`;
  let url:URL;
  try{url=new URL(configured);}catch{throw new Error('NEXT_PUBLIC_API_URL is not a valid absolute URL.');}
  if(process.env.NODE_ENV==='production'){
    if(url.protocol!=='https:'||url.username||url.password||['localhost','127.0.0.1','::1'].includes(url.hostname)||url.hostname.endsWith('.local')||isPrivateIPv4(url.hostname))
      throw new Error('Production requires NEXT_PUBLIC_API_URL to point to a public HTTPS API; local and private-network URLs are not allowed.');
  }
  return `${url.toString().replace(/\/$/,'')}${path}`;
}
