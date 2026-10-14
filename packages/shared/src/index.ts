export type Role = 'CUSTOMER' | 'SHOP_OWNER' | 'SUPER_ADMIN' | 'AGENT';
export type OrderStatus = 'OPEN' | 'READY_FOR_PICKUP' | 'CANCELLED' | 'PENDING_PAYMENT' | 'PAID' | 'QUEUED' | 'PRINTING' | 'COMPLETED' | 'FAILED';
export type PrintJobMode = 'SIMULATED' | 'REAL';
export type PaperSize = 'A4' | 'A3' | 'LETTER';
export const paperPoints: Record<PaperSize, [number, number]> = { A4:[595.28,841.89], A3:[841.89,1190.55], LETTER:[612,792] };
export function calculatePrice(pages: number, copies: number, pricePerPage: number, color = false, colorSurcharge = 0): number {
  if (![pages,copies,pricePerPage,colorSurcharge].every(Number.isFinite) || pages < 1 || copies < 1 || pricePerPage < 0 || colorSurcharge < 0) throw new Error('Invalid pricing inputs');
  return Math.round((pages * copies * (pricePerPage + (color ? colorSurcharge : 0))) * 100) / 100;
}
export function transitionAllowed(from: OrderStatus, to: OrderStatus): boolean {
  const transitions: Record<OrderStatus, OrderStatus[]> = {
    OPEN:['PAID','READY_FOR_PICKUP','CANCELLED'],
    READY_FOR_PICKUP:[],
    CANCELLED:[],
    PENDING_PAYMENT:['PAID','CANCELLED'],
    PAID:['QUEUED','CANCELLED'],
    QUEUED:['PRINTING','FAILED'],
    PRINTING:['COMPLETED','FAILED'],
    COMPLETED:[],
    FAILED:['QUEUED']
  };
  return (transitions[from] ?? []).includes(to);
}

/**
 * Parses a page range string like "1-5, 8, 11-13" against an optional total page count.
 * Returns sorted unique 1-indexed page numbers.
 */
export function parsePageRange(rangeStr: string, totalPages?: number): number[] {
  const trimmed = rangeStr.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') {
    if (!totalPages || totalPages < 1) return [];
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const parts = trimmed.split(/[,;\s]+/).filter(Boolean);
  const pagesSet = new Set<number>();
  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
        throw new Error(`Invalid page range token: "${part}"`);
      }
      const max = totalPages ? Math.min(end, totalPages) : end;
      for (let p = start; p <= max; p++) {
        pagesSet.add(p);
      }
    } else {
      const page = parseInt(part, 10);
      if (isNaN(page) || page < 1) {
        throw new Error(`Invalid page number: "${part}"`);
      }
      if (!totalPages || page <= totalPages) {
        pagesSet.add(page);
      }
    }
  }
  return Array.from(pagesSet).sort((a, b) => a - b);
}

