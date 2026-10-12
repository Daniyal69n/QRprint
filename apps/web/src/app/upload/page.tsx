'use client';
import {useEffect,useMemo,useState} from 'react';
import {calculatePrice,type PaperSize} from '@qr-print/shared';
import {apiUrl} from '../../lib/api-url';

type Price={id:string;paperSize:PaperSize;color:boolean;pricePerPage:number;colorSurcharge:number};
type Shop={id:string;name:string;pricing:Price[]};
type ShopPaymentMethod={enabled:boolean;provider:string|null;accountName:string|null;accountNumber:string|null;instructions:string|null};
class ApiRequestError extends Error{
  constructor(message:string,readonly status:number){super(message);this.name='ApiRequestError';}
}

function isExpiredToken(token:string){
  try{
    const payload=token.split('.')[1];
    if(!payload)return true;
    const base64=payload.replace(/-/g,'+').replace(/_/g,'/');
    const claims=JSON.parse(atob(base64.padEnd(Math.ceil(base64.length/4)*4,'='))) as {exp?:unknown};
    return typeof claims.exp!=='number'||claims.exp<=Date.now()/1000;
  }catch{return true;}
}

export default function Upload(){
  const [token,setToken]=useState('');
  const [slug,setSlug]=useState(''),[shop,setShop]=useState<Shop|null>(null),[paper,setPaper]=useState<PaperSize>('A4'),[color,setColor]=useState(false),[copies,setCopies]=useState(1);
  const [file,setFile]=useState<File|null>(null),[documentId,setDocumentId]=useState(''),[pageCount,setPageCount]=useState(0),[previewUrl,setPreviewUrl]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  const [paymentMethod,setPaymentMethod]=useState<ShopPaymentMethod|null>(null),[transferMarked,setTransferMarked]=useState(false),[transferReference,setTransferReference]=useState(''),[submittedOrder,setSubmittedOrder]=useState('');
  const [duplexAvailable,setDuplexAvailable]=useState(false),[doubleSided,setDoubleSided]=useState(false);

  useEffect(()=>{
    const initialSlug=new URLSearchParams(window.location.search).get('shop')||'';
    const savedToken=sessionStorage.getItem('qrprint_guest_token')||'';
    setSlug(initialSlug);setToken(savedToken);
    if(initialSlug)void Promise.all([
      fetch(apiUrl(`/shops/${encodeURIComponent(initialSlug)}`)),
      fetch(apiUrl(`/shops/${encodeURIComponent(initialSlug)}/payment-method`)),
    ]).then(async([shopResponse,paymentResponse])=>{
      const [data,payment]=await Promise.all([shopResponse.json(),paymentResponse.json()]);
      if(!shopResponse.ok)throw new Error(data.error?.message||'Shop is unavailable.');
      if(!paymentResponse.ok)throw new Error(payment.error?.message||'Could not load this shop’s payment details.');
      setShop(data);setPaymentMethod(payment);setMessage(`Loaded prices and payment details for ${data.name}.`);
    }).catch(error=>setMessage((error as Error).message));
  },[]);

  useEffect(()=>{
    if(!shop||!slug)return;
    let current=true;
    void fetch(apiUrl(`/shops/${encodeURIComponent(slug)}/print-options`)).then(async response=>{
      const data=await response.json();
      if(!response.ok)throw new Error(data.error?.message||'Could not load printer capabilities.');
      if(current){setDuplexAvailable(data.supportsDuplex===true);if(data.supportsDuplex!==true)setDoubleSided(false);}
    }).catch(error=>{if(current){setDuplexAvailable(false);setDoubleSided(false);setMessage((error as Error).message);}});
    return()=>{current=false;};
  },[shop?.id,slug]);

  const isDocx = file?.name.toLowerCase().endsWith('.docx') || false;
  const effectivePages = pageCount > 0 ? pageCount : (documentId ? 1 : 0);
  const price=shop?.pricing.find(item=>item.paperSize===paper&&item.color===color);
  const estimate=useMemo(()=>price&&effectivePages?calculatePrice(effectivePages,copies,price.pricePerPage,color,price.colorSurcharge):null,[price,effectivePages,copies,color]);

  async function request(url:string,init:RequestInit={},authToken=token){
    const response=await fetch(apiUrl(url),{...init,headers:{...(init.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(authToken?{Authorization:`Bearer ${authToken}`}:{ }),...init.headers}});
    const data=await response.json();
    if(!response.ok)throw new ApiRequestError(data.error?.message||data.error||`Request failed (${response.status})`,response.status);
    return data;
  }

  function clearUploadedDocument(){
    setDocumentId('');setPageCount(0);
    setPreviewUrl(old=>{if(old)URL.revokeObjectURL(old);return '';});
  }

  async function ensureGuestSession(forceNew=false){
    if(token&&!forceNew&&!isExpiredToken(token))return token;
    if(forceNew||token){
      sessionStorage.removeItem('qrprint_guest_token');setToken('');clearUploadedDocument();
    }
    const session=await request('/auth/guest',{method:'POST',body:JSON.stringify({})},'');
    if(session.role!=='CUSTOMER'||!session.token)throw new Error('Could not start a secure guest order session.');
    sessionStorage.setItem('qrprint_guest_token',session.token);setToken(session.token);
    return session.token as string;
  }

  async function lookup(){
    setBusy(true);setMessage('');
    try{
      const [data,payment]=await Promise.all([request(`/shops/${encodeURIComponent(slug)}`),request(`/shops/${encodeURIComponent(slug)}/payment-method`)]);
      setShop(data);setPaymentMethod(payment);setTransferMarked(false);setSubmittedOrder('');setMessage(`Prices and payment details loaded for ${data.name}.`);
    }catch(error){setShop(null);setPaymentMethod(null);setMessage((error as Error).message);}
    finally{setBusy(false);}
  }

  async function loadPreview(id:string,paperSize:PaperSize,authToken=token){
    const response=await fetch(apiUrl(`/documents/${id}/preview?paperSize=${paperSize}&orientation=AUTO`),{headers:{Authorization:`Bearer ${authToken}`}});
    if(!response.ok){
      let message='Could not render the fitted PDF preview.';
      try{const data=await response.json();message=data.error?.message||data.error||message;}catch{}
      throw new ApiRequestError(message,response.status);
    }
    const blob=await response.blob();
    setPreviewUrl(old=>{if(old)URL.revokeObjectURL(old);return URL.createObjectURL(blob);});
  }

  async function uploadPdf(){
    if(!file||!shop)return;
    setBusy(true);setMessage('');
    const isDocxFile = file.name.toLowerCase().endsWith('.docx');
    try{
      for(let attempt=0;attempt<2;attempt++){
        const authToken=await ensureGuestSession(attempt>0);
        try{
          let data:{id:string;pageCount:number};
          if(process.env.NEXT_PUBLIC_API_URL==='/api'){
            if(file.size>25*1024*1024)throw new Error('File exceeds the 25 MiB limit.');
            const target=await request('/documents/upload-url',{method:'POST',body:JSON.stringify({ext:isDocxFile?'docx':'pdf'})},authToken);
            const cType=isDocxFile?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/pdf';
            const uploaded=await fetch(target.uploadUrl,{method:'PUT',headers:{'Content-Type':cType},body:file});
            if(!uploaded.ok)throw new Error('Private document upload failed; no document was registered.');
            data=await request('/documents/complete',{method:'POST',body:JSON.stringify({id:target.id,storageKey:target.storageKey})},authToken);
          }else{
            const form=new FormData();form.append('file',file);
            data=await request('/documents',{method:'POST',body:form},authToken);
          }
          setDocumentId(data.id);setPageCount(data.pageCount);
          if(isDocxFile){
            setPreviewUrl('');
            setMessage('Word document (.docx) ready to print. Direct printing will be sent to the shop printer queue.');
          }else{
            await loadPreview(data.id,paper,authToken);
            setMessage(`PDF ready: ${data.pageCount} page(s). The fitted preview is shown below.`);
          }
          return;
        }catch(error){
          if(attempt===0&&error instanceof ApiRequestError&&error.status===401)continue;
          throw error;
        }
      }
    }catch(error){setMessage((error as Error).message);}
    finally{setBusy(false);}
  }

  async function placeOrder(){
    if(!shop||!documentId||!token)return;
    if(paymentMethod?.enabled&&!transferMarked){setMessage('First make the transfer using the displayed shop details, then click “I have sent the transfer” before placing your order.');return;}
    setBusy(true);setMessage('');let createdId='';
    try{
      const order=await request('/orders',{method:'POST',body:JSON.stringify({shopId:shop.id,documentId,copies,paperSize:paper,color,doubleSided,idempotencyKey:crypto.randomUUID(),manualTransferSent:paymentMethod?.enabled===true&&transferMarked,transferReference})});
      createdId=order.id;
      if(paymentMethod?.enabled&&transferMarked){
        setSubmittedOrder(order.id);setTransferMarked(false);
        setMessage(`Order ${order.id} placed and sent to the shop printer queue. The shop relies on your transfer confirmation; it is not independently verified.`);
      }else{
        const payment=await request(`/orders/${order.id}/pay`,{method:'POST',body:JSON.stringify({})});
        if(payment.manualPayment)throw new Error('Mark your transfer as sent before placing this order.');
        const verified=await request(`/payments/${payment.id}/verify`,{method:'POST',body:JSON.stringify({})});
        setMessage(`Order ${order.id} recorded. Payment: ${verified.payment.status} via ${payment.provider}.`);
      }
    }catch(error){
      if(error instanceof ApiRequestError&&error.status===401){
        sessionStorage.removeItem('qrprint_guest_token');setToken('');clearUploadedDocument();
        setMessage('Your secure upload session expired. Please upload the document again before placing the order.');
      }else setMessage(`${createdId?`Order ${createdId} was created. `:''}${(error as Error).message}`);
    }
    finally{setBusy(false);}
  }

  return <main className="wrap">
    <div className="eyebrow">Customer flow</div><h1>Prepare your print order</h1>
    <p className="muted">No customer account is needed. Scan the shop QR, upload your PDF or Word document (.docx), choose print options, and review the price.</p>
    {shop&&duplexAvailable&&<section className="card" style={{maxWidth:720,marginBottom:16}}><h2>Print sides</h2><label><input type="checkbox" checked={doubleSided} onChange={event=>setDoubleSided(event.target.checked)}/> Print on both sides of each sheet</label></section>}
    <section className="card" style={{maxWidth:720,marginBottom:16}}>
      <h2>1. Choose a print shop</h2>
      <div className="form"><label>Shop QR code / slug<input value={slug} onChange={event=>setSlug(event.target.value)} placeholder="Scan a shop QR or enter its slug"/></label><button className="btn" onClick={lookup} disabled={busy||!slug}>Load shop prices</button></div>
      {shop&&<p><strong>{shop.name}</strong> · select your print options below</p>}
    </section>
    <section className="card" style={{maxWidth:720,marginBottom:16}}>
      <h2>2. Upload document</h2>
      <div className="form"><label>PDF or Word document (.docx)<input type="file" accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx" onChange={event=>{setFile(event.target.files?.[0]||null);setDocumentId('');setPageCount(0);setPreviewUrl('');setTransferMarked(false);setSubmittedOrder('');}}/></label><button className="btn" onClick={uploadPdf} disabled={busy||!file||!shop}>Upload document</button></div>
      {pageCount>0&&<><p>{pageCount} pages detected. Each output page scales to fit and is centered on the selected paper.</p>{previewUrl&&<iframe title="Fitted document preview" src={previewUrl} style={{width:'100%',height:520,border:'1px solid #cbd7de',borderRadius:8}}/>}</>}
      {documentId&&pageCount===0&&<div style={{padding:'16px',background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:8,marginTop:12}}><p style={{margin:0,fontWeight:600,color:'#166534'}}>Word document (.docx) uploaded and ready for printing.</p><p style={{margin:'4px 0 0',fontSize:14,color:'#15803d'}}>Word documents are sent directly to the printer using native formatting.</p></div>}
    </section>
    {shop&&<section className="card" style={{maxWidth:720}}>
      <h2>3. Copies, paper & price</h2>
      <div className="form"><label>Paper<select value={paper} onChange={async event=>{const size=event.target.value as PaperSize;setPaper(size);setTransferMarked(false);if(documentId&&token&&!isDocx){setBusy(true);try{await loadPreview(documentId,size);}catch(error){setMessage((error as Error).message);}finally{setBusy(false);}}}}><option value="A4">A4</option><option value="A3">A3</option><option value="LETTER">US Letter</option></select></label><label>Copies<input type="number" min="1" max="100" value={copies} onChange={event=>{setCopies(Math.max(1,Number(event.target.value)));setTransferMarked(false);}}/></label><label><input type="checkbox" checked={color} onChange={event=>{setColor(event.target.checked);setTransferMarked(false);}}/> Color</label></div>
      {price?<p>Price per page: Rs {price.pricePerPage}{color&&price.colorSurcharge?` + Rs ${price.colorSurcharge} color surcharge`:''}{estimate!==null&&<strong> · Estimate: Rs {estimate}{pageCount===0?' (1 page min.)':''}</strong>}</p>:<p className="muted">This shop has not configured that paper/color combination.</p>}
      {paymentMethod?.enabled&&estimate!==null&&<section className="card" style={{margin:'12px 0'}}><h3>Pay this shop before placing your order</h3><p>Amount: <strong>Rs {estimate}</strong></p><p>Method: {paymentMethod.provider}</p><p>Account name: <strong>{paymentMethod.accountName}</strong></p><p>Account number: <strong><code>{paymentMethod.accountNumber}</code></strong></p>{paymentMethod.instructions&&<p>{paymentMethod.instructions}</p>}{submittedOrder?<p role="status">Order {submittedOrder} is in the printer queue. The shop relies on your transfer confirmation; it is not independently verified.</p>:<div className="form"><label>Transfer reference (optional)<input value={transferReference} onChange={event=>setTransferReference(event.target.value)} maxLength={120}/></label><button type="button" className="btn" disabled={busy||transferMarked} onClick={()=>{setTransferMarked(true);setMessage('Transfer marked as sent. Place the order to send it directly to the shop printer queue.');}}>{transferMarked?'Transfer marked as sent':'I have sent the transfer'}</button></div>}</section>}
      {paymentMethod?.enabled===false&&process.env.NODE_ENV==='production'&&<p className="muted">This shop has not enabled a payment method, so orders cannot be placed yet.</p>}
      <button className="btn" onClick={placeOrder} disabled={busy||!token||!documentId||!price||submittedOrder!==''||(process.env.NODE_ENV==='production'&&!paymentMethod?.enabled)||(paymentMethod?.enabled&&!transferMarked)}>Place order</button>
    </section>}
    {message&&<p role="status" className="banner">{message}</p>}
    <p className="muted">Uploaded documents are not stored in MongoDB. In Production they are temporarily held in private Blob storage until the shop’s Windows Agent downloads the print job; the local agent spool is encrypted. Manual transfer orders are queued immediately based on the customer’s “I have sent the transfer” confirmation; payment is not independently verified.</p>
  </main>;
}
