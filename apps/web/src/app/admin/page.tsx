'use client';
import {useState} from 'react';
import {apiUrl} from '../../lib/api-url';

type Shop={id:string;name:string;slug:string;isActive:boolean;owner:{name:string|null;email:string};printers:{id:string;name:string;queueName:string|null;status:string}[];agents:{id:string;name:string;mode:string;lastSeenAt:string|null}[];_count:{orders:number;printers:number;agents:number}};
type Audit={id:string;action:string;targetType:string;targetId:string|null;createdAt:string;actor:{email:string}|null};
type Account={id:string;name:string|null;email:string;role:string;isActive:boolean;createdAt:string;_count:{shops:number;orders:number}};
type Metrics={shops:number;orders:number;payments:number;agents:number;failedJobs:number;verifiedPaymentAmount:string;commissionBasisPoints:number;estimatedCommission:string;paymentMode:string;developmentOnly:boolean};

export default function Admin(){
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[token,setToken]=useState('');
  const [shops,setShops]=useState<Shop[]>([]),[accounts,setAccounts]=useState<Account[]>([]),[audit,setAudit]=useState<Audit[]>([]);
  const [metrics,setMetrics]=useState<Metrics|null>(null),[commission,setCommission]=useState('0');
  const [newOwnerEmail,setNewOwnerEmail]=useState(''),[newOwnerPassword,setNewOwnerPassword]=useState(''),[message,setMessage]=useState('');

  async function call(url:string,init:RequestInit={}){
    const response=await fetch(apiUrl(url),{...init,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{ }),...init.headers}});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error?.message||data.error||`Request failed (${response.status})`);
    return data;
  }
  async function signIn(e:React.FormEvent){
    e.preventDefault();
    try{const data=await call('/auth/login',{method:'POST',body:JSON.stringify({email,password})});if(data.role!=='SUPER_ADMIN')throw new Error('This account does not have the super-admin role.');setToken(data.token);setMessage('Signed in as super-admin.');}
    catch(error){setMessage((error as Error).message);}
  }
  async function load(){
    try{
      const [shopRows,userRows,auditRows,metricsData,settings]=await Promise.all([call('/admin/shops'),call('/admin/accounts'),call('/admin/audit?limit=50'),call('/admin/metrics'),call('/admin/platform-settings')]);
      setShops(shopRows);setAccounts(userRows);setAudit(auditRows);setMetrics(metricsData);setCommission(String(settings.commissionBasisPoints));
      setMessage(`Loaded ${shopRows.length} shops, ${userRows.length} owner/customer accounts, and ${auditRows.length} audit records.`);
    }catch(error){setMessage((error as Error).message);}
  }
  async function setShopActive(shop:Shop,isActive:boolean){
    try{await call(`/admin/shops/${shop.id}/active`,{method:'PUT',body:JSON.stringify({isActive})});await load();setMessage(`${shop.name} is ${isActive?'active':'inactive'}.`);}
    catch(error){setMessage((error as Error).message);}
  }
  async function setAccountActive(account:Account,isActive:boolean){
    try{await call(`/admin/accounts/${account.id}/active`,{method:'PUT',body:JSON.stringify({isActive})});await load();setMessage(`${account.email} is ${isActive?'active':'paused'}.`);}
    catch(error){setMessage((error as Error).message);}
  }
  async function saveCommission(e:React.FormEvent){
    e.preventDefault();
    try{await call('/admin/platform-settings',{method:'PUT',body:JSON.stringify({commissionBasisPoints:Number(commission)})});await load();setMessage('Platform commission setting saved.');}
    catch(error){setMessage((error as Error).message);}
  }
  async function createOwner(e:React.FormEvent){
    e.preventDefault();
    try{await call('/admin/accounts/shop-owner',{method:'POST',body:JSON.stringify({email:newOwnerEmail,password:newOwnerPassword})});setNewOwnerEmail('');setNewOwnerPassword('');await load();setMessage('Shop-owner account created. Share credentials through a secure channel.');}
    catch(error){setMessage((error as Error).message);}
  }

  return <main className="wrap">
    <div className="eyebrow">Super-admin panel</div><h1>Platform operations</h1>
    {!token?<section className="card" style={{maxWidth:600}}><h2>Admin sign in</h2><form className="form" onSubmit={signIn}><label>Email<input type="email" value={email} onChange={event=>setEmail(event.target.value)} required/></label><label>Password<input type="password" value={password} onChange={event=>setPassword(event.target.value)} required/></label><button className="btn">Sign in</button></form><p className="muted">Optional admin account is provisioned with BOOTSTRAP_ADMIN_* via <code>npm run db:seed</code>.</p></section>:<>
      <button className="btn" onClick={load}>Refresh platform data</button>
      {metrics&&<><h2>Platform overview</h2><div className="grid"><article className="card"><strong>{metrics.shops}</strong><p>Shops</p></article><article className="card"><strong>{metrics.orders}</strong><p>Orders</p></article><article className="card"><strong>{metrics.payments}</strong><p>Payment records</p></article><article className="card"><strong>{metrics.agents}</strong><p>Agent devices</p></article><article className="card"><strong>{metrics.failedJobs}</strong><p>Failed or uncertain jobs</p></article><article className="card"><strong>Rs {metrics.verifiedPaymentAmount}</strong><p>Verified payment records</p></article><article className="card"><strong>Rs {metrics.estimatedCommission}</strong><p>Estimated commission</p></article></div><p className="muted">Payment adapter: {metrics.paymentMode}{metrics.developmentOnly?' — development-only mock totals, not real revenue.':''} Commission is an estimate; it does not initiate settlements.</p></>}
      <section className="card" style={{maxWidth:640,marginTop:16}}><h2>Platform commission</h2><form className="form" onSubmit={saveCommission}><label>Commission rate (basis points; 100 = 1%)<input type="number" min="0" max="5000" step="1" value={commission} onChange={event=>setCommission(event.target.value)}/></label><button className="btn">Save commission</button></form><p className="muted">Stored as platform configuration. Commission totals are estimates until payment settlement is configured.</p></section>
      <h2>Shop-owner accounts</h2><section className="card" style={{maxWidth:640,marginBottom:16}}><form className="form" onSubmit={createOwner}><label>Owner email<input type="email" value={newOwnerEmail} onChange={event=>setNewOwnerEmail(event.target.value)} required/></label><label>Temporary password (12 characters minimum)<input type="password" minLength={12} value={newOwnerPassword} onChange={event=>setNewOwnerPassword(event.target.value)} required/></label><button className="btn">Create shop-owner account</button></form></section>
      <div className="card" style={{overflowX:'auto'}}><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Account</th><th>Shops</th><th>Orders</th><th>Created</th><th>Action</th></tr></thead><tbody>{accounts.map(account=><tr key={account.id}><td>{account.name||'—'}</td><td>{account.email}</td><td>{account.role}</td><td>{account.isActive?'Active':'Paused'}</td><td>{account._count.shops}</td><td>{account._count.orders}</td><td>{new Date(account.createdAt).toLocaleDateString()}</td><td><button onClick={()=>void setAccountActive(account,!account.isActive)}>{account.isActive?'Pause account':'Reactivate account'}</button></td></tr>)}</tbody></table></div>
      <h2>Shops and owner details</h2><div className="grid">{shops.map(shop=><article className="card" key={shop.id}><h3>{shop.name}</h3><p className="muted">/{shop.slug} · owner {shop.owner.name||'Name not provided'} · {shop.owner.email}</p><p>{shop._count.orders} orders · {shop._count.printers} printers · {shop._count.agents} agents</p><details><summary>Registered printer queues ({shop.printers.length})</summary>{shop.printers.length?<ul>{shop.printers.map(printer=><li key={printer.id}>{printer.name} · {printer.queueName||'queue not set'} · {printer.status}</li>)}</ul>:<p>No printer queues registered.</p>}</details><details><summary>Print agents ({shop.agents.length})</summary>{shop.agents.length?<ul>{shop.agents.map(agent=><li key={agent.id}>{agent.name} · {agent.mode} · {agent.lastSeenAt?new Date(agent.lastSeenAt).toLocaleString():'not connected yet'}</li>)}</ul>:<p>No agent is enrolled.</p>}</details><p><strong>{shop.isActive?'Active':'Inactive'}</strong></p><p><button onClick={()=>void setShopActive(shop,!shop.isActive)}>{shop.isActive?'Deactivate shop':'Approve / activate shop'}</button></p></article>)}</div>
      <h2>Recent audit log</h2><div className="card">{audit.length?<ul>{audit.map(entry=><li key={entry.id}>{new Date(entry.createdAt).toLocaleString()} · {entry.action} · {entry.targetType} {entry.targetId||''} · {entry.actor?.email||'system'}</li>)}</ul>:'No audit log entries yet.'}</div>
    </>}
    {message&&<p role="status" className="banner">{message}</p>}
  </main>;
}
