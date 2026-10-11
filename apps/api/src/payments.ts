export interface PaymentAdapter { readonly name:string; create(amount:number,reference:string):Promise<{providerRef:string;status:'PENDING'|'PAID'}>; verify(providerRef:string):Promise<boolean> }
export class MockPaymentAdapter implements PaymentAdapter {
  readonly name='mock-development-only';
  async create(_amount:number,reference:string) { return {providerRef:`mock_${reference}`,status:'PENDING' as const}; }
  async verify(providerRef:string) { return providerRef.startsWith('mock_'); }
}
export function getPaymentAdapter():PaymentAdapter {
  if (process.env.NODE_ENV==='production' && (process.env.PAYMENT_MODE || 'mock')==='mock') throw new Error('Mock payments are forbidden in production');
  if ((process.env.PAYMENT_MODE || 'mock')==='mock') return new MockPaymentAdapter();
  throw new Error('No production payment provider is configured');
}
