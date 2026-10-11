import './globals.css';
import type { ReactNode } from 'react';
export const metadata={title:'QR Print Pakistan',description:'Scan a shop QR code, upload a PDF, and prepare a print order.'};
export default function RootLayout({children}:{children:ReactNode}){return <html lang="en"><body><nav className="bar"><div className="brand">QR <span className="tag">Print</span></div><span>Pakistan · Local print shops</span></nav>{children}</body></html>}
