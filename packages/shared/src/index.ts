export type Role = 'CUSTOMER' | 'SHOP_OWNER' | 'SUPER_ADMIN' | 'AGENT';
export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'QUEUED' | 'PRINTING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type PrintJobMode = 'SIMULATED' | 'REAL';
export type PaperSize = 'A4' | 'A3' | 'LETTER';
export const paperPoints: Record<PaperSize, [number, number]> = { A4:[595.28,841.89], A3:[841.89,1190.55], LETTER:[612,792] };
export function calculatePrice(pages: number, copies: number, pricePerPage: number, color = false, colorSurcharge = 0): number {
  if (![pages,copies,pricePerPage,colorSurcharge].every(Number.isFinite) || pages < 1 || copies < 1 || pricePerPage < 0 || colorSurcharge < 0) throw new Error('Invalid pricing inputs');
  return Math.round((pages * copies * (pricePerPage + (color ? colorSurcharge : 0))) * 100) / 100;
}
export function transitionAllowed(from: OrderStatus, to: OrderStatus): boolean {
  const transitions: Record<OrderStatus, OrderStatus[]> = { PENDING_PAYMENT:['PAID','CANCELLED'], PAID:['QUEUED','CANCELLED'], QUEUED:['PRINTING','FAILED'], PRINTING:['COMPLETED','FAILED'], COMPLETED:[], FAILED:['QUEUED'], CANCELLED:[] };
  return transitions[from].includes(to);
}
